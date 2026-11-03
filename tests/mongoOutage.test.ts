/**
 * Traffic that is already flowing must survive MongoDB going away (goal 3 and
 * P8 in docs/plans/jrok-scale-out-plan.md). On staging, blocking MongoDB on the
 * edge holding an agent took the app down through both edges: once a 30–60 s
 * cache expired, every request waited 10 s for MongoDB and got a 500.
 *
 * MongoDB here is an in-memory stand-in that can be switched off; while it is
 * off every call throws, the way the driver does after its server-selection
 * timeout. Also covers the cached route to other servers (P14) and the one-hop
 * rule (P9).
 */
import { describe, test, expect, beforeEach, afterEach, mock, setSystemTime } from "bun:test";

type Doc = Record<string, any>;
const ops: string[] = [];
let mongoDown = false;

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) =>
    cond && typeof cond === "object" && "$ne" in cond ? doc[key] !== cond.$ne : doc[key] === cond);
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
  const use = (op: string) => {
    ops.push(`${name}.${op}`);
    if (mongoDown) throw new Error("Server selection timed out after 10000 ms");
  };
  return {
    docs,
    async findOne(filter: Doc) { use("findOne"); return docs.find((d) => matches(d, filter)) ?? null; },
    find(filter: Doc) {
      use("find");
      const result = docs.filter((d) => matches(d, filter));
      const cursor = { sort: () => cursor, toArray: async () => result };
      return cursor;
    },
    async insertOne(doc: Doc) { use("insertOne"); docs.push({ ...doc }); return { acknowledged: true }; },
    async updateOne(filter: Doc, update: Doc, opts?: { upsert?: boolean }) {
      use("updateOne");
      let doc = docs.find((d) => matches(d, filter));
      if (!doc && opts?.upsert) { doc = { ...filter }; docs.push(doc); }
      if (doc) applyUpdate(doc, update);
      return { acknowledged: true };
    },
    async updateMany(filter: Doc, update: Doc) {
      use("updateMany");
      const hit = docs.filter((d) => matches(d, filter));
      hit.forEach((d) => applyUpdate(d, update));
      return { acknowledged: true, modifiedCount: hit.length };
    },
    async findOneAndUpdate(filter: Doc, update: Doc, opts?: { upsert?: boolean }) {
      use("findOneAndUpdate");
      let doc = docs.find((d) => matches(d, filter));
      if (!doc && opts?.upsert) {
        doc = { ...filter, ...(update.$setOnInsert ?? {}) };
        docs.push(doc);
      }
      if (doc) applyUpdate(doc, update);
      return doc ?? null;
    },
    async deleteOne(filter: Doc) {
      use("deleteOne");
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
const coll = (name: string) => (fakeCollections as any)[name] as ReturnType<typeof fakeCollection>;

const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({
  ...realMongo,
  getCollections: () => fakeCollections,
}));

const agentService = await import("../src/services/agentService");
const agentGroupService = await import("../src/services/agentGroupService");
const crossServer = await import("../src/services/crossServerService");
const database = await import("../src/utils/database");

const openSocket = () => ({ readyState: 1, send: () => 1, close: () => {} }) as any;
const settle = () => new Promise((r) => setTimeout(r, 20));

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

/** Record that `domain`'s agent is on another server, as that server would. */
function placeRemoteAgent(domain: string, serverId: string, port: number) {
  const agents = coll("agentConnections").docs;
  const existing = agents.find((d) => d.domain === domain);
  if (existing) existing.serverId = serverId;
  else agents.push({ domain, active: true, serverId, agentId: `${domain}-agent` });

  const servers = coll("serverHeartbeats").docs;
  if (!servers.some((s) => s.serverId === serverId)) {
    servers.push({ serverId, serverHost: "127.0.0.1", serverPort: port, lastHeartbeat: Date.now() });
  }
}

/** A stub peer server: answers every request with `respond`, and records what it got. */
function peer(respond: (req: Request) => Response) {
  const received: Array<{ path: string; forwardedFrom: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      received.push({ path: new URL(req.url).pathname, forwardedFrom: req.headers.get("x-forwarded-from") });
      return respond(req);
    },
  });
  return { port: server.port as number, received, stop: () => server.stop(true) };
}

beforeEach(() => {
  ops.length = 0;
  mongoDown = false;
});

afterEach(() => {
  mongoDown = false;
  setSystemTime();
});

describe("MongoDB unreachable", () => {
  test("a domain whose replicas are here keeps being served after every cache has expired", async () => {
    const a = await registerReplica("outage-app", "outage-1");
    const b = await registerReplica("outage-app", "outage-2");
    await settle();
    await agentGroupService.selectAgent("outage-app");

    mongoDown = true;
    setSystemTime(new Date(Date.now() + 10 * 60_000)); // every TTL long gone

    const started = performance.now();
    expect((await crossServer.findServerForDomain("outage-app")).isLocal).toBe(true);
    expect(await agentGroupService.isGroupedDomain("outage-app")).toBe(true);
    const picked = [];
    for (let i = 0; i < 4; i++) picked.push((await agentGroupService.selectAgent("outage-app"))!.id);
    expect(performance.now() - started).toBeLessThan(100);

    expect(new Set(picked)).toEqual(new Set([a.id, b.id]));
  });

  test("whether a domain is grouped comes from its replicas here, not MongoDB", async () => {
    await registerReplica("grouped-here", "gh-1");
    await settle();
    ops.length = 0;

    expect(await agentGroupService.isGroupedDomain("grouped-here")).toBe(true);
    expect(ops).toEqual([]);
  });

  test("a route to another server is reused, and kept when MongoDB fails", async () => {
    placeRemoteAgent("remote-app", "peer-r1", 41001);

    const first = await crossServer.findServerForDomain("remote-app");
    expect(first.targetServer?.serverId).toBe("peer-r1");
    expect(ops).toEqual(["agentConnections.findOne", "serverHeartbeats.findOne"]);

    ops.length = 0;
    await crossServer.findServerForDomain("remote-app");
    expect(ops).toEqual([]); // cached: no queries per forwarded request

    mongoDown = true;
    setSystemTime(new Date(Date.now() + 60_000)); // peer's heartbeat would look 60 s old
    const during = await crossServer.findServerForDomain("remote-app");
    expect(during.targetServer?.serverId).toBe("peer-r1");
  });
});

describe("custom domains, MongoDB unreachable", () => {
  test("a custom domain keeps being routed after every cache has expired, with one query for all of them", async () => {
    database.resetActiveCustomDomains();
    coll("customDomains").docs.push(
      { domain: "shop.example.com", active: true },
      { domain: "Blog.Example.org", active: true },
      { domain: "pending.example.net", active: false },
    );
    const finds = () => ops.filter((op) => op === "customDomains.find").length;
    const before = finds();
    expect(await database.isActiveCustomDomain("shop.example.com")).toBe(true);
    expect(await database.isActiveCustomDomain("blog.example.org")).toBe(true);
    expect(await database.isActiveCustomDomain("pending.example.net")).toBe(false);
    for (let i = 0; i < 50; i++) await database.isActiveCustomDomain(`scanner-${i}.example`);
    expect(finds() - before).toBe(1);

    mongoDown = true;
    setSystemTime(new Date(Date.now() + 10 * 60_000)); // every TTL long gone
    const started = performance.now();
    expect(await database.isActiveCustomDomain("shop.example.com")).toBe(true);
    expect(await database.isActiveCustomDomain("unknown.example")).toBe(false);
    await settle(); // the reload in the background fails; what is known stays
    expect(await database.isActiveCustomDomain("blog.example.org")).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000); // never waited on MongoDB
  });

  test("a domain this server activates or deletes is routed, or not, at once", async () => {
    database.resetActiveCustomDomains();
    coll("customDomains").docs.push({ domain: "new.example.com", active: false });
    expect(await database.isActiveCustomDomain("new.example.com")).toBe(false);
    await database.updateCustomDomainByName("new.example.com", { active: true });
    expect(await database.isActiveCustomDomain("new.example.com")).toBe(true);
    await database.deleteCustomDomainByName("new.example.com");
    expect(await database.isActiveCustomDomain("new.example.com")).toBe(false);
  });
});

describe("route lookup after a restart", () => {
  test("a stale record claiming this server is ignored: the request goes where the agent really is", async () => {
    coll("agentConnections").docs.push({ domain: "restarted-app", active: true, serverId: agentService.currentServerId, agentId: "gone" });
    placeRemoteAgent("restarted-app", "peer-holds-it", 41002);

    const route = await crossServer.findServerForDomain("restarted-app");
    expect(route.isLocal).toBe(false);
    expect(route.targetServer?.serverId).toBe("peer-holds-it");
  });
});

describe("one hop", () => {
  test("a request forwarded here is recognised, and answered with a miss", async () => {
    const forwarded = new Request("http://x/", { headers: { "X-Forwarded-From": "edge-a" } });
    expect(crossServer.isForwardedRequest(forwarded)).toBe(true);
    expect(crossServer.isForwardedRequest(new Request("http://x/"))).toBe(false);

    const res = crossServer.routeMissResponse("app");
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Jrok-Route")).toBe("miss");
    expect(res.headers.get("X-Jrok-Tunnel")).toBe("reconnecting");
  });

  test("a stale route is dropped and the request retried once on the server a fresh lookup names", async () => {
    const stale = peer(() => crossServer.routeMissResponse("moved-app"));
    const current = peer(() => new Response("served by current"));
    try {
      placeRemoteAgent("moved-app", "peer-stale", stale.port);
      const route = await crossServer.findServerForDomain("moved-app");
      placeRemoteAgent("moved-app", "peer-current", current.port); // the agent reconnected elsewhere

      const res = await crossServer.forwardToAgentServer(
        "moved-app", route.targetServer!, new Request("http://moved-app/page"), "/page", "203.0.113.5");

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("served by current");
      expect(stale.received.length).toBe(1);
      expect(current.received).toEqual([{ path: "/page", forwardedFrom: agentService.currentServerId }]);
    } finally {
      stale.stop();
      current.stop();
    }
  });

  test("an unreachable server is retried the same way", async () => {
    const current = peer(() => new Response("ok"));
    try {
      placeRemoteAgent("dead-peer-app", "peer-dead", 1); // nothing listens on port 1
      const route = await crossServer.findServerForDomain("dead-peer-app");
      placeRemoteAgent("dead-peer-app", "peer-alive", current.port);

      const res = await crossServer.forwardToAgentServer(
        "dead-peer-app", route.targetServer!, new Request("http://dead-peer-app/"), "/");

      expect(res.status).toBe(200);
    } finally {
      current.stop();
    }
  });

  test("a request with a body is not retried: its body was spent on the first try", async () => {
    const stale = peer(() => crossServer.routeMissResponse("post-app"));
    const current = peer(() => new Response("ok"));
    try {
      placeRemoteAgent("post-app", "peer-post-stale", stale.port);
      const route = await crossServer.findServerForDomain("post-app");
      placeRemoteAgent("post-app", "peer-post-current", current.port);

      const res = await crossServer.forwardToAgentServer(
        "post-app", route.targetServer!, new Request("http://post-app/", { method: "POST", body: "x" }), "/");

      expect(res.status).toBe(503);
      expect(current.received.length).toBe(0);
      // The stale route was still dropped, so the visitor's retry goes to the right server.
      expect((await crossServer.findServerForDomain("post-app")).targetServer?.serverId).toBe("peer-post-current");
    } finally {
      stale.stop();
      current.stop();
    }
  });
});
