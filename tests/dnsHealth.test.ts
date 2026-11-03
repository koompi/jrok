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
  leftoverAddresses,
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

  test("a vote about another address for the same id doesn't count (an edge replaced, settings not all updated)", () => {
    const v = verdicts(EDGES, [
      { checker: "b", edge: "c", healthy: true, address: "203.0.113.3" }, // b knows c's new machine
      { checker: "a", edge: "c", healthy: false, address: "192.0.2.3" }, // the old one, stopped
    ]);
    expect(v.get("c")).toBe("down");
    // Votes from checkers older than the address field still count.
    expect(verdicts(EDGES, [{ checker: "a", edge: "c", healthy: false }]).get("c")).toBe("down");
  });
});

describe("what changes in a record", () => {
  const all = EDGES.map((e) => e.address);

  test("a down edge is removed and an up one added", () => {
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "down" }), all)).toEqual({ add: [], remove: ["192.0.2.3"], leftovers: [] });
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "up" }), ["192.0.2.1", "192.0.2.2"])).toEqual({ add: ["192.0.2.3"], remove: [], leftovers: [] });
  });

  test("an unknown edge stays as it is", () => {
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "unknown" }), all)).toEqual({ add: [], remove: [], leftovers: [] });
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "unknown" }), ["192.0.2.1"])).toEqual({ add: ["192.0.2.2"], remove: [], leftovers: [] });
  });

  test("never emptied: if every edge looks down, the record is left alone", () => {
    expect(planRecord(EDGES, verdictMap({ a: "down", b: "down", c: "down" }), all)).toEqual({ add: [], remove: [], leftovers: [] });
  });

  test("addresses that aren't edges are never touched", () => {
    expect(planRecord(EDGES, verdictMap({ a: "up", b: "up", c: "down" }), [...all, "198.51.100.9"])).toEqual({ add: [], remove: ["192.0.2.3"], leftovers: [] });
  });

  test("leftovers are removed, unless every edge looks down", () => {
    const up = verdictMap({ a: "up", b: "up", c: "up" });
    expect(planRecord(EDGES, up, [...all, "198.51.100.9"], ["198.51.100.9"])).toEqual({ add: [], remove: [], leftovers: ["198.51.100.9"] });
    expect(planRecord(EDGES, verdictMap({ a: "down", b: "down", c: "down" }), [...all, "198.51.100.9"], ["198.51.100.9"]).leftovers).toEqual([]);
  });
});

describe("leftover addresses", () => {
  const records = (entries: Array<[string, boolean]>) => entries.map(([content, managed]) => ({ content, managed }));

  test("a checker-added address no edge has is a leftover; a hand-made one, or an edge's, never", () => {
    expect(leftoverAddresses(EDGES, records([["192.0.2.1", true], ["198.51.100.9", true], ["198.51.100.10", false]]), new Set())).toEqual(["198.51.100.9"]);
  });

  test("not while some checker still probes it (its settings are newer: an edge being added)", () => {
    expect(leftoverAddresses(EDGES, records([["198.51.100.9", true]]), new Set(["198.51.100.9"]))).toEqual([]);
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
      records.set(name, [...(records.get(name) ?? []), { id: `r${next++}`, name, type: "A", content: address, managed: true }]);
    },
    async removeRecord(name, id) {
      const gone = records.get(name)?.find((r) => r.id === id);
      changes.push(`${writer} -${gone?.content}`);
      records.set(name, (records.get(name) ?? []).filter((r) => r.id !== id));
    },
  });
  const addresses = (name: string) => (records.get(name) ?? []).map((r) => r.content).sort();
  const seed = (name: string, address: string, managed = false) =>
    records.set(name, [...(records.get(name) ?? []), { id: `r${next++}`, name, type: "A", content: address, managed }]);
  for (const name of ["app.test", "*.app.test"]) for (const e of EDGES) seed(name, e.address);
  return { client, addresses, changes, seed };
}

/** A checker on edge `id`; `down` lists the edges its probes fail to reach. */
function checkerOn(id: string, dns: ReturnType<typeof fakeDns>, down: Set<string>, overrides: Partial<DnsHealthConfig> = {}, notices: string[] = []) {
  const config: DnsHealthConfig = {
    checkerId: id,
    edges: EDGES,
    records: ["app.test", "*.app.test"],
    failAfter: 2,
    recoverAfter: 2,
    maxVoteAgeMs: 60_000,
    leaseMs: 30_000,
    leftoverAfterMs: 60_000,
    dryRun: false,
    ...overrides,
  };
  return new DnsHealthChecker(config, db!, dns.client(id), async (edge) => !down.has(edge.id), () => {},
    (n) => notices.push("edge" in n ? `${n.change} ${n.edge.id} ${n.records.length}` : n.change));
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

  test("a checker without the Cloudflare token votes, and never takes the lease", async () => {
    const dns = fakeDns();
    const unreachable = new Set(["c"]);
    const voter = checkerOn("a", dns, unreachable, { writer: false });
    const writer = checkerOn("b", dns, unreachable);
    await rounds(3, [voter, writer]); // the voter goes first: the lease is free each time
    expect(dns.addresses("app.test")).toEqual(["192.0.2.1", "192.0.2.2"]); // its vote counted
    expect(dns.changes.length).toBeGreaterThan(0);
    expect(dns.changes.every((c) => c.startsWith("b "))).toBe(true);
    const lease = await db!.collection("dnsHealthLease").findOne({ _id: "dns-writer" as any });
    expect(lease?.holder).toBe("b");
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

  test("a person is told once per edge per change, not per record or per cycle", async () => {
    const dns = fakeDns();
    const unreachable = new Set(["c"]);
    const notices: string[] = [];
    const a = checkerOn("a", dns, unreachable, {}, notices);
    const b = checkerOn("b", dns, unreachable, {}, notices);
    await rounds(4, [a, b]);
    unreachable.clear();
    await rounds(4, [a, b]);
    expect(notices).toEqual(["removed c 2", "added c 2"]);
  });

  test("every edge looking down is reported once, and DNS left alone", async () => {
    const dns = fakeDns();
    const unreachable = new Set(["a", "b", "c"]);
    const notices: string[] = [];
    const checkers = ["a", "b", "c"].map((id) => checkerOn(id, dns, unreachable, {}, notices));
    await rounds(4, checkers);
    expect(notices).toEqual(["all-down"]);
    expect(dns.changes).toEqual([]);
  });

  test("an edge replaced by a new machine: its old address leaves, even if a checker added it", async () => {
    const dns = fakeDns();
    const replaced = EDGES.map((e) => (e.id === "c" ? { id: "c", address: "203.0.113.3" } : e));
    // The old machine's address, re-added by a checker; a hand-made record no edge has.
    for (const name of ["app.test", "*.app.test"]) {
      dns.seed(name, "198.51.100.9", true);
      dns.seed(name, "198.51.100.10");
    }
    const settings = { edges: replaced, leftoverAfterMs: 0 };
    await rounds(3, [checkerOn("a", dns, new Set(), settings), checkerOn("b", dns, new Set(), settings)]);
    expect(dns.addresses("app.test")).toEqual(["192.0.2.1", "192.0.2.2", "192.0.2.3", "198.51.100.10", "203.0.113.3"].sort());
    expect(dns.addresses("*.app.test")).toContain("203.0.113.3");
    expect(dns.addresses("*.app.test")).not.toContain("198.51.100.9");
  });

  test("a leftover is removed only once it has been one for leftoverAfterMs", async () => {
    const dns = fakeDns();
    for (const name of ["app.test", "*.app.test"]) dns.seed(name, "198.51.100.9", true);
    const a = checkerOn("a", dns, new Set(), { leftoverAfterMs: 200 });
    const b = checkerOn("b", dns, new Set(), { leftoverAfterMs: 200 });
    await rounds(2, [a, b]);
    expect(dns.addresses("app.test")).toContain("198.51.100.9");
    await Bun.sleep(250);
    await rounds(1, [a, b]);
    expect(dns.addresses("app.test")).not.toContain("198.51.100.9");
    expect(dns.addresses("app.test")).toEqual(["192.0.2.1", "192.0.2.2", "192.0.2.3"]);
  });

  test("a writer with older settings neither re-adds a replaced edge's old address nor removes the new one", async () => {
    const dns = fakeDns();
    const replaced = EDGES.map((e) => (e.id === "c" ? { id: "c", address: "203.0.113.3" } : e));
    // c moved to 203.0.113.3, and its old machine (192.0.2.3) is off: an updated checker added the new address.
    for (const name of ["app.test", "*.app.test"]) dns.seed(name, "203.0.113.3", true);
    const old = checkerOn("a", dns, new Set(["c"])); // still lists c at 192.0.2.3, which it can't reach
    const updated = checkerOn("b", dns, new Set(), { edges: replaced }); // reaches c at its new address
    await rounds(4, [old, updated]); // a, first to cycle, holds the lease, and runs before b has voted
    expect(dns.changes.every((c) => c.startsWith("a "))).toBe(true);
    // b's "c is up" is about 203.0.113.3, so a doesn't put 192.0.2.3 back, and b still probes 203.0.113.3.
    expect(dns.addresses("app.test")).toEqual(["192.0.2.1", "192.0.2.2", "203.0.113.3"]);
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
            { id: "5", type: "A", name: "*.app.example.test", content: "192.0.2.5", comment: "jrok dns-health" },
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
        { id: "1", name: "*.app.example.test", type: "A", content: "192.0.2.1", managed: false },
        { id: "5", name: "*.app.example.test", type: "A", content: "192.0.2.5", managed: true },
      ]);
      await cf.addAddress("*.app.example.test", "192.0.2.2");
      expect(created).toMatchObject({ type: "A", name: "*.app.example.test", content: "192.0.2.2", ttl: 60, proxied: false, comment: "jrok dns-health" });
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
