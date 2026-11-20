/**
 * Release-aware edge cache: an app's files leave every edge's cache when its
 * new release connects.
 *
 * nginx keeps what an app marks shareable, and its unmarked scripts, styles,
 * fonts and wasm (nginx role, proxy_cache). A redeploy restarts the app's agent
 * (KOOMPI Cloud's deploy worker stops the old tunnel and starts one to the new
 * container), so an agent registering for an app is the release signal. A
 * reconnect without a release only costs some cache misses.
 *
 * Each cache file holds its key ("KEY: v3https://shop.koompi.app/app.js") in its
 * header; a purge scans the files and unlinks the app's. nginx takes a missing
 * file for a miss and fetches it again; no reload. Every process of an edge
 * shares one cache, and any of them may unlink.
 *
 * Other edges cache the app too (they forward to the edge holding its agent),
 * so each registration is also written to `cachePurges`, and every edge's
 * process 0 reads the others' every POLL_MS.
 *
 *   JROK_CACHE_DIR   the proxy_cache_path (default /var/cache/nginx/jrok; "off": no purges)
 */
import { readdir, open, unlink } from "fs/promises";
import { join } from "path";
import { getCollections } from "../utils/mongodb";
import { classifyHost, normalizeHostname } from "../utils/hostRouting";
import { edgeId } from "../utils/processRole";

const COALESCE_MS = 2_000;
const POLL_MS = 5_000;
// Re-read a little before the last purge seen: two inserts can commit out of order.
const OVERLAP_MS = 2_000;
// One announcement per app per process in this window: replicas register one after another.
const ANNOUNCE_EVERY_MS = 10_000;
const SCAN_CONCURRENCY = 32;
const HEADER_BYTES = 4096;

export function cacheDir(): string | null {
  const dir = (process.env.JROK_CACHE_DIR ?? "/var/cache/nginx/jrok").trim();
  return !dir || dir === "off" ? null : dir;
}

/** The app a cache key belongs to: a tunnel name ("shop") or a custom domain. Keys v2 had no "://", so both readings count. */
export function appsOfCacheKey(key: string): string[] {
  const hosts: string[] = [];
  const v3 = /^v\d+(?:https?):\/\/([^/?#]+)/.exec(key);
  if (v3?.[1]) hosts.push(v3[1]);
  else {
    const old = /^v\d+(https|http)([^/?#]*)/.exec(key);
    const scheme = old?.[1];
    const host = old?.[2];
    if (host) {
      hosts.push(host);
      // "v2https" + "ales…" may also be "v2http" + "sales…".
      if (scheme === "https") hosts.push(`s${host}`);
    }
  }
  const apps: string[] = [];
  for (const raw of hosts) {
    const host = normalizeHostname(raw);
    if (!host) continue;
    const route = classifyHost(host);
    if (route.kind === "tunnel") apps.push(route.name.toLowerCase());
    else if (route.kind === "custom-candidate") apps.push(host);
  }
  return apps;
}

/** The key in a cache file's header, or null (not a cache file, or unreadable). */
async function readKey(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0);
    const head = buf.subarray(0, bytesRead);
    const at = head.indexOf("\nKEY: ");
    if (at === -1) return null;
    const end = head.indexOf("\n", at + 6);
    return head.subarray(at + 6, end === -1 ? head.length : end).toString("latin1");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function cacheFiles(dir: string): Promise<string[]> {
  // levels=1:2 -> dir/a/bc/<md5>; names starting with "." are nginx's temporary files.
  const files: string[] = [];
  const walk = async (path: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (entry.isFile()) files.push(full);
    }
  };
  await walk(dir, 0);
  return files;
}

/** Unlink every cached file of these apps. Returns how many files were looked at and removed. */
export async function purgeApps(apps: Iterable<string>, dir = cacheDir()): Promise<{ scanned: number; removed: number }> {
  const wanted = new Set([...apps].map((a) => a.trim().toLowerCase()).filter(Boolean));
  if (!dir || wanted.size === 0) return { scanned: 0, removed: 0 };
  const files = await cacheFiles(dir);
  let removed = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++]!;
      const key = await readKey(file);
      if (!key || !appsOfCacheKey(key).some((app) => wanted.has(app))) continue;
      try {
        await unlink(file);
        removed++;
      } catch {
        // Gone already (nginx evicted it, or another process purged it).
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return { scanned: files.length, removed };
}

// Apps waiting for the next scan, and the scan running now.
const queued = new Set<string>();
let timer: Timer | null = null;
let running: Promise<void> | null = null;

function schedule(): void {
  if (timer || running) return;
  timer = setTimeout(runQueued, COALESCE_MS);
  timer.unref?.();
}

async function runQueued(): Promise<void> {
  timer = null;
  if (queued.size === 0) return;
  const apps = [...queued];
  queued.clear();
  const started = Date.now();
  running = purgeApps(apps)
    .then(({ scanned, removed }) => {
      if (removed > 0) console.log(`🧹 Edge cache: ${removed} of ${scanned} file(s) removed for ${apps.length} app(s) in ${Date.now() - started} ms`);
    })
    .catch((error) => console.error("⚠️ Edge cache purge failed:", error?.message || error));
  await running;
  running = null;
  if (queued.size > 0) schedule();
}

/** Purge this app on this edge within COALESCE_MS. */
export function queuePurge(app: string): void {
  if (!cacheDir()) return;
  queued.add(app.trim().toLowerCase());
  schedule();
}

const announced = new Map<string, number>();

/**
 * An agent registered for `app`: purge it here, and tell the other edges.
 * Never throws; a lost announcement leaves the other edges' copies to expire.
 */
export function appReleased(app: string, now = Date.now()): void {
  const name = app.trim().toLowerCase();
  if (!name || !cacheDir()) return;
  queuePurge(name);
  if ((announced.get(name) ?? 0) > now - ANNOUNCE_EVERY_MS) return;
  announced.set(name, now);
  if (announced.size > 10_000) {
    for (const [key, at] of announced) if (at <= now - ANNOUNCE_EVERY_MS) announced.delete(key);
  }
  try {
    getCollections()
      .cachePurges.updateOne(
        { app: name, edge: edgeId() },
        { $set: { app: name, edge: edgeId() }, $currentDate: { at: true } },
        { upsert: true }
      )
      .catch((error: any) => console.error(`⚠️ Edge cache purge of ${name} not sent to the other edges:`, error?.message || error));
  } catch {
    // MongoDB not connected (tests, startup).
  }
}

let lastSeen: Date | null = null;
let pollTimer: Timer | null = null;
let polling = false;
// `${app}|${edge}` -> the announcement time already queued, so the overlap doesn't purge twice.
const applied = new Map<string, number>();

/** Queue the purges other edges announced since the last poll. The first poll only notes where to start. */
export async function pollPurges(): Promise<number> {
  const purges = getCollections().cachePurges;
  if (!lastSeen) {
    const newest = await purges.find({}, { projection: { at: 1 } }).sort({ at: -1 }).limit(1).toArray();
    lastSeen = newest[0]?.at instanceof Date ? newest[0].at : new Date(0);
    return 0;
  }
  const from = lastSeen.getTime() - OVERLAP_MS;
  const docs = await purges
    .find({ at: { $gt: new Date(from) }, edge: { $ne: edgeId() } }, { projection: { app: 1, edge: 1, at: 1 } })
    .toArray();
  let count = 0;
  for (const doc of docs) {
    if (typeof doc.app !== "string" || !(doc.at instanceof Date)) continue;
    if (doc.at > lastSeen) lastSeen = doc.at;
    const id = `${doc.app}|${doc.edge}`;
    if (applied.get(id) === doc.at.getTime()) continue;
    applied.set(id, doc.at.getTime());
    queuePurge(doc.app);
    count++;
  }
  for (const [id, at] of applied) if (at <= from) applied.delete(id);
  return count;
}

/** Process 0 of each edge: follow the other edges' purges. */
export function startCachePurgeSync(): void {
  if (!cacheDir() || pollTimer) return;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      await pollPurges();
    } catch {
      // The next poll catches up (OVERLAP_MS back from the last purge seen).
    } finally {
      polling = false;
    }
  };
  void tick();
  pollTimer = setInterval(tick, POLL_MS);
  pollTimer.unref?.();
}

export function stopCachePurgeSync(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** For tests. */
export async function settlePurges(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    await runQueued();
  }
  if (running) await running;
}

export function resetCachePurge(): void {
  queued.clear();
  announced.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  lastSeen = null;
  applied.clear();
  stopCachePurgeSync();
}
