/**
 * jrok uses the database its MONGODB_URI names. It used to use "jrok" whatever
 * the URI said, so `bun test`, pointed at .../jrok_test, emptied the
 * certificates of the real "jrok" database on the same server.
 *
 * The second test needs a throwaway MongoDB whose URI names a jrok_test…
 * database (MONGODB_TEST_URI, else MONGODB_URI, else 127.0.0.1:27018/jrok_test):
 *   MONGODB_URI=mongodb://127.0.0.1:27018/jrok_test bun test tests/mongoDatabase.test.ts
 */
import { test, expect, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { testMongo } from "./helpers/testMongo";

test("the database is the one the URI names; MONGODB_DB wins; 'jrok' without either", async () => {
  const { databaseName, uriDatabaseName } = await import("../src/utils/mongodb");
  expect(uriDatabaseName("mongodb://127.0.0.1:27018/jrok_test_edge")).toBe("jrok_test_edge");
  expect(uriDatabaseName("mongodb://127.0.0.1:27017/jrok_test?serverSelectionTimeoutMS=2000")).toBe("jrok_test");
  expect(uriDatabaseName("mongodb+srv://user:pa%2Fss@cluster0.abc.mongodb.net/jrok?retryWrites=true&w=majority")).toBe("jrok");
  expect(uriDatabaseName("mongodb://u:p@a.example:27017,b.example:27017/other_db?replicaSet=rs0")).toBe("other_db");
  // No database in the URI: "jrok", as before.
  expect(uriDatabaseName("mongodb://127.0.0.1:27018")).toBe("jrok");
  expect(uriDatabaseName("mongodb://jrok:secret@10.0.0.5:27017/?authSource=admin")).toBe("jrok");
  expect(uriDatabaseName("mongodb+srv://user:pass@cluster0.abc.mongodb.net/?retryWrites=true")).toBe("jrok");
  // The edges pin it (Ansible writes MONGODB_DB=jrok), whatever the URI's path says.
  expect(databaseName("mongodb+srv://user:pass@cluster0.abc.mongodb.net/admin", "jrok")).toBe("jrok");
  expect(databaseName("mongodb://127.0.0.1:27018/jrok_test_edge", "")).toBe("jrok_test_edge");
});

test("only the URI says where tests write: MONGODB_DB=jrok_test… never passes a URI that names jrok", () => {
  const saved = { db: process.env.MONGODB_DB, test: process.env.MONGODB_TEST_URI };
  try {
    // The tests connect after deleting MONGODB_DB, so this URI would have them
    // empty the real "jrok" database's certificates.
    process.env.MONGODB_DB = "jrok_test_pin";
    process.env.MONGODB_TEST_URI = "mongodb://127.0.0.1:27017/jrok";
    expect(testMongo()).toHaveProperty("skip");
    process.env.MONGODB_TEST_URI = "mongodb://127.0.0.1:27017";
    expect(testMongo()).toHaveProperty("skip");
    // And the edges' pin doesn't turn a test database away.
    process.env.MONGODB_DB = "jrok";
    process.env.MONGODB_TEST_URI = "mongodb://127.0.0.1:27018/jrok_test_x";
    expect(testMongo()).toEqual({ uri: "mongodb://127.0.0.1:27018/jrok_test_x", db: "jrok_test_x" });
  } finally {
    for (const [name, value] of [["MONGODB_DB", saved.db], ["MONGODB_TEST_URI", saved.test]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// Only a database named jrok_test… (tests/helpers/testMongo.ts).
const target = testMongo();
const URI = "uri" in target ? target.uri : undefined;
const TEST_DB = "uri" in target ? target.db : undefined;
const DOMAIN = `dbname-${Math.random().toString(36).slice(2, 10)}.example.test`;
let own: MongoClient | undefined;

afterAll(async () => {
  if (!own) return;
  // Before the fix the record went to "jrok": take out exactly that one.
  for (const name of [TEST_DB!, "jrok"]) {
    await own.db(name).collection("certificates").deleteOne({ _id: DOMAIN as any });
    await own.db(name).collection("cert_sync_queue").deleteMany({ domain: DOMAIN });
  }
  await own.close();
});

test.skipIf(!TEST_DB)("a certificate goes to the URI's database, never to a 'jrok' next to it", async () => {
  process.env.MONGODB_URI = URI!;
  delete process.env.MONGODB_DB;
  const mongo = await import("../src/utils/mongodb");
  const certSync = await import("../src/services/certificateSyncService");
  await mongo.connectDatabase();
  own = await MongoClient.connect(URI!);
  try {
    await certSync.uploadCertificateToMongoDB(DOMAIN, "Yw==", "Yw==", "Yw==", "cGs=", "db-name-test");
    expect(await own.db(TEST_DB!).collection("certificates").findOne({ _id: DOMAIN as any })).not.toBeNull();
    expect(await own.db("jrok").collection("certificates").findOne({ _id: DOMAIN as any })).toBeNull();
  } finally {
    await mongo.closeDatabase();
  }
}, 30000);
