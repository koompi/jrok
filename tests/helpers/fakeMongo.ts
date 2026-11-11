/**
 * An in-memory stand-in for the collections jrok's services use, for tests
 * that mock "../src/utils/mongodb" (no database is touched). Enough of
 * MongoDB's filters for these tests: equality (an array field matches an
 * element), dotted paths, $or, $ne, $gt, $in, $exists.
 */
type Doc = Record<string, any>;

function valueAt(doc: Doc, path: string): any {
  let value: any = doc;
  for (const part of path.split(".")) {
    if (Array.isArray(value)) value = value.map((v) => v?.[part]);
    else value = value?.[part];
  }
  return value;
}

function equals(actual: any, expected: any): boolean {
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some((a) => equals(a, expected));
  if (expected === null) return actual === null || actual === undefined;
  if (expected && typeof expected === "object" && typeof expected.equals === "function") return expected.equals(actual);
  return actual === expected;
}

export function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return (cond as Doc[]).some((f) => matches(doc, f));
    const actual = valueAt(doc, key);
    if (cond && typeof cond === "object" && !Array.isArray(cond) && typeof cond.equals !== "function" &&
      Object.keys(cond).some((k) => k.startsWith("$"))) {
      return Object.entries(cond).every(([op, v]) => {
        if (op === "$ne") return !equals(actual, v);
        if (op === "$gt") return actual !== undefined && actual !== null && actual > (v as any);
        if (op === "$in") return (v as any[]).some((x) => equals(actual, x));
        if (op === "$exists") return (actual !== undefined) === v;
        throw new Error(`fakeMongo: ${op} not supported`);
      });
    }
    return equals(actual, cond);
  });
}

export function fakeCollection(docs: Doc[] = [], unique?: string) {
  return {
    docs,
    async findOne(filter: Doc = {}) { return docs.find((d) => matches(d, filter)) ?? null; },
    find(filter: Doc = {}) {
      let result = docs.filter((d) => matches(d, filter));
      const cursor = {
        sort: () => cursor,
        skip: (n: number) => { result = result.slice(n); return cursor; },
        limit: (n: number) => { result = result.slice(0, n); return cursor; },
        project: () => cursor,
        toArray: async () => result.map((d) => ({ ...d })),
      };
      return cursor;
    },
    async insertOne(doc: Doc) {
      if (unique && docs.some((d) => d[unique] === doc[unique])) {
        throw Object.assign(new Error(`E11000 duplicate key error: ${unique}`), { code: 11000 });
      }
      docs.push({ ...doc });
      return { acknowledged: true };
    },
    async insertMany(many: Doc[]) {
      for (const doc of many) await this.insertOne(doc);
      return { acknowledged: true, insertedCount: many.length };
    },
    async updateOne(filter: Doc, update: Doc) {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) Object.assign(doc, update.$set ?? {});
      return { acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    },
    async updateMany(filter: Doc, update: Doc) {
      const hit = docs.filter((d) => matches(d, filter));
      for (const doc of hit) Object.assign(doc, update.$set ?? {});
      return { acknowledged: true, modifiedCount: hit.length };
    },
    async findOneAndUpdate(filter: Doc, update: Doc) {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) Object.assign(doc, update.$set ?? {});
      return doc ?? null;
    },
    async deleteOne(filter: Doc) {
      const i = docs.findIndex((d) => matches(d, filter));
      if (i >= 0) docs.splice(i, 1);
      return { acknowledged: true, deletedCount: i >= 0 ? 1 : 0 };
    },
    async deleteMany(filter: Doc) {
      const before = docs.length;
      for (let i = docs.length - 1; i >= 0; i--) if (matches(docs[i]!, filter)) docs.splice(i, 1);
      return { acknowledged: true, deletedCount: before - docs.length };
    },
    async countDocuments(filter: Doc = {}) { return docs.filter((d) => matches(d, filter)).length; },
    async createIndex() { return "ok"; },
  };
}

export type FakeCollection = ReturnType<typeof fakeCollection>;

/** Every collection, made on first use; `reset()` empties them all. Unique indexes as jrok's (utils/mongodb.ts). */
export function fakeCollections(unique: Record<string, string> = { customDomains: "domain", apiKeys: "key", users: "koompId" }) {
  const map = new Map<string, FakeCollection>();
  const collections = new Proxy({} as Record<string, FakeCollection>, {
    get: (_t, name: string) => {
      if (!map.has(name)) map.set(name, fakeCollection([], unique[name]));
      return map.get(name);
    },
  });
  return { collections, reset: () => map.clear() };
}
