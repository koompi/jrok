/**
 * Connection-counter accounting for load-balanced agent groups.
 *
 * activeConnections is only read by the 'least-connections' strategy, so the
 * increment/decrement pair is skipped entirely for every other strategy — that
 * pair used to be two MongoDB writes on EVERY request through a grouped domain,
 * and every kconsole HTTP tunnel is grouped.
 *
 * The risk in skipping them is drift: an increment without its decrement biases
 * a member out of rotation forever, and an unmatched decrement drives the count
 * negative so that member is always chosen. These tests pin that behaviour.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

// Records every $inc issued against agentGroupMembers, so tests can assert on
// what actually reached the database rather than on internal bookkeeping.
const writes: Array<{ agentId: string; delta: number }> = [];

// Keep every other export intact — agentGroupService pulls more than
// getCollections from this module, and replacing it wholesale breaks the import
// graph rather than the database call we actually want to intercept.
const realMongo = await import("../src/utils/mongodb");

mock.module("../src/utils/mongodb", () => ({
  ...realMongo,
  getCollections: () => ({
    agentGroupMembers: {
      updateOne: async (filter: any, update: any) => {
        writes.push({
          agentId: filter.agentId,
          delta: update.$inc.activeConnections,
        });
        return { acknowledged: true };
      },
    },
  }),
}));

const { incrementMemberConnections, decrementMemberConnections } = await import(
  "../src/services/agentGroupService"
);

beforeEach(() => {
  writes.length = 0;
});

describe("group connection counters", () => {
  test("round-robin issues no writes at all", async () => {
    await incrementMemberConnections("agent-rr", "round-robin");
    await decrementMemberConnections("agent-rr");

    expect(writes).toEqual([]);
  });

  test("random and weighted also issue no writes", async () => {
    await incrementMemberConnections("agent-rand", "random");
    await incrementMemberConnections("agent-weight", "weighted");
    await decrementMemberConnections("agent-rand");
    await decrementMemberConnections("agent-weight");

    expect(writes).toEqual([]);
  });

  test("least-connections increments and decrements symmetrically", async () => {
    await incrementMemberConnections("agent-lc", "least-connections");
    await decrementMemberConnections("agent-lc");

    expect(writes).toEqual([
      { agentId: "agent-lc", delta: 1 },
      { agentId: "agent-lc", delta: -1 },
    ]);
  });

  test("counter nets to zero across concurrent requests", async () => {
    for (let i = 0; i < 5; i++) {
      await incrementMemberConnections("agent-busy", "least-connections");
    }
    for (let i = 0; i < 5; i++) {
      await decrementMemberConnections("agent-busy");
    }

    const net = writes.reduce((sum, w) => sum + w.delta, 0);
    expect(net).toBe(0);
    expect(writes).toHaveLength(10);
  });

  test("an unmatched decrement cannot drive the counter negative", async () => {
    // The request-completion path fires regardless of strategy, so decrements
    // arrive for agents we never incremented. Left unguarded these would make a
    // member look permanently idle and win every least-connections selection.
    await decrementMemberConnections("agent-never-incremented");
    expect(writes).toEqual([]);

    // And a decrement beyond what we issued must not leak past zero either.
    await incrementMemberConnections("agent-one", "least-connections");
    await decrementMemberConnections("agent-one");
    await decrementMemberConnections("agent-one");
    await decrementMemberConnections("agent-one");

    const net = writes
      .filter((w) => w.agentId === "agent-one")
      .reduce((sum, w) => sum + w.delta, 0);
    expect(net).toBe(0);
  });

  test("a strategy switch does not strand an outstanding increment", async () => {
    // Group is reconfigured between a request starting and finishing. The
    // decrement carries no strategy, so it must still settle the increment we
    // actually issued rather than checking the group's current strategy.
    await incrementMemberConnections("agent-switch", "least-connections");
    await decrementMemberConnections("agent-switch");

    const net = writes
      .filter((w) => w.agentId === "agent-switch")
      .reduce((sum, w) => sum + w.delta, 0);
    expect(net).toBe(0);
  });

  test("counters are tracked per agent, not globally", async () => {
    await incrementMemberConnections("agent-a", "least-connections");
    await incrementMemberConnections("agent-b", "least-connections");
    await decrementMemberConnections("agent-a");
    await decrementMemberConnections("agent-a"); // extra, must be ignored

    const a = writes.filter((w) => w.agentId === "agent-a").reduce((s, w) => s + w.delta, 0);
    const b = writes.filter((w) => w.agentId === "agent-b").reduce((s, w) => s + w.delta, 0);

    expect(a).toBe(0); // incremented once, decremented once, extra ignored
    expect(b).toBe(1); // still in flight
  });
});
