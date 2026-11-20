/**
 * Release-aware edge cache (services/cachePurge.ts): when an app's agent
 * registers (a redeploy), its files leave this edge's nginx cache, and the
 * other edges hear of it through MongoDB. scripts/nginx-check-purge.sh checks
 * the same against a real nginx 1.18.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

process.env.BASE_DOMAIN = "public.example.test";
process.env.LEGACY_BASE_DOMAINS = "tunnel.example.test";
process.env.JROK_EDGE_ID = "edge-a";

type Doc = Record<string, any>;
const purgeDocs: Doc[] = [];
const cachePurges = {
  docs: purgeDocs,
  async updateOne(filter: Doc, update: Doc, opts?: { upsert?: boolean }) {
    let doc = purgeDocs.find((d) => d.app === filter.app && d.edge === filter.edge);
    if (!doc && opts?.upsert) { doc = { ...filter }; purgeDocs.push(doc); }
    if (doc) {
      Object.assign(doc, update.$set ?? {});
      for (const k of Object.keys(update.$currentDate ?? {})) doc[k] = new Date();
    }
    return { acknowledged: true };
  },
  find(filter: Doc) {
    let result = purgeDocs.filter((d) =>
      (!filter.at || d.at > filter.at.$gt) && (!filter.edge || d.edge !== filter.edge.$ne)
    ).map((d) => ({ ...d }));
    const cursor = {
      sort: (s: Doc) => { if (s.at === -1) result.sort((a, b) => b.at - a.at); return cursor; },
      limit: (n: number) => { result = result.slice(0, n); return cursor; },
      toArray: async () => result,
    };
    return cursor;
  },
};

const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({ ...realMongo, getCollections: () => ({ cachePurges }) }));
const purge = await import("../src/services/cachePurge");

const root = mkdtempSync(join(tmpdir(), "jrok-cache-purge-"));
let dir = "";
let n = 0;

/** A file laid out as nginx writes one: a binary header, then the key line, then the response. */
function cacheFile(key: string, name = `${(n++).toString(16).padStart(32, "0")}`): string {
  const sub = join(dir, name.slice(-1), name.slice(-3, -1));
  mkdirSync(sub, { recursive: true });
  const header = Buffer.alloc(0x150, 7);
  const body = Buffer.from(`\nKEY: ${key}\nHTTP/1.1 200 OK\r\nContent-Type: application/javascript\r\n\r\nconsole.log(1)\n`);
  const path = join(sub, name);
  writeFileSync(path, Buffer.concat([header, body]));
  return path;
}

beforeEach(() => {
  dir = join(root, `c${n++}`);
  mkdirSync(dir);
  process.env.JROK_CACHE_DIR = dir;
  purge.resetCachePurge();
  purgeDocs.length = 0;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  purge.resetCachePurge();
});

describe("whose file a cache key is", () => {
  test("v3 keys: a tunnel's name under any base domain, or the custom domain", () => {
    expect(purge.appsOfCacheKey("v3https://shop.public.example.test/app.js?v=1")).toEqual(["shop"]);
    expect(purge.appsOfCacheKey("v3https://Shop.tunnel.example.test/x.css")).toEqual(["shop"]);
    expect(purge.appsOfCacheKey("v3https://www.shop.example.com/app.js")).toEqual(["www.shop.example.com"]);
  });

  test("v2 keys had nothing between scheme and host: both readings of http+s… count", () => {
    expect(purge.appsOfCacheKey("v2httpsshop.public.example.test/app.js")).toContain("shop");
    expect(purge.appsOfCacheKey("v2httpsshop.example.com/a.js")).toContain("shop.example.com");
    expect(purge.appsOfCacheKey("v2httpsales.public.example.test/a.js").sort()).toEqual(["ales", "sales"].sort());
  });

  test("jrok's own hosts belong to no app", () => {
    expect(purge.appsOfCacheKey("v3https://public.example.test/x.js")).toEqual([]);
    expect(purge.appsOfCacheKey("v3https://127.0.0.1/x.js")).toEqual([]);
    expect(purge.appsOfCacheKey("garbage")).toEqual([]);
  });
});

describe("purging an edge's cache", () => {
  test("removes every file of the app under every host it has, and nothing else", async () => {
    const shop = [
      cacheFile("v3https://shop.public.example.test/app.js"),
      cacheFile("v3https://shop.tunnel.example.test/app.css"),
      cacheFile("v2httpsshop.public.example.test/old.js"),
    ];
    const others = [
      cacheFile("v3https://shopping.public.example.test/app.js"),
      cacheFile("v3https://shop.example.com/app.js"),
      cacheFile("v3https://public.example.test/app.js"),
    ];
    const temp = join(dir, "a", ".0000000001");
    mkdirSync(join(dir, "a"), { recursive: true });
    writeFileSync(temp, "KEY: v3https://shop.public.example.test/being-written.js\n");

    const result = await purge.purgeApps(["Shop"]);
    expect(result.removed).toBe(3);
    for (const f of shop) expect(existsSync(f)).toBe(false);
    for (const f of others) expect(existsSync(f)).toBe(true);
    expect(existsSync(temp)).toBe(true); // nginx's file in progress is left alone
  });

  test("a custom domain is its own app", async () => {
    const custom = cacheFile("v3https://shop.example.com/app.js");
    const tunnel = cacheFile("v3https://shop.public.example.test/app.js");
    await purge.purgeApps(["shop.example.com"]);
    expect(existsSync(custom)).toBe(false);
    expect(existsSync(tunnel)).toBe(true);
  });

  test("no cache directory, or JROK_CACHE_DIR=off: nothing to do, no error", async () => {
    expect(await purge.purgeApps(["shop"], join(root, "missing"))).toEqual({ scanned: 0, removed: 0 });
    process.env.JROK_CACHE_DIR = "off";
    expect(purge.cacheDir()).toBeNull();
    purge.appReleased("shop");
    expect(purgeDocs).toHaveLength(0);
  });

  test("a scan of 5,000 files takes well under a second", async () => {
    for (let i = 0; i < 5000; i++) cacheFile(`v3https://app${i % 50}.public.example.test/f${i}.js`);
    const started = performance.now();
    const result = await purge.purgeApps(["app7"]);
    expect(result).toEqual({ scanned: 5000, removed: 100 });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("a release", () => {
  test("purges here (coalesced) and tells the other edges once per burst of replicas", async () => {
    const a = cacheFile("v3https://shop.public.example.test/app.js");
    const b = cacheFile("v3https://blog.public.example.test/app.js");
    const now = Date.now();
    purge.appReleased("shop", now);
    purge.appReleased("shop", now + 1000); // second replica
    purge.appReleased("blog", now + 1000);
    expect(existsSync(a)).toBe(true); // not yet: waits for the burst
    await purge.settlePurges();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(purgeDocs.map((d) => `${d.app}@${d.edge}`).sort()).toEqual(["blog@edge-a", "shop@edge-a"]);

    const firstAt = purgeDocs.find((d) => d.app === "shop")!.at;
    await Bun.sleep(5);
    purge.appReleased("shop", now + 20_000); // the next release
    expect(purgeDocs.find((d) => d.app === "shop")!.at.getTime()).toBeGreaterThan(firstAt.getTime());
  });

  test("another edge's release is purged here once, this edge's own never twice", async () => {
    expect(await purge.pollPurges()).toBe(0); // first poll: only where to start

    const shop = cacheFile("v3https://shop.public.example.test/app.js");
    purgeDocs.push({ app: "shop", edge: "edge-b", at: new Date() });
    purgeDocs.push({ app: "blog", edge: "edge-a", at: new Date() }); // ours: purged when it happened
    expect(await purge.pollPurges()).toBe(1);
    await purge.settlePurges();
    expect(existsSync(shop)).toBe(false);

    // Still inside the overlap window on the next poll: not queued again.
    expect(await purge.pollPurges()).toBe(0);

    // Released again on edge-b.
    await Bun.sleep(5);
    purgeDocs.find((d) => d.app === "shop")!.at = new Date();
    expect(await purge.pollPurges()).toBe(1);
  });

  test("files nginx re-caches during a scan are left for the next release", async () => {
    for (let i = 0; i < 200; i++) cacheFile(`v3https://shop.public.example.test/f${i}.js`);
    purge.queuePurge("shop");
    await purge.settlePurges();
    const left = readdirSync(dir, { recursive: true }).filter((f) => String(f).length > 30);
    expect(left).toHaveLength(0);
  });
});
