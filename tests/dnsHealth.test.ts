/**
 * Health-checked DNS (plan Phase 3.1, src/dnsHealth/): the rules for when an
 * edge leaves and rejoins the round-robin records, several checkers agreeing
 * through MongoDB with one writer, and the Cloudflare calls.
 *
 * The checker tests need a throwaway MongoDB (MONGODB_TEST_URI) and use their
 * own database; they are skipped without one.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  INITIAL_PROBE_STATE,
  nextProbeState,
  parseEdges,
  planRecord,
  verdicts,
  type Edge,
  type Verdict,
} from "../src/dnsHealth/decide";
import { DnsHealthChecker, type DnsClient, type DnsHealthConfig } from "../src/dnsHealth/checker";
import { CloudflareDns, cloudflareToken, type AddressRecord } from "../src/dnsHealth/cloudflare";

const EDGES: Edge[] = [
  { id: "a", address: "192.0.2.1" },
  { id: "b", address: "192.0.2.2" },
  { id: "c", address: "192.0.2.3" },
];
const verdictMap = (entries: Record<string, Verdict>) => new Map(Object.entries(entries));

describe("one checker's view is debounced", () => {
  const rules = { failAfter: 3, recoverAfter: 2 };
  const run = (results: boolean[]) => results.reduce((s, ok) => nextProbeState(s, ok, rules), INITIAL_PROBE_STATE);

  test("down only after three failures in a row", () => {
    expect(run([false, false]).healthy).toBe(true);
    expect(run([false, false, true, false, false]).healthy).toBe(true);
    expect(run([false, false, false]).healthy).toBe(false);
  });

  test("up again after two successes in a row", () => {
    expect(run([false, false, false, true]).healthy).toBe(false);
    expect(run([false, false, false, true, true]).healthy).toBe(true);
  });
});

describe("verdicts", () => {
  test("down when most checkers say so; a tie or a lone dissenter keeps it up", () => {
    const v = verdicts(EDGES, [
      { checker: "a", edge: "c", healthy: false },
      { checker: "b", edge: "c", healthy: false },
      { checker: "a", edge: "b", healthy: false }, // only a sees b down
      { checker: "c", edge: "b", healthy: true },
      { checker: "b", edge: "a", healthy: true },
    ]);
    expect(v.get("c")).toBe("down");
    expect(v.get("b")).toBe("up");
    expect(v.get("a")).toBe("up");
  });

  test("an edge's own checker doesn't count, and no votes means unknown", () => {
    const v = verdicts(EDGES, [{ checker: "a", edge: "a", healthy: false }]);
    expect(v.get("a")).toBe("unknown");
  });
});

describe("what changes in a record", () => {
  const all = EDGES.map((e) => e.address);

  test("a down edge is removed and an up one added", () => {
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "down" }), all)).toEqual({ add: [], remove: ["192.0.2.3"] });
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "up" }), ["192.0.2.1", "192.0.2.2"])).toEqual({ add: ["192.0.2.3"], remove: [] });
  });

  test("an unknown edge stays as it is", () => {
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "unknown" }), all)).toEqual({ add: [], remove: [] });
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "unknown" }), ["192.0.2.1"])).toEqual({ add: ["192.0.2.2"], remove: [] });
  });

  test("never emptied: if every edge looks down, the record is left alone", () => {
    expect(planRecord(EDGES, verdictMap({ a: "down", b: "down", c: "down" }), all)).toEqual({ add: [], remove: [] });
  });

  test("addresses that aren't edges are never touched", () => {
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "down" }), [...all, "198.51.100.9"])).toEqual({ add: [], remove: ["192.0.2.3"] });
  });
});

test("DNS_HEALTH_EDGES: id=address pairs, anything else refused", () => {
  expect(parseEdges("edge1=159.223.71.81, edge2=2001:db8::2")).toEqual([
    { id: "edge1", address: "159.223.71.81" },
    { id: "edge2", address: "2001:db8::2" },
  ]);
  expect(() => parseEdges("edge1=edge1.example.com")).toThrow();
  expect(() => parseEdges("159.223.71.81")).toThrow();
});

// ---------------------------------------------------------------------------
// Checkers agreeing through MongoDB
// ---------------------------------------------------------------------------

const MONGO = process.env.MONGODB_TEST_URI;
const mongo = MONGO ? new MongoClient(MONGO, { serverSelectionTimeoutMS: 3_000 }) : null;
const db = mongo?.db("jrok_dns_health_test");
afterAll(async () => {
  await db?.dropDatabase().catch(() => {});
  await mongo?.close();
});

/** Records in memory; every change remembers which checker made it. */
function fakeDns() {
  let next = 0;
  const records = new Map<string, AddressRecord[]>();
  const changes: string[] = [];
  const client = (writer: string): DnsClient => ({
    async addressRecords(name) { return [...(records.get(name) ?? [])]; },
    async addAddress(name, address) {
      changes.push(`${writer} +${address}`);
      records.set(name, [...(records.get(name) ?? []), { id: `r${next++}`, name, type: "A", content: address }]);
    },
    async removeRecord(name, id) {
      const gone = records.get(name)?.find((r) => r.id === id);
      changes.push(`${writer} -${gone?.content}`);
      records.set(name, (records.get(name) ?? []).filter((r) => r.id !== id));
    },
  });
  const addresses = (name: string) => (records.get(name) ?? []).map((r) => r.content).sort();
  for (const name of ["app.test", "*.app.test"]) for (const e of EDGES) records.set(name, [...(records.get(name) ?? []), { id: `r${next++}`, name, type: "A", content: e.address }]);
  return { client, addresses, changes };
}

/** A checker on edge `id`; `down` lists the edges its probes fail to reach. */
function checkerOn(id: string, dns: ReturnType<typeof fakeDns>, down: Set<string>, overrides: Partial<DnsHealthConfig> = {}) {
  const config: DnsHealthConfig = {
    checkerId: id,
    edges: EDGES,
    records: ["app.test", "*.app.test"],
    failAfter: 2,
    recoverAfter: 2,
    maxVoteAgeMs: 60_000,
    leaseMs: 30_000,
    dryRun: false,
    ...overrides,
  };
  return new DnsHealthChecker(config, db!, dns.client(id), async (edge) => !down.has(edge.id), () => {});
}

async function rounds(n: number, checkers: DnsHealthChecker[]) {
  for (let i = 0; i < n; i++) for (const c of checkers) await c.cycle();
}

describe.skipIf(!MONGO)("checkers agreeing through MongoDB", () => {
  beforeEach(async () => {
    await db!.collection("dnsHealthVotes").deleteMany({});
    await db!.collection("dnsHealthLease").deleteMany({});
  });

  test("an edge every other checker sees down leaves both records, and returns when it's back", async () => {
    const dns = fakeDns();
    const unreachable = new Set(["c"]);
    const a = checkerOn("a", dns, unreachable);
    const b = checkerOn("b", dns, unreachable);

    await rounds(1, [a, b]);
    expect(dns.addresses("app.test")).toHaveLength(3); // one failure isn't enough
    // Two failures each; the writer acts on the other checker's vote a cycle later at most.
    await rounds(2, [a, b]);
    expect(dns.addresses("app.test")).toEqual(["192.0.2.1", "192.0.2.2"]);
    expect(dns.addresses("*.app.test")).toEqual(["192.0.2.1", "192.0.2.2"]);

    unreachable.clear();
    await rounds(3, [a, b]);
    expect(dns.addresses("app.test")).toEqual(["192.0.2.1", "192.0.2.2", "192.0.2.3"]);
  });

  test("only the lease holder changes DNS", async () => {
    const dns = fakeDns();
    const unreachable = new Set(["c"]);
    await rounds(3, [checkerOn("a", dns, unreachable), checkerOn("b", dns, unreachable)]);
    expect(dns.changes.length).toBeGreaterThan(0);
    const writers = new Set(dns.changes.map((c) => c.split(" ")[0]));
    expect(writers.size).toBe(1);
  });

  test("one checker on a bad path can't remove a healthy edge", async () => {
    const dns = fakeDns();
    const a = checkerOn("a", dns, new Set(["c"])); // a can't reach c
    const b = checkerOn("b", dns, new Set()); // b can
    await rounds(3, [a, b]);
    expect(dns.addresses("app.test")).toHaveLength(3);
    expect(dns.changes).toEqual([]);
  });

  test("when the writer stops, another checker takes over", async () => {
    const dns = fakeDns();
    const unreachable = new Set<string>();
    const a = checkerOn("a", dns, unreachable);
    const b = checkerOn("b", dns, unreachable);
    await rounds(1, [a, b]); // a takes the lease
    await a.release(); // a stops: lease released, its votes withdrawn

    unreachable.add("c");
    await rounds(2, [b]); // only b runs now
    expect(dns.addresses("app.test")).toEqual(["192.0.2.1", "192.0.2.2"]);
    expect(dns.changes.every((c) => c.startsWith("b "))).toBe(true);
  });

  test("dry run changes nothing", async () => {
    const dns = fakeDns();
    const unreachable = new Set(["c"]);
    await rounds(3, [checkerOn("a", dns, unreachable, { dryRun: true }), checkerOn("b", dns, unreachable, { dryRun: true })]);
    expect(dns.changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cloudflare calls
// ---------------------------------------------------------------------------

describe("Cloudflare DNS", () => {
  test("finds the zone, lists exact names only, creates DNS-only records, deletes by id", async () => {
    const calls: string[] = [];
    let created: any = null;
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        calls.push(`${req.method} ${url.pathname}${url.search}`);
        const ok = (result: unknown) => Response.json({ success: true, result });
        if (url.pathname === "/zones") return ok(url.searchParams.get("name") === "example.test" ? [{ id: "z1" }] : []);
        if (req.method === "GET" && url.pathname === "/zones/z1/dns_records") {
          return ok([
            { id: "1", type: "A", name: "*.app.example.test", content: "192.0.2.1" },
            { id: "2", type: "TXT", name: "*.app.example.test", content: "x" },
            { id: "3", type: "A", name: "other.example.test", content: "192.0.2.9" },
          ]);
        }
        if (req.method === "POST") { created = await req.json(); return ok({ id: "4" }); }
        if (req.method === "DELETE") return ok({ id: "1" });
        return new Response("no", { status: 404 });
      },
    });
    try {
      const cf = new CloudflareDns("token", { apiBase: `http://127.0.0.1:${api.port}`, ttl: 60 });
      expect(await cf.addressRecords("*.app.example.test")).toEqual([
        { id: "1", name: "*.app.example.test", type: "A", content: "192.0.2.1" },
      ]);
      await cf.addAddress("*.app.example.test", "192.0.2.2");
      expect(created).toMatchObject({ type: "A", name: "*.app.example.test", content: "192.0.2.2", ttl: 60, proxied: false });
      await cf.removeRecord("*.app.example.test", "1");
      expect(calls).toContain("DELETE /zones/z1/dns_records/1");
      // The zone was looked up once, from the longest name it ends with.
      expect(calls.filter((c) => c.startsWith("GET /zones?"))).toEqual([
        "GET /zones?name=app.example.test",
        "GET /zones?name=example.test",
      ]);
    } finally {
      api.stop(true);
    }
  });

  test("the token can come from certbot's credentials file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-"));
    const file = join(dir, "cloudflare.ini");
    writeFileSync(file, "# Cloudflare API Token\ndns_cloudflare_api_token = abc123\n");
    expect(cloudflareToken({ CLOUDFLARE_API_TOKEN_FILE: file })).toBe("abc123");
    expect(() => cloudflareToken({})).toThrow();
  });
});
