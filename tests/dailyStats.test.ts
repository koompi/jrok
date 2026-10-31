/**
 * Every jrok server runs the daily stats job. Each used to insert its own copy
 * of yesterday's totals, so with two servers every day counted twice (P7 in
 * docs/plans/jrok-scale-out-plan.md). Running it any number of times must
 * leave one record per org + tunnel + day, with the right totals.
 */
import { test, expect, mock } from "bun:test";

type Doc = Record<string, any>;
const docs: Doc[] = [];

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && "$regex" in cond) return new RegExp(cond.$regex).test(doc[key] ?? "");
    return doc[key] === cond;
  });
}

const fakeCollection = {
  find: (filter: Doc) => ({ toArray: async () => docs.filter((d) => matches(d, filter)) }),
  async bulkWrite(ops: any[]) {
    for (const { updateOne: { filter, update, upsert } } of ops) {
      let doc = docs.find((d) => matches(d, filter));
      if (!doc && upsert) {
        doc = { ...filter, ...(update.$setOnInsert ?? {}) };
        docs.push(doc);
      }
      if (doc) Object.assign(doc, update.$set ?? {});
    }
    return { acknowledged: true };
  },
};

const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({
  ...realMongo,
  getDatabase: async () => ({ collection: () => fakeCollection }),
}));

const { aggregateDailyStats } = await import("../src/services/statsService");

test("two servers running the daily job leave one record per tunnel, with the right totals", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const day = yesterday.toISOString().split("T")[0];

  docs.push(
    { period: "hour", periodKey: `${day}T01`, organizationId: "org-1", tunnelId: "t-1", bytesIn: 10, bytesOut: 100, requests: 1 },
    { period: "hour", periodKey: `${day}T02`, organizationId: "org-1", tunnelId: "t-1", bytesIn: 20, bytesOut: 200, requests: 2 },
    { period: "hour", periodKey: `${day}T02`, organizationId: "org-1", tunnelId: "t-2", bytesIn: 5, bytesOut: 50, requests: 1 },
  );

  await aggregateDailyStats(); // edge 1
  await aggregateDailyStats(); // edge 2, same hour

  const daily = docs.filter((d) => d.period === "day");
  expect(daily.length).toBe(2);
  expect(daily.find((d) => d.tunnelId === "t-1")).toMatchObject({ bytesIn: 30, bytesOut: 300, requests: 3, periodKey: day });
  expect(daily.find((d) => d.tunnelId === "t-2")).toMatchObject({ bytesIn: 5, bytesOut: 50, requests: 1 });
});
