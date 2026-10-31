/**
 * Which customer domains will follow health-checked DNS (plan Phase 3.2)?
 * Read-only: reads the active custom domains from MongoDB and asks public DNS
 * how each one reaches us.
 *
 *   MONGODB_URI=… bun scripts/custom-domain-dns-audit.ts EDGE_IP [EDGE_IP…]
 *
 * EDGE_IP: every edge's public address. Each domain is reported as
 *   follows   CNAME to a name of ours, which health-checked DNS keeps healthy
 *   all       A records for every edge (likely a flattened CNAME/ALIAS; fine)
 *   pinned    A records for some edges only: an edge going down takes it down
 *             too. Ask the customer for a CNAME (or ALIAS at the apex).
 *   elsewhere doesn't reach any edge
 *   no-dns    doesn't resolve
 * Run before relying on failover (plan section 6, risks).
 */
import { MongoClient } from "mongodb";
import { Resolver } from "dns/promises";

const edges = process.argv.slice(2);
if (!process.env.MONGODB_URI || edges.length === 0) {
  console.error("usage: MONGODB_URI=… bun scripts/custom-domain-dns-audit.ts EDGE_IP [EDGE_IP…]");
  process.exit(2);
}

const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

async function classify(domain: string, cnameTarget?: string): Promise<{ verdict: string; detail: string }> {
  const cname = await resolver.resolveCname(domain).catch(() => [] as string[]);
  const addresses = await resolver.resolve4(domain).catch(() => [] as string[]);
  if (cname.length > 0 && cnameTarget && cname.some((c) => c.toLowerCase() === cnameTarget.toLowerCase())) {
    return { verdict: "follows", detail: `CNAME ${cname.join(", ")}` };
  }
  if (addresses.length === 0) return { verdict: "no-dns", detail: cname.length ? `CNAME ${cname.join(", ")}` : "" };
  const ours = addresses.filter((a) => edges.includes(a));
  if (ours.length === 0) return { verdict: "elsewhere", detail: addresses.join(", ") };
  if (cname.length > 0) return { verdict: "follows", detail: `CNAME ${cname.join(", ")}` };
  if (edges.every((e) => addresses.includes(e))) return { verdict: "all", detail: addresses.join(", ") };
  return { verdict: "pinned", detail: addresses.join(", ") };
}

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
await client.connect();
try {
  const domains = await client
    .db("jrok")
    .collection("customDomains")
    .find({ active: { $ne: false } }, { projection: { domain: 1, cnameTarget: 1 } })
    .toArray();
  const counts: Record<string, number> = {};
  for (const d of domains) {
    const { verdict, detail } = await classify(d.domain, d.cnameTarget);
    counts[verdict] = (counts[verdict] ?? 0) + 1;
    console.log(`${verdict.padEnd(9)} ${d.domain.padEnd(40)} ${detail}`);
  }
  console.log(`\n${domains.length} domains: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
} finally {
  await client.close();
}
