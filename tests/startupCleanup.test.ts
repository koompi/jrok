/**
 * A restarted jrok server removes ITS OWN stale agent records, and only those
 * (cleanupStaleConnectionsOnStartup). It used to clean a server called
 * "default" (it read SERVER_ID; the identity is VPS_ID), leaving the restarted
 * edge believing it held agents it didn't, and to delete every server's group
 * members and reset every group.
 *
 * Runs against a real MongoDB (the group recount is an update pipeline):
 * set MONGODB_TEST_URI to a THROWAWAY instance, e.g.
 *   docker run -d --rm -p 127.0.0.1:27018:27017 mongo:7
 *   MONGODB_TEST_URI=mongodb://127.0.0.1:27018 bun test tests/startupCleanup.test.ts
 * Skipped without it. Only touches records of the made-up servers below.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient, type Db } from "mongodb";

const URI = process.env.MONGODB_TEST_URI;
const A = "cleanup-test-edge-a";
const B = "cleanup-test-edge-b";

let mongo: typeof import("../src/utils/mongodb");
// Fixtures and checks go through a client of our own: other test files replace
// getCollections with in-memory stand-ins, and Bun's module mocks are shared.
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  if (!URI) return;
  process.env.MONGODB_URI = URI;
  mongo = await import("../src/utils/mongodb");
  await mongo.connectDatabase();
  client = await MongoClient.connect(URI);
  db = client.db("jrok");
});

afterAll(async () => {
  if (!URI) return;
  await db.collection("agentConnections").deleteMany({ serverId: { $in: [A, B] } });
  await db.collection("agentGroupMembers").deleteMany({ agentId: { $regex: "^cleanup-test-" } });
  await db.collection("agentGroups").deleteMany({ domain: { $regex: "^cleanup-test-" } });
  await client.close();
  await mongo.closeDatabase();
});

test.skipIf(!URI)("a restart removes only this server's records, and recounts groups", async () => {
  const c = {
    agentConnections: db.collection("agentConnections"),
    agentGroupMembers: db.collection("agentGroupMembers"),
    agentGroups: db.collection("agentGroups"),
  };
  await c.agentConnections.insertMany([
    { agentId: "cleanup-test-a1", domain: "cleanup-test-app", instanceId: `r1@${A}`, serverId: A, active: true },
    { agentId: "cleanup-test-b1", domain: "cleanup-test-app", instanceId: `r1@${B}`, serverId: B, active: true },
    { agentId: "cleanup-test-a2", domain: "cleanup-test-solo", instanceId: `r1@${A}`, serverId: A, active: true },
  ]);
  await c.agentGroupMembers.insertMany([
    { groupId: "cleanup-test-g1", agentId: "cleanup-test-a1", instanceId: `r1@${A}` },
    { groupId: "cleanup-test-g1", agentId: "cleanup-test-b1", instanceId: `r1@${B}` },
    { groupId: "cleanup-test-g2", agentId: "cleanup-test-a2", instanceId: `r1@${A}` },
  ]);
  await c.agentGroups.insertMany([
    { id: "cleanup-test-g1", domain: "cleanup-test-app", agentIds: ["cleanup-test-a1", "cleanup-test-b1"], activeAgentCount: 2 },
    { id: "cleanup-test-g2", domain: "cleanup-test-solo", agentIds: ["cleanup-test-a2"], activeAgentCount: 1 },
  ]);

  await mongo.cleanupStaleConnectionsOnStartup(A);

  expect((await c.agentConnections.find({ serverId: { $in: [A, B] } }).toArray()).map((d) => d.agentId)).toEqual(["cleanup-test-b1"]);
  expect((await c.agentGroupMembers.find({ agentId: { $regex: "^cleanup-test-" } }).toArray()).map((d) => d.agentId)).toEqual(["cleanup-test-b1"]);
  const g1 = await c.agentGroups.findOne({ id: "cleanup-test-g1" });
  expect(g1).toMatchObject({ agentIds: ["cleanup-test-b1"], activeAgentCount: 1 });
  // A group left with nobody on any server is removed.
  expect(await c.agentGroups.findOne({ id: "cleanup-test-g2" })).toBeNull();
});
