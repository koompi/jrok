/**
 * POST /tunnels names an agent and a domain. Any signed-in account could name
 * any connected agent and any organizationId: a tunnel record that holds the
 * name from everyone else (agentService's availability check reads them), or a
 * TCP port opened to another organization's agent. Now the agent must be the
 * caller's, and the record is the agent's organization's.
 *
 * No database: the collections are in memory (tests/helpers/fakeMongo.ts).
 */
import { test, expect, beforeEach, mock } from "bun:test";
import { fakeCollections } from "./helpers/fakeMongo";

const fake = fakeCollections();
const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({
  ...realMongo,
  getCollections: () => fake.collections,
  getDatabase: async () => ({ collection: (name: string) => fake.collections[name] }), // the activity log
}));

const authService = await import("../src/services/authService");
const tunnelHandler = await import("../src/handlers/tunnelHandler");

async function signedIn(id: string, orgId?: string): Promise<string> {
  await fake.collections.users.insertOne({ id, koompId: `k-${id}`, email: `${id}@example.com`, fullname: id, role: "member", isActive: true, status: "active" });
  if (orgId) {
    await fake.collections.organizations.insertOne({ id: orgId, name: orgId, slug: orgId, ownerId: id, isActive: true, members: [{ userId: id, role: "owner", joinedAt: 0 }] });
  }
  return (await authService.createSession(id)).token;
}

const agent = (agentId: string, organizationId: string) => fake.collections.agentConnections.insertOne({
  agentId, domain: `app-${agentId}`, organizationId, active: true, localPort: 3000, localHost: "localhost", serverId: "vps-test", lastHeartbeat: Date.now(),
});

const create = (token: string, body: unknown) => tunnelHandler.handleCreateTunnel(new Request("https://public.koompi.cloud/tunnels", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
}));

beforeEach(() => {
  fake.reset();
  authService.invalidateUserOrgCache();
  authService.invalidateSessionCache();
});

test("another organization's agent can't be named: no record, no port", async () => {
  await agent("victims-db-agent", "org-victim");
  const token = await signedIn("mallory");
  const res = await create(token, { domain: "bank", agentId: "victims-db-agent", organizationId: "org-victim", protocol: "tcp" });
  expect(res.status).toBe(404);
  expect(await fake.collections.tunnels.countDocuments()).toBe(0);
});

test("an organization's own agent: the record is that organization's, whatever the body says", async () => {
  await agent("alices-agent", "org-alice");
  const token = await signedIn("alice", "org-alice");
  const res = await create(token, { domain: "shop", agentId: "alices-agent", organizationId: "org-someone-else" });
  expect(res.status).toBe(201);
  expect(fake.collections.tunnels.docs).toEqual([expect.objectContaining({ domain: "shop", agentId: "alices-agent", organizationId: "org-alice" })]);
});
