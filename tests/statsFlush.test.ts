/**
 * Usage counts are deleted only once MongoDB has them. They used to be taken
 * out of memory before the write, so a flush that failed (any MongoDB blip)
 * lost up to 30 s of every tenant's traffic records.
 */
import { test, expect, mock, setSystemTime, afterAll } from "bun:test";

const written: Array<{ tunnelId: string; inc: { bytesIn: number; bytesOut: number; requests: number } }> = [];
let failNext: "all" | number[] | null = null;
const fakeCollection = {
  async bulkWrite(ops: any[]) {
    const fail = failNext;
    failNext = null;
    if (fail === "all") throw new Error("Server selection timed out after 10000 ms");
    ops.forEach((op, i) => {
      if (!fail?.includes(i)) written.push({ tunnelId: op.updateOne.filter.tunnelId, inc: op.updateOne.update.$inc });
    });
    if (fail) throw Object.assign(new Error("some writes failed"), { writeErrors: fail.map((index) => ({ index })) });
    return { ok: 1 };
  },
};

const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({
  ...realMongo,
  getDatabase: async () => ({ collection: () => fakeCollection }),
}));
const stats = await import("../src/services/statsService");

setSystemTime(new Date("2026-11-03T10:15:00Z")); // one hour bucket for the whole file
afterAll(() => setSystemTime());

const total = (tunnelId: string) => written.filter((w) => w.tunnelId === tunnelId).reduce(
  (sum, w) => ({ bytesIn: sum.bytesIn + w.inc.bytesIn, bytesOut: sum.bytesOut + w.inc.bytesOut, requests: sum.requests + w.inc.requests }),
  { bytesIn: 0, bytesOut: 0, requests: 0 });

test("a flush MongoDB refuses loses nothing: the next one writes both windows' counts", async () => {
  stats.recordBandwidth({ organizationId: "org-1", tunnelId: "t-1", bytesIn: 10, bytesOut: 100 });
  failNext = "all";
  await expect(stats.flushBandwidthToMongo()).rejects.toThrow();

  stats.recordBandwidth({ organizationId: "org-1", tunnelId: "t-1", bytesIn: 5, bytesOut: 50 });
  await stats.flushBandwidthToMongo();
  expect(total("t-1")).toEqual({ bytesIn: 15, bytesOut: 150, requests: 2 });
  expect(stats.unsavedBandwidthCount()).toBe(0);
});

test("when only some writes of a batch fail, only those are written again", async () => {
  stats.recordBandwidth({ organizationId: "org-1", tunnelId: "t-2", bytesIn: 1, bytesOut: 2 });
  stats.recordBandwidth({ organizationId: "org-1", tunnelId: "t-3", bytesIn: 3, bytesOut: 4 });
  failNext = [1];
  await expect(stats.flushBandwidthToMongo()).rejects.toThrow();
  await stats.flushBandwidthToMongo();
  expect(total("t-2")).toEqual({ bytesIn: 1, bytesOut: 2, requests: 1 });
  expect(total("t-3")).toEqual({ bytesIn: 3, bytesOut: 4, requests: 1 });
});

test("counts kept from one hour are written to that hour", async () => {
  stats.recordBandwidth({ organizationId: "org-1", tunnelId: "t-4", bytesIn: 7, bytesOut: 7 });
  failNext = "all";
  await expect(stats.flushBandwidthToMongo()).rejects.toThrow();
  setSystemTime(new Date("2026-11-03T11:05:00Z"));
  stats.recordBandwidth({ organizationId: "org-1", tunnelId: "t-4", bytesIn: 1, bytesOut: 1 });
  const before = written.length;
  await stats.flushBandwidthToMongo();
  expect(written.length - before).toBe(2); // one write per hour bucket
  expect(total("t-4")).toEqual({ bytesIn: 8, bytesOut: 8, requests: 2 });
});
