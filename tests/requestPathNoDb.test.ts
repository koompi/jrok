/**
 * The request path for grouped domains — every kconsole HTTP tunnel — must not
 * wait on MongoDB. selectAgent used to read the group, its healthy members and
 * the chosen agent's record on every request (plus a round-robin write on most
 * of them), and every agent heartbeat was its own write.
 *
 * Agents are registered through the real registerAgent against an in-memory
 * stand-in for the collections that counts every call, so these tests assert
 * on what would actually have reached the database.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

type Doc = Record<string, any>;
const ops: string[] = [];

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && "$in" in cond) return cond.$in.includes(doc[key]);
    return doc[key] === cond;
  });
}

function applyUpdate(doc: Doc, update: Doc): void {
  Object.assign(doc, update.$set ?? {});
  for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + (v as number);
  for (const [k, v] of Object.entries(update.$addToSet ?? {})) {
    doc[k] = doc[k] ?? [];
    if (!doc[k].includes(v)) doc[k].push(v);
  }
  for (const [k, v] of Object.entries(update.$pull ?? {})) doc[k] = (doc[k] ?? []).filter((x: any) => x !== v);
}

function fakeCollection(name: string) {
  const docs: Doc[] = [];
  const log = (op: string) => ops.push(`${name}.${op}`);
  return {
    docs,
    async findOne(filter: Doc) { log("findOne"); return docs.find((d) => matches(d, filter)) ?? null; },
    find(filter: Doc) {
      log("find");
      const result = docs.filter((d) => matches(d, filter));
      const cursor = { sort: () => cursor, toArray: async () => result };
      return cursor;
    },
    async insertOne(doc: Doc) { log("insertOne"); docs.push({ ...doc }); return { acknowledged: true }; },
    async updateOne(filter: Doc, update: Doc, opts?: { upsert?: boolean }) {
      log("updateOne");
      let doc = docs.find((d) => matches(d, filter));
      if (!doc && opts?.upsert) { doc = { ...filter }; docs.push(doc); }
      if (doc) applyUpdate(doc, update);
      return { acknowledged: true };
    },
    async updateMany(filter: Doc, update: Doc) {
      log("updateMany");
      const hit = docs.filter((d) => matches(d, filter));
      hit.forEach((d) => applyUpdate(d, update));
      return { acknowledged: true, modifiedCount: hit.length, filter };
    },
    async findOneAndUpdate(filter: Doc, update: Doc) {
      log("findOneAndUpdate");
      const doc = docs.find((d) => matches(d, filter));
      if (doc) applyUpdate(doc, update);
      return doc ?? null;
    },
    async deleteOne(filter: Doc) {
      log("deleteOne");
      const i = docs.findIndex((d) => matches(d, filter));
      if (i >= 0) docs.splice(i, 1);
      return { acknowledged: true };
    },
  };
}

const collections = new Map<string, ReturnType<typeof fakeCollection>>();
const fakeCollections = new Proxy({}, {
  get: (_t, name: string) => {
    if (!collections.has(name)) collections.set(name, fakeCollection(name));
    return collections.get(name);
  },
});

const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({
  ...realMongo,
  getCollections: () => fakeCollections,
}));

const agentService = await import("../src/services/agentService");
const agentGroupService = await import("../src/services/agentGroupService");

const openSocket = () => ({ readyState: 1, send: () => 1, close: () => {} }) as any;

async function registerReplica(domain: string, instanceId: string) {
  const { agent } = await agentService.registerAgent({
    socket: openSocket(),
    domain,
    localPort: 3000,
    localHost: "127.0.0.1",
    groupMode: true,
    instanceId,
  });
  return agent;
}

// registerAgent starts tunnel creation in the background; let it finish so
// its writes don't land inside a measured window.
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  ops.length = 0;
});

describe("grouped request path", () => {
  test("selectAgent spreads requests over local replicas without touching MongoDB", async () => {
    const a = await registerReplica("rr-app", "rr-1");
    const b = await registerReplica("rr-app", "rr-2");
    await settle();

    await agentGroupService.selectAgent("rr-app"); // loads the group document once
    ops.length = 0;

    const picked: string[] = [];
    for (let i = 0; i < 6; i++) {
      picked.push((await agentGroupService.selectAgent("rr-app"))!.id);
    }

    expect(ops).toEqual([]);
    expect(new Set(picked)).toEqual(new Set([a.id, b.id]));
    expect(picked.filter((id) => id === a.id).length).toBe(3);
  });

  test("a single replica needs no write per request", async () => {
    await registerReplica("solo-app", "solo-1");
    await settle();
    await agentGroupService.selectAgent("solo-app");
    ops.length = 0;

    for (let i = 0; i < 20; i++) await agentGroupService.selectAgent("solo-app");

    expect(ops).toEqual([]);
  });

  test("least-connections still balances on the stored counters", async () => {
    const agent = await registerReplica("lc-app", "lc-1");
    await settle();
    const group = collections.get("agentGroups")!.docs.find((g) => g.domain === "lc-app")!;
    await agentGroupService.updateGroupStrategy(group.id, "least-connections");
    ops.length = 0;

    const chosen = await agentGroupService.selectAgent("lc-app");

    expect(chosen?.id).toBe(agent.id);
    expect(ops).toContain("agentGroupMembers.find");
  });

  test("a replica leaving keeps the domain served locally by the others", async () => {
    const a = await registerReplica("leave-app", "leave-1");
    const b = await registerReplica("leave-app", "leave-2");
    await settle();
    expect(agentService.getAgentByDomainLocal("leave-app")?.id).toBe(b.id);

    await agentService.unregisterAgent(b.id);

    expect(agentService.getAgentByDomainLocal("leave-app")?.id).toBe(a.id);
    expect(agentService.getLocalAgentsForDomain("leave-app").map((x) => x.id)).toEqual([a.id]);

    await agentService.unregisterAgent(a.id);
    expect(agentService.getAgentByDomainLocal("leave-app")).toBeNull();
    expect(agentService.getLocalAgentsForDomain("leave-app")).toEqual([]);
  });

  test("replicas whose socket is not open are skipped", async () => {
    const a = await registerReplica("closed-app", "closed-1");
    const b = await registerReplica("closed-app", "closed-2");
    await settle();
    (agentService.getAgentSocket(a.id) as any).readyState = 3; // CLOSED

    expect(agentService.getLocalAgentsForDomain("closed-app").map((x) => x.id)).toEqual([b.id]);
  });
});

describe("agent heartbeats", () => {
  test("are batched into one write per flush", async () => {
    const a = await registerReplica("hb-app", "hb-1");
    const b = await registerReplica("hb-app", "hb-2");
    await settle();
    ops.length = 0;

    for (let i = 0; i < 3; i++) {
      await agentService.updateHeartbeat(a.id);
      await agentService.updateHeartbeat(b.id);
    }
    expect(ops).toEqual([]);

    await agentService.flushHeartbeats();
    expect(ops).toEqual(["agentConnections.updateMany"]);

    const records = collections.get("agentConnections")!.docs.filter((d) => d.domain === "hb-app");
    expect(records.every((d) => d.lastHeartbeat instanceof Date)).toBe(true);

    ops.length = 0;
    await agentService.flushHeartbeats(); // nothing pending
    expect(ops).toEqual([]);
  });

  test("a disconnected agent is not written on the next flush", async () => {
    const a = await registerReplica("hb2-app", "hb2-1");
    await settle();
    await agentService.updateHeartbeat(a.id);
    await agentService.unregisterAgent(a.id);
    ops.length = 0;

    await agentService.flushHeartbeats();

    expect(ops).toEqual([]);
  });
});
