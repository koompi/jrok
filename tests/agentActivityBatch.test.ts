/**
 * Agents' connects and disconnects are written in batches (activityService.flushAgentLogs): one insert per agent
 * spent the database's ~100 operations a second per edge in the bursts that need them (an edge or a deploy server
 * restarting reconnects every agent it had). No database: the activity collection is a stand-in.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

const inserted: { one: any[]; many: any[][] } = { one: [], many: [] };
const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({
  ...realMongo,
  getDatabase: async () => ({
    collection: () => ({
      insertOne: async (d: any) => { inserted.one.push(d); },
      insertMany: async (docs: any[]) => { inserted.many.push(docs); },
    }),
  }),
}));
const activity = await import("../src/services/activityService");

beforeEach(async () => {
  await activity.flushAgentLogs();
  inserted.one = [];
  inserted.many = [];
});

describe("agent connects and disconnects", () => {
  test("are written together, not one insert each", async () => {
    for (let i = 0; i < 120; i++) await activity.logAgentConnected("org-a", `agent-${i}`, `app-${i}`, "10.0.0.1");
    for (let i = 0; i < 30; i++) await activity.logAgentDisconnected("org-a", `agent-${i}`, `app-${i}`);
    expect(inserted.one).toEqual([]);
    expect(inserted.many).toEqual([]);
    await activity.flushAgentLogs();
    expect(inserted.many).toHaveLength(1);
    expect(inserted.many[0]).toHaveLength(150);
    expect(inserted.many[0][0]).toMatchObject({ organizationId: "org-a", category: "agents", action: "connected", resourceId: "agent-0", resourceName: "app-0", ipAddress: "10.0.0.1", description: "Agent connected from 10.0.0.1" });
    expect(inserted.many[0][149]).toMatchObject({ action: "disconnected", resourceId: "agent-29", description: "Agent disconnected" });
    expect(typeof inserted.many[0][0].id).toBe("string");
    expect(typeof inserted.many[0][0].createdAt).toBe("number");
  });

  test("a full batch is written at once; the rest within AGENT_LOG_FLUSH_MS", async () => {
    for (let i = 0; i < activity.AGENT_LOG_BATCH + 3; i++) await activity.logAgentConnected("org-a", `a${i}`, "app");
    expect(inserted.many.map((b) => b.length)).toEqual([activity.AGENT_LOG_BATCH]);
    await new Promise((r) => setTimeout(r, activity.AGENT_LOG_FLUSH_MS + 200));
    expect(inserted.many.map((b) => b.length)).toEqual([activity.AGENT_LOG_BATCH, 3]);
  });

  test("other activity is still written at once, and nothing waiting is written twice", async () => {
    await activity.logActivity({ organizationId: "org-a", category: "agents", action: "connected", resourceType: "agent", description: "by hand" });
    expect(inserted.one).toHaveLength(1);
    await activity.flushAgentLogs();
    await activity.flushAgentLogs();
    expect(inserted.many).toEqual([]);
  });

  test("the shutdown writes what is waiting (index.ts)", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(src).toMatch(/flush: async \(\) => \{ await Promise\.all\(\[statsService\.flushBandwidthToMongo\(\), activityService\.flushAgentLogs\(\)\]\); \}/);
  });
});
