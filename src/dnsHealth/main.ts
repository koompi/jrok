/**
 * Health-checked DNS (plan Phase 3.1, decision D1: DNS only, no proxy).
 *
 *   bun run src/dnsHealth/main.ts
 *
 * Run one on every edge (Ansible: jrok-dns-health.service, when the inventory
 * sets dns_health_records), and optionally somewhere outside the edges' data
 * centres for a further view. Each probes the other edges as a visitor would
 * (HTTPS to their address, /health) and the one holding the lease takes an
 * edge out of the round-robin records when most checkers see it down, and
 * puts it back when they see it up. See checker.ts and decide.ts.
 *
 * Environment:
 *   MONGODB_URI                  the edges' MongoDB (votes and the writer lease)
 *   DNS_HEALTH_EDGES             id=address,…  every edge, ids as their VPS_ID
 *   DNS_HEALTH_RECORDS           record names to keep healthy, comma-separated
 *   DNS_HEALTH_CHECK_HOST        name for TLS and Host on probes (a base domain)
 *   DNS_HEALTH_CHECKER_ID        default VPS_ID: never probes the edge with that id
 *   CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_TOKEN_FILE (certbot's cloudflare.ini)
 *   DNS_HEALTH_ZONE_ID           optional; else found from the record names
 *   DNS_HEALTH_DRY_RUN=true      log what would change, change nothing
 *   DNS_HEALTH_INTERVAL_MS 10000, DNS_HEALTH_FAIL_AFTER 3, DNS_HEALTH_RECOVER_AFTER 3, DNS_HEALTH_TTL 60
 *   DNS_HEALTH_LEFTOVER_AFTER_S 300: how long an address the checkers added must
 *     belong to no edge, and be probed by no checker, before it is removed
 */
import { MongoClient } from "mongodb";
import { hostname } from "os";
import { parseEdges, type Edge } from "./decide";
import { CloudflareDns, cloudflareToken } from "./cloudflare";
import { DnsHealthChecker } from "./checker";
import { initTelegram, notifyEdgeDns } from "../services/notificationService";
import { DRAIN_HEADER } from "../utils/drain";

const env = process.env;
const number = (name: string, fallback: number) => {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const intervalMs = number("DNS_HEALTH_INTERVAL_MS", 10_000);
const checkHost = (env.DNS_HEALTH_CHECK_HOST || "").trim();
const records = (env.DNS_HEALTH_RECORDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const edges = parseEdges(env.DNS_HEALTH_EDGES);
if (!env.MONGODB_URI || !checkHost || records.length === 0 || edges.length === 0) {
  console.error("[dns-health] Set MONGODB_URI, DNS_HEALTH_EDGES, DNS_HEALTH_RECORDS and DNS_HEALTH_CHECK_HOST");
  process.exit(1);
}

/**
 * /health over HTTPS on the edge's own address, verified as checkHost: what a
 * visitor's connection does. A draining edge (utils/drain.ts) counts as down.
 */
async function probe(edge: Edge): Promise<boolean> {
  const host = edge.address.includes(":") ? `[${edge.address}]` : edge.address;
  try {
    const res = await fetch(`https://${host}/health`, {
      headers: { Host: checkHost },
      tls: { serverName: checkHost },
      keepalive: false, // a fresh connection each time, like a new visitor
      signal: AbortSignal.timeout(5_000),
    } as RequestInit);
    await res.arrayBuffer().catch(() => {});
    return res.status === 200 && !res.headers.has(DRAIN_HEADER);
  } catch {
    return false;
  }
}

// Alerts when an edge leaves or rejoins DNS: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
initTelegram();

const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
await client.connect();

const checker = new DnsHealthChecker(
  {
    checkerId: (env.DNS_HEALTH_CHECKER_ID || env.VPS_ID || hostname()).trim(),
    edges,
    records,
    failAfter: number("DNS_HEALTH_FAIL_AFTER", 3),
    recoverAfter: number("DNS_HEALTH_RECOVER_AFTER", 3),
    maxVoteAgeMs: 6 * intervalMs,
    leaseMs: 3 * intervalMs,
    leftoverAfterMs: number("DNS_HEALTH_LEFTOVER_AFTER_S", 300) * 1000,
    dryRun: env.DNS_HEALTH_DRY_RUN === "true",
  },
  client.db("jrok"),
  new CloudflareDns(cloudflareToken(), { ttl: number("DNS_HEALTH_TTL", 60), zoneId: env.DNS_HEALTH_ZONE_ID }),
  probe,
  undefined,
  (notice) => {
    const detail = "edge" in notice
      ? { edge: notice.edge.id, address: notice.edge.address, records: notice.records }
      : { records: notice.records };
    notifyEdgeDns(notice.change, detail).catch(() => {});
  }
);

console.log(
  `[dns-health] ${edges.length} edges, records ${records.join(", ")}, every ${intervalMs / 1000} s` +
    (env.DNS_HEALTH_DRY_RUN === "true" ? " (dry run)" : "")
);

// One cycle at a time; an error (MongoDB, Cloudflare) skips the cycle and
// changes nothing. Logged at most once a minute while it persists.
let running = false;
let lastError = 0;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await checker.cycle();
  } catch (error: any) {
    if (Date.now() - lastError > 60_000) console.error(`[dns-health] cycle failed: ${error?.message ?? error}`);
    lastError = Date.now();
  } finally {
    running = false;
  }
}, intervalMs);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    clearInterval(timer);
    await checker.release().catch(() => {});
    await client.close().catch(() => {});
    process.exit(0);
  });
}
