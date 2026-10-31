/**
 * Security rules set through one server must hold on every server (P4, P5 in
 * docs/plans/jrok-scale-out-plan.md). On staging, an allowlist set through one
 * edge was enforced nowhere: the edge holding the agent never heard of it.
 *
 * One process can only be one server, so "another server" here is this one
 * after resetSecuritySync() and with its in-memory rules wiped: it learns
 * everything back from the shared (in-memory stand-in) MongoDB, exactly as a
 * peer would.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

type Doc = Record<string, any>;
let mongoDown = false;

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return (cond as Doc[]).some((f) => matches(doc, f));
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$exists" in cond) return (doc[key] !== undefined) === cond.$exists;
      if ("$gt" in cond) return doc[key] !== undefined && doc[key] > cond.$gt;
    }
    return doc[key] === cond;
  });
}

function fakeCollection() {
  const docs: Doc[] = [];
  const check = () => { if (mongoDown) throw new Error("Server selection timed out after 10000 ms"); };
  return {
    docs,
    async findOne(filter: Doc) { check(); return docs.find((d) => matches(d, filter)) ?? null; },
    find(filter: Doc) {
      check();
      const result = docs.filter((d) => matches(d, filter)).map((d) => ({ ...d }));
      return { toArray: async () => result };
    },
    async updateOne(filter: Doc, update: Doc, opts?: { upsert?: boolean }) {
      check();
      let doc = docs.find((d) => matches(d, filter));
      if (!doc && opts?.upsert) { doc = { ...filter }; docs.push(doc); }
      if (doc) {
        Object.assign(doc, update.$set ?? {});
        for (const k of Object.keys(update.$currentDate ?? {})) doc[k] = new Date();
      }
      return { acknowledged: true };
    },
  };
}

const collections = new Map<string, ReturnType<typeof fakeCollection>>();
const fakeCollections = new Proxy({}, {
  get: (_t, name: string) => {
    if (!collections.has(name)) collections.set(name, fakeCollection());
    return collections.get(name);
  },
});

const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({ ...realMongo, getCollections: () => fakeCollections }));

const securityService = await import("../src/services/securityService");
const securitySync = await import("../src/services/securitySync");

const tunnels = () => (fakeCollections as any).tunnels as ReturnType<typeof fakeCollection>;

/** Wipe this server's in-memory rules, as a different server that never saw the API call. */
function becomeAnotherServer() {
  for (const ip of securityService.getBlockedIps().map((b) => b.ip)) securityService.unblockIp(ip);
  const { organizations, domains } = securityService.getSuspensions();
  organizations.forEach((o) => securityService.unsuspendOrganization(o.organizationId));
  domains.forEach((d) => securityService.unsuspendDomain(d.domain));
  for (const t of tunnels().docs) {
    securityService.applyTunnelIpSecurity({ id: t.id, domain: t.domain, ipSecurity: { mode: "allow-all" } });
  }
  securitySync.resetSecuritySync();
}

beforeEach(() => {
  mongoDown = false;
});

describe("per-tunnel IP rules", () => {
  test("an allowlist set through one server is enforced on another after a sync", async () => {
    tunnels().docs.push({ id: "t-allow", domain: "allow-app" });
    await securityService.setTunnelIpSecurity("t-allow", { mode: "allowlist", allowedIps: ["203.0.113.1"], blockedIps: [] });

    becomeAnotherServer();
    expect(securityService.checkIpSecurity("t-allow", "198.51.100.7").allowed).toBe(true); // not known yet

    await securitySync.syncSecurityRules();

    expect(securityService.checkIpSecurity("t-allow", "198.51.100.7").allowed).toBe(false);
    expect(securityService.checkIpSecurity("t-allow", "203.0.113.1").allowed).toBe(true);
    // Requests are checked by domain when the agent doesn't know its tunnel id.
    expect(securityService.checkIpSecurity("allow-app", "198.51.100.7").allowed).toBe(false);

    // Refused as forbidden (403), not as a rate limit (429).
    const check = await securityService.checkHttpRequest("t-allow", undefined, "198.51.100.7", "free");
    expect(check).toMatchObject({ allowed: false, status: 403 });
  });

  test("a later change replaces the earlier one everywhere", async () => {
    tunnels().docs.push({ id: "t-change", domain: "change-app" });
    await securityService.setTunnelIpSecurity("t-change", { mode: "blocklist", allowedIps: [], blockedIps: ["198.51.100.9"] });
    await securitySync.syncSecurityRules();
    expect(securityService.checkIpSecurity("t-change", "198.51.100.9").allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 5)); // a later MongoDB timestamp
    await securityService.setTunnelIpSecurity("t-change", { mode: "allow-all", allowedIps: [], blockedIps: [] });
    becomeAnotherServer();
    await securitySync.syncSecurityRules();
    expect(securityService.checkIpSecurity("t-change", "198.51.100.9").allowed).toBe(true);
  });
});

describe("admin IP blocks and suspensions", () => {
  test("an IP blocked through one server is blocked on another after a sync", async () => {
    await securitySync.setRule("block-ip", "192.0.2.50", true, { reason: "abuse report", durationSeconds: 600 });
    expect(securityService.isIpBlocked("192.0.2.50")).toBe(true); // at once, here

    becomeAnotherServer();
    expect(securityService.isIpBlocked("192.0.2.50")).toBe(false);
    await securitySync.syncSecurityRules();
    expect(securityService.isIpBlocked("192.0.2.50")).toBe(true);

    await securitySync.setRule("block-ip", "192.0.2.50", false);
    becomeAnotherServer();
    await securitySync.syncSecurityRules();
    expect(securityService.isIpBlocked("192.0.2.50")).toBe(false);
  });

  test("an expired block is not applied", async () => {
    await securitySync.setRule("block-ip", "192.0.2.60", true, { durationSeconds: -1 });
    becomeAnotherServer();
    await securitySync.syncSecurityRules();
    expect(securityService.isIpBlocked("192.0.2.60")).toBe(false);
  });

  test("suspensions reach every server, and so does lifting them", async () => {
    await securitySync.setRule("suspend-org", "org-unpaid", true, { reason: "Unpaid" });
    await securitySync.setRule("suspend-domain", "spam-app", true, { reason: "Abuse" });
    becomeAnotherServer();
    await securitySync.syncSecurityRules();
    expect(securityService.checkSuspension("org-unpaid")).toEqual({ suspended: true, reason: "Unpaid" });
    expect(securityService.checkSuspension(undefined, "spam-app").suspended).toBe(true);

    await securitySync.setRule("suspend-org", "org-unpaid", false);
    becomeAnotherServer();
    await securitySync.syncSecurityRules();
    expect(securityService.checkSuspension("org-unpaid").suspended).toBe(false);
  });

  test("a rule MongoDB can't save throws, but still holds on this server", async () => {
    mongoDown = true;
    await expect(securitySync.setRule("block-ip", "192.0.2.70", true)).rejects.toThrow();
    expect(securityService.isIpBlocked("192.0.2.70")).toBe(true);
  });

  test("a sync while MongoDB is down keeps the rules already loaded", async () => {
    await securitySync.setRule("suspend-domain", "kept-app", true, { reason: "Abuse" });
    await securitySync.syncSecurityRules();
    mongoDown = true;
    await expect(securitySync.syncSecurityRules()).rejects.toThrow();
    expect(securityService.checkSuspension(undefined, "kept-app").suspended).toBe(true);
  });
});
