import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const CERT_DIR_ROOT = await mkdtemp(join(tmpdir(), "jrok-certs-"));
const NGINX_DIR = await mkdtemp(join(tmpdir(), "jrok-nginx-"));

// These tests need a real MongoDB: the bugs covered here (driver v6 result
// shapes, a $set/$inc path conflict) only reproduce against the server, never
// against a mock. Point MONGODB_TEST_URI at a throwaway instance; the suite
// skips itself when none is reachable so `bun test` still passes without one.
// serverSelectionTimeoutMS keeps the "no MongoDB here" case to ~2s instead of
// the 30s default, so skipping is fast on a machine without one.
const TEST_URI =
  process.env.MONGODB_TEST_URI ||
  "mongodb://127.0.0.1:27017/jrok_test?serverSelectionTimeoutMS=2000";
process.env.MONGODB_URI = TEST_URI;
process.env.CERT_LIVE_PATH = CERT_DIR_ROOT;
process.env.NGINX_SITES_PATH = NGINX_DIR;
process.env.BASE_DOMAIN = "tunnel.koompi.cloud";
process.env.JWT_SECRET = "test-secret-not-used";

import { connectDatabase, getClient, closeDatabase } from "../src/utils/mongodb";
import * as certSync from "../src/services/certificateSyncService";

const b64 = (s: string) => Buffer.from(s).toString("base64");

function certDoc(domain: string, version: number, body = "BODY") {
  return {
    _id: domain, domain,
    cert: b64(`cert-${body}`), chain: b64(`chain-${body}`),
    fullchain: b64(`fullchain-${body}`), privkey: b64(`privkey-${body}`),
    expiry: new Date(Date.now() + 90 * 86400000),
    uploadedAt: new Date(), uploadedBy: "test", version, status: "valid",
  };
}

let mongoAvailable = false;

beforeAll(async () => {
  try {
    await connectDatabase();
    await getClient()!.db("jrok").command({ ping: 1 });
    mongoAvailable = true;
  } catch {
    console.warn(`\n\u23ed\ufe0f  Skipping certificate sync tests: no MongoDB at ${TEST_URI}\n   Start one with: docker run -d --rm -p 27017:27017 mongo:7\n`);
  }
}, 30000);

afterAll(async () => { if (mongoAvailable) await closeDatabase(); });

beforeEach(async () => {
  if (!mongoAvailable) return;
  await getClient()!.db("jrok").collection("certificates").deleteMany({});
  // Each test starts from a bare server: empty cert store, empty nginx dir.
  const { rm } = await import("fs/promises");
  await rm(CERT_DIR_ROOT, { recursive: true, force: true });
  await rm(NGINX_DIR, { recursive: true, force: true });
  await mkdir(CERT_DIR_ROOT, { recursive: true });
  await mkdir(NGINX_DIR, { recursive: true });
});

const exists = async (p: string) => { try { await access(p); return true; } catch { return false; } };

test("fresh server pulls every certificate, regardless of age", async () => {
  if (!mongoAvailable) return;
  const certs = getClient()!.db("jrok").collection("certificates");
  // An old custom domain: the exact case the 24h TTL queue used to miss.
  await certs.insertOne({ ...certDoc("shop.customer.com", 3), uploadedAt: new Date(Date.now() - 400 * 86400000) } as any);
  await certs.insertOne(certDoc("tunnel.koompi.cloud", 1) as any);

  const stats = await certSync.syncAllCertificatesToDisk();

  expect(stats.synced.sort()).toEqual(["shop.customer.com", "tunnel.koompi.cloud"]);
  expect(stats.failed).toEqual([]);
  expect(await readFile(join(CERT_DIR_ROOT, "shop.customer.com/fullchain.pem"), "utf8")).toBe("fullchain-BODY");
  expect(await readFile(join(CERT_DIR_ROOT, "shop.customer.com/privkey.pem"), "utf8")).toBe("privkey-BODY");
});

test("custom domains get an nginx vhost; our own base domain does not", async () => {
  if (!mongoAvailable) return;
  const certs = getClient()!.db("jrok").collection("certificates");
  await certs.insertOne(certDoc("shop.customer.com", 1) as any);
  await certs.insertOne(certDoc("abc.tunnel.koompi.cloud", 1) as any);

  await certSync.syncAllCertificatesToDisk();

  const files = await readdir(NGINX_DIR);
  expect(files).toContain("shop_customer_com.conf");
  expect(files).not.toContain("abc_tunnel_koompi_cloud.conf");

  const conf = await readFile(join(NGINX_DIR, "shop_customer_com.conf"), "utf8");
  expect(conf).toContain("server_name shop.customer.com;");
  expect(conf).toContain(`ssl_certificate ${CERT_DIR_ROOT}/shop.customer.com/fullchain.pem;`);
});

test("second run is a no-op (idempotent)", async () => {
  if (!mongoAvailable) return;
  const certs = getClient()!.db("jrok").collection("certificates");
  await certs.insertOne(certDoc("shop.customer.com", 1) as any);

  const first = await certSync.syncAllCertificatesToDisk();
  expect(first.synced).toEqual(["shop.customer.com"]);

  const second = await certSync.syncAllCertificatesToDisk();
  expect(second.synced).toEqual([]);
  expect(second.skipped).toBe(1);
});

test("a newer version in MongoDB is pulled down", async () => {
  if (!mongoAvailable) return;
  const certs = getClient()!.db("jrok").collection("certificates");
  await certs.insertOne(certDoc("shop.customer.com", 1, "OLD") as any);
  await certSync.syncAllCertificatesToDisk();

  await certs.replaceOne({ _id: "shop.customer.com" } as any, certDoc("shop.customer.com", 2, "NEW"));
  const stats = await certSync.syncAllCertificatesToDisk();

  expect(stats.synced).toEqual(["shop.customer.com"]);
  expect(await readFile(join(CERT_DIR_ROOT, "shop.customer.com/fullchain.pem"), "utf8")).toBe("fullchain-NEW");
});

test("an older version in MongoDB never overwrites a newer local cert", async () => {
  if (!mongoAvailable) return;
  const certs = getClient()!.db("jrok").collection("certificates");
  await certs.insertOne(certDoc("shop.customer.com", 5, "CURRENT") as any);
  await certSync.syncAllCertificatesToDisk();

  // Simulate a stale MongoDB copy (e.g. a rollback or a slow writer).
  await certs.replaceOne({ _id: "shop.customer.com" } as any, certDoc("shop.customer.com", 2, "STALE"));
  const stats = await certSync.syncAllCertificatesToDisk();

  expect(stats.synced).toEqual([]);
  expect(await readFile(join(CERT_DIR_ROOT, "shop.customer.com/fullchain.pem"), "utf8")).toBe("fullchain-CURRENT");
});

test("a locally-issued cert with no marker is not blindly overwritten", async () => {
  if (!mongoAvailable) return;
  const dir = join(CERT_DIR_ROOT, "local.customer.com");
  await mkdir(dir, { recursive: true });
  // certbot issued this locally: real files, no .jrok-sync-version marker.
  await writeFile(join(dir, "fullchain.pem"), "LOCALLY-ISSUED-CERT");

  const certs = getClient()!.db("jrok").collection("certificates");
  await certs.insertOne(certDoc("local.customer.com", 1, "FROM-DB") as any);

  const stats = await certSync.syncAllCertificatesToDisk();

  // Neither PEM is valid, so openssl cannot prove which expires later.
  // Safety rule 1 says: leave the cert that is currently serving traffic alone.
  expect(stats.synced).toEqual([]);
  expect(await readFile(join(dir, "fullchain.pem"), "utf8")).toBe("LOCALLY-ISSUED-CERT");
});

test("an existing nginx vhost is never clobbered", async () => {
  if (!mongoAvailable) return;
  const confPath = join(NGINX_DIR, "tuned_customer_com.conf");
  await writeFile(confPath, "# hand-tuned by an operator\n");

  const certs = getClient()!.db("jrok").collection("certificates");
  await certs.insertOne(certDoc("tuned.customer.com", 1) as any);

  await certSync.syncAllCertificatesToDisk();

  expect(await readFile(confPath, "utf8")).toBe("# hand-tuned by an operator\n");
});

test("a vhost is created even when the certificate is already current", async () => {
  if (!mongoAvailable) return;
  const certs = getClient()!.db("jrok").collection("certificates");
  await certs.insertOne(certDoc("late.customer.com", 1) as any);
  await certSync.syncAllCertificatesToDisk();

  // Someone deleted the vhost; cert on disk is still current.
  const { unlink } = await import("fs/promises");
  await unlink(join(NGINX_DIR, "late_customer_com.conf"));

  const stats = await certSync.syncAllCertificatesToDisk();
  expect(stats.synced).toEqual([]);          // no cert rewrite
  expect(await exists(join(NGINX_DIR, "late_customer_com.conf"))).toBe(true); // vhost restored
});

test("a malformed domain name is skipped, and does not stop the batch", async () => {
  if (!mongoAvailable) return;
  const certs = getClient()!.db("jrok").collection("certificates");
  await certs.insertOne({ ...certDoc("x", 1), _id: "../../etc/passwd", domain: "../../etc/passwd" } as any);
  await certs.insertOne(certDoc("good.customer.com", 1) as any);

  const stats = await certSync.syncAllCertificatesToDisk();

  expect(stats.synced).toEqual(["good.customer.com"]);
  expect(stats.failed).toEqual([]);
});

test("reconcile survives MongoDB being unreachable", async () => {
  if (!mongoAvailable) return;
  await closeDatabase();
  const stats = await certSync.syncAllCertificatesToDisk();  // must not throw
  expect(stats.synced).toEqual([]);
  await connectDatabase();
});

// =============================================================================
// MongoDB driver v6 regressions
// =============================================================================
// Both of these made certificate sync silently dead in production: no server
// ever won leader election, so no certificate was ever uploaded, so there was
// nothing for other servers to pull.

test("leader election succeeds (findOneAndUpdate result shape)", async () => {
  if (!mongoAvailable) return;
  await getClient()!.db("jrok").collection("leader_leases").deleteMany({});

  expect(await certSync.attemptBecomeLeader("server-a")).toBe(true);
  // A second server must NOT win while the first holds an unexpired lease.
  expect(await certSync.attemptBecomeLeader("server-b")).toBe(false);
  // The holder can renew.
  expect(await certSync.refreshLeaderLease("server-a")).toBe(true);
  expect(await certSync.refreshLeaderLease("server-b")).toBe(false);
});

test("uploading a certificate round-trips and increments version", async () => {
  if (!mongoAvailable) return;
  await getClient()!.db("jrok").collection("certificates").deleteMany({});
  await getClient()!.db("jrok").collection("cert_sync_queue").deleteMany({});

  // NOTE: despite the `...Pem` parameter names, this function stores its
  // arguments verbatim and every real caller passes BASE64 (domainService
  // encodes before calling; the certbot renewal hook posts base64). The test
  // does the same so it exercises the real contract.

  // Previously threw: "Updating the path 'version' would create a conflict".
  const first = await certSync.uploadCertificateToMongoDB(
    "up.customer.com", b64("CERT"), b64("CHAIN"), b64("FULLCHAIN"), b64("PRIVKEY"), "server-a"
  );
  expect(first.version).toBe(1);

  const second = await certSync.uploadCertificateToMongoDB(
    "up.customer.com", b64("CERT2"), b64("CHAIN2"), b64("FULLCHAIN2"), b64("PRIVKEY2"), "server-a"
  );
  expect(second.version).toBe(2);

  const fetched = await certSync.downloadCertificateFromMongoDB("up.customer.com");
  expect(Buffer.from(fetched!.fullchain, "base64").toString()).toBe("FULLCHAIN2");
});

test("an uploaded certificate reaches a second server's disk", async () => {
  if (!mongoAvailable) return;
  await getClient()!.db("jrok").collection("certificates").deleteMany({});
  await getClient()!.db("jrok").collection("cert_sync_queue").deleteMany({});

  // Server A issues and uploads.
  await certSync.uploadCertificateToMongoDB(
    "e2e.customer.com", b64("C"), b64("CH"), b64("FULL-A"), b64("PK"), "server-a"
  );

  // Server B (this process, bare disk) reconciles.
  const stats = await certSync.syncAllCertificatesToDisk();

  expect(stats.synced).toEqual(["e2e.customer.com"]);
  expect(await readFile(join(CERT_DIR_ROOT, "e2e.customer.com/fullchain.pem"), "utf8")).toBe("FULL-A");
  expect(await readFile(join(NGINX_DIR, "e2e_customer_com.conf"), "utf8")).toContain("server_name e2e.customer.com;");
});

test("two peer servers can both publish; neither blocks the other", async () => {
  if (!mongoAvailable) return;
  await getClient()!.db("jrok").collection("certificates").deleteMany({});
  await getClient()!.db("jrok").collection("cert_sync_queue").deleteMany({});

  // Server A registers one customer domain, server B registers another at the
  // same time. Uploads used to be gated on a 30s leader lease, so whichever
  // server lost the race dropped the only copy of its certificate.
  const [a, b] = await Promise.all([
    certSync.uploadCertificateToMongoDB(
      "a.customer.com", b64("C"), b64("CH"), b64("FULL-A"), b64("PK"), "server-a"
    ),
    certSync.uploadCertificateToMongoDB(
      "b.customer.com", b64("C"), b64("CH"), b64("FULL-B"), b64("PK"), "server-b"
    ),
  ]);

  expect(a.version).toBe(1);
  expect(b.version).toBe(1);

  // A third server reconciles and must end up able to serve BOTH domains.
  const stats = await certSync.syncAllCertificatesToDisk();
  expect(stats.synced.sort()).toEqual(["a.customer.com", "b.customer.com"]);
  expect(await readFile(join(CERT_DIR_ROOT, "a.customer.com/fullchain.pem"), "utf8")).toBe("FULL-A");
  expect(await readFile(join(CERT_DIR_ROOT, "b.customer.com/fullchain.pem"), "utf8")).toBe("FULL-B");
});
