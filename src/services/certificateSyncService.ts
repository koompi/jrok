import * as db from "../utils/database";
import { getDb } from "../utils/mongodb";
import * as notificationService from "./notificationService";
import { matchBaseDomain } from "../utils/baseDomains";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * MongoDB-based certificate sync service
 * Replaces SCP with MongoDB storage + HTTP API
 * Supports multiple control servers with leader election
 */

const LEADER_LEASE_DURATION = 30000; // 30 seconds
const LEADER_CHECK_INTERVAL = 10000; // 10 seconds

interface LeaderLease {
  _id: string;
  leader: string;
  leaseExpiry: Date;
  updatedAt: Date;
}

interface CertificateRecord {
  _id: string;
  domain: string;
  cert: string; // base64
  chain: string; // base64
  fullchain: string; // base64
  privkey: string; // base64
  expiry: Date;
  uploadedAt: Date;
  uploadedBy: string;
  version: number;
  status: "valid" | "expired" | "expiring";
}

// =============================================================================
// PRIVATE KEYS AT REST
// =============================================================================
// Anyone who could read MongoDB (its URI is on every edge, the DNS checkers and
// the deploy machine) could read every customer's certificate private key and
// the platform wildcard's. With JROK_CERT_KEY set (the same on every edge, at
// least 32 characters: `openssl rand -hex 32`; Ansible puts it in
// /etc/jrok/jrok.env), each private key is stored encrypted: AES-256-GCM, bound
// to its domain so a record's key can't be moved to another. Records stored
// before (base64 PEM) are still read, and encrypted at startup.

const SEALED_PREFIX = "jrok-enc:v1:";

let shortKeyWarned = false;

/** The key private keys are encrypted with, or null when JROK_CERT_KEY is unset (or too short). */
function certificateKey(): Buffer | null {
  const secret = process.env.JROK_CERT_KEY?.trim();
  if (!secret) return null;
  if (secret.length < 32) {
    if (!shortKeyWarned) console.error("❌ JROK_CERT_KEY is shorter than 32 characters: certificate private keys are NOT encrypted. Use `openssl rand -hex 32`.");
    shortKeyWarned = true;
    return null;
  }
  return createHash("sha256").update(secret).digest();
}

/** Is this stored private key encrypted? */
export function isSealedPrivateKey(stored: unknown): boolean {
  return typeof stored === "string" && stored.startsWith(SEALED_PREFIX);
}

/** A private key (base64 PEM) as it is stored: encrypted when there is a key. */
export function sealPrivateKey(domain: string, privkeyBase64: string, key: Buffer | null = certificateKey()): string {
  if (!key || isSealedPrivateKey(privkeyBase64)) return privkeyBase64;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(domain));
  const sealed = Buffer.concat([cipher.update(Buffer.from(privkeyBase64, "base64")), cipher.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
}

/** A stored private key as base64 PEM; null when it is encrypted and this server can't open it. */
export function openPrivateKey(domain: string, stored: string, key: Buffer | null = certificateKey()): string | null {
  if (!isSealedPrivateKey(stored)) return stored;
  if (!key) return null;
  try {
    const raw = Buffer.from(stored.slice(SEALED_PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(domain));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("base64");
  } catch {
    return null;
  }
}

/**
 * Encrypt every private key still stored as plain base64 (records from before
 * JROK_CERT_KEY, or from an edge without it). Each record is changed only if
 * nobody changed it meanwhile; its version stays, so no edge pulls it again.
 */
export async function sealStoredPrivateKeys(): Promise<number> {
  const key = certificateKey();
  const certs = getDb()?.collection<CertificateRecord>("certificates");
  if (!key || !certs) return 0;
  let sealed = 0;
  const plain = await certs.find({ privkey: { $not: /^jrok-enc:v1:/ } }, { projection: { privkey: 1 } }).toArray();
  for (const record of plain) {
    if (typeof record.privkey !== "string" || !record.privkey) continue;
    const result = await certs.updateOne(
      { _id: record._id, privkey: record.privkey },
      { $set: { privkey: sealPrivateKey(record._id, record.privkey, key) } }
    );
    sealed += result.modifiedCount;
  }
  if (sealed > 0) console.log(`🔐 Encrypted ${sealed} certificate private key(s) stored in MongoDB`);
  return sealed;
}

/**
 * Read the document out of a findOneAndUpdate result.
 *
 * The MongoDB Node driver changed this shape in v6: `includeResultMetadata`
 * now defaults to false, so findOneAndUpdate returns the DOCUMENT directly
 * instead of a `{ value, lastErrorObject, ok }` wrapper. Every call site here
 * still read `result.value`, which is `undefined` under v6 — so leader
 * election silently never succeeded and no certificate was ever uploaded.
 *
 * This helper accepts both shapes so the code is correct on either driver
 * version, and so a future driver bump can't quietly break sync again.
 */
function unwrapUpdateResult<T>(result: any): T | null {
  if (!result) return null;
  // v5 and earlier: { value: doc | null, lastErrorObject, ok }
  if (typeof result === "object" && "value" in result && "ok" in result) {
    return (result.value as T) ?? null;
  }
  // v6+: the document itself
  return result as T;
}

/**
 * Attempt to become leader for certificate renewal
 * Uses MongoDB atomic operations for distributed consensus
 *
 * NOTE: nothing calls this today, and that is deliberate. It used to gate
 * certificate UPLOADS, which was wrong — the server that issued a certificate
 * holds the only copy, so a server that lost the lease race silently dropped
 * it and no peer could ever serve that domain. Uploads are keyed by domain and
 * safe to run concurrently, so they are unconditional now (see
 * domainService.publishCertificateToMongoDB).
 *
 * Kept because it is the right tool for a job jrok does not do yet: if renewal
 * ever moves from each machine's certbot timer into a jrok-driven loop, exactly
 * one server must run it or Let's Encrypt rate limits will bite. Serving
 * traffic needs no leader — the servers are peers behind round-robin DNS.
 */
export async function attemptBecomeLeader(serverId: string): Promise<boolean> {
  try {
    const leases = getDb()?.collection<LeaderLease>("leader_leases");
    if (!leases) {
      console.error("❌ Database connection not available");
      return false;
    }

    const now = new Date();
    const leaseExpiry = new Date(now.getTime() + LEADER_LEASE_DURATION);

    // Atomic operation: Try to acquire or renew lease
    const result = await leases.findOneAndUpdate(
      {
        _id: "certificate-renewal-leader",
        $or: [
          { leaseExpiry: { $lt: now } }, // Lease expired
          { leader: serverId } // Already our lease
        ]
      },
      {
        $set: {
          leader: serverId,
          leaseExpiry,
          updatedAt: now,
          hostname: process.env.HOSTNAME || "unknown"
        }
      },
      { upsert: true, returnDocument: "after" }
    );

    const lease = unwrapUpdateResult<LeaderLease>(result);
    const isLeader = lease?.leader === serverId;

    if (isLeader) {
      console.log(`✅ ${serverId} acquired leader lease`);
    }

    return isLeader;
  } catch (error) {
    console.error("❌ Leader election failed:", error);
    return false;
  }
}

/**
 * Refresh leader lease to prevent timeout
 */
export async function refreshLeaderLease(serverId: string): Promise<boolean> {
  try {
    const leases = getDb()?.collection<LeaderLease>("leader_leases");
    if (!leases) return false;

    const now = new Date();
    const leaseExpiry = new Date(now.getTime() + LEADER_LEASE_DURATION);

    const result = await leases.findOneAndUpdate(
      { _id: "certificate-renewal-leader", leader: serverId },
      {
        $set: {
          leaseExpiry,
          updatedAt: now
        }
      },
      { returnDocument: "after" }
    );

    return unwrapUpdateResult<LeaderLease>(result)?.leader === serverId;
  } catch (error) {
    console.error("❌ Failed to refresh leader lease:", error);
    return false;
  }
}

/**
 * Upload certificate to MongoDB (called by leader only)
 * Stores base64-encoded certificate files
 */
export async function uploadCertificateToMongoDB(
  domain: string,
  certPem: string,
  chainPem: string,
  fullchainPem: string,
  privkeyPem: string,
  uploadedBy: string
): Promise<CertificateRecord> {
  try {
    const certs = getDb()?.collection<CertificateRecord>("certificates");
    if (!certs) {
      throw new Error("Database connection not available");
    }

    // Extract expiry from certificate
    const expiry = extractCertificateExpiry(fullchainPem);

    const now = new Date();

    // NOTE: `version` is deliberately NOT part of this object. MongoDB rejects
    // an update that touches the same path in both $set and $inc ("Updating
    // the path 'version' would create a conflict at 'version'"), so including
    // it here made every upload throw. $inc alone both creates the field at 1
    // on insert and advances it on every later renewal — which is exactly the
    // monotonic counter other servers compare against to decide "is the copy
    // in MongoDB newer than what I have on disk?".
    const fields = {
      _id: domain,
      domain,
      cert: certPem,
      chain: chainPem,
      fullchain: fullchainPem,
      privkey: sealPrivateKey(domain, privkeyPem),
      expiry,
      uploadedBy,
      status: calculateCertStatus(expiry)
    };

    // Upsert with atomic increment
    const result = await certs.findOneAndUpdate(
      { _id: domain },
      {
        $set: {
          ...fields,
          updatedAt: now
        },
        $inc: { version: 1 },
        // MongoDB's clock, so other servers can tell what is new
        // (syncIfNewCertificates) whatever this server's clock says.
        $currentDate: { uploadedAt: true }
      },
      { upsert: true, returnDocument: "after" }
    );

    const saved = unwrapUpdateResult<CertificateRecord>(result);
    if (!saved) {
      throw new Error("Failed to save certificate to MongoDB");
    }

    console.log(`✅ Certificate uploaded to MongoDB: ${domain} (v${saved.version})`);

    // Notify all VPS servers to sync
    await notifyVpsServersToSync(domain, saved.version);

    return { ...saved, privkey: privkeyPem };
  } catch (error) {
    console.error(`❌ Failed to upload certificate for ${domain}:`, error);
    throw error;
  }
}

/**
 * Download certificate from MongoDB (called by VPS servers)
 */
export async function downloadCertificateFromMongoDB(domain: string): Promise<CertificateRecord | null> {
  try {
    const certs = getDb()?.collection<CertificateRecord>("certificates");
    if (!certs) {
      throw new Error("Database connection not available");
    }

    const cert = await certs.findOne({ _id: domain });
    if (!cert) return null;
    // Callers get the private key as base64 PEM, whichever way it is stored.
    const privkey = typeof cert.privkey === "string" ? openPrivateKey(cert._id, cert.privkey) : null;
    if (privkey === null) {
      console.error(
        `❌ ${domain}: its private key in MongoDB can't be read on this server (JROK_CERT_KEY missing or not the other edges'); ` +
        `the certificate on disk is kept. Set the same JROK_CERT_KEY on every edge.`
      );
      return null;
    }
    return { ...cert, privkey };
  } catch (error) {
    console.error(`❌ Failed to download certificate for ${domain}:`, error);
    return null;
  }
}

/**
 * Get certificate status
 */
export async function getCertificateStatus(domain: string): Promise<{
  domain: string;
  expiry: Date | null;
  daysRemaining: number;
  status: "valid" | "expired" | "expiring" | "not-found";
  version: number;
  lastUpdated: Date | null;
} | null> {
  try {
    const certs = getDb()?.collection<CertificateRecord>("certificates");
    if (!certs) return null;

    const cert = await certs.findOne({ _id: domain });
    if (!cert) {
      return {
        domain,
        expiry: null,
        daysRemaining: 0,
        status: "not-found",
        version: 0,
        lastUpdated: null
      };
    }

    const daysRemaining = Math.floor(
      (cert.expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    return {
      domain: cert.domain,
      expiry: cert.expiry,
      daysRemaining,
      status: cert.status,
      version: cert.version,
      lastUpdated: cert.uploadedAt
    };
  } catch (error) {
    console.error(`❌ Failed to get certificate status for ${domain}:`, error);
    return null;
  }
}

/**
 * List all certificates
 */
export async function listCertificates(): Promise<Array<{
  domain: string;
  expiry: Date;
  daysRemaining: number;
  status: string;
  version: number;
  lastUpdated: Date;
}>> {
  try {
    const certs = getDb()?.collection<CertificateRecord>("certificates");
    if (!certs) return [];

    const certificates = await certs.find({}).toArray();

    return certificates.map(cert => ({
      domain: cert.domain,
      expiry: cert.expiry,
      daysRemaining: Math.floor(
        (cert.expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      ),
      status: cert.status,
      version: cert.version,
      lastUpdated: cert.uploadedAt
    }));
  } catch (error) {
    console.error("❌ Failed to list certificates:", error);
    return [];
  }
}

/**
 * Notify VPS servers to sync certificates (via database flag)
 */
async function notifyVpsServersToSync(domain: string, version: number): Promise<void> {
  try {
    const syncQueue = getDb()?.collection("cert_sync_queue");
    if (!syncQueue) return;

    await syncQueue.insertOne({
      _id: `${domain}-${version}`,
      domain,
      version,
      createdAt: new Date(),
      processed: false
    });

    console.log(`📤 Queued sync notification for ${domain} v${version}`);
  } catch (error) {
    console.error("❌ Failed to notify VPS servers:", error);
  }
}

/**
 * Extract certificate expiry date from PEM string
 */
function extractCertificateExpiry(fullchainPem: string): Date {
  try {
    // This would need openssl to parse properly
    // For now, assume 90 days (Let's Encrypt default)
    // In production, use: openssl x509 -enddate -noout
    const expiryMs = Date.now() + 90 * 24 * 60 * 60 * 1000;
    return new Date(expiryMs);
  } catch (error) {
    console.error("❌ Failed to extract certificate expiry:", error);
    return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  }
}

/**
 * Calculate certificate status
 */
function calculateCertStatus(expiry: Date): "valid" | "expired" | "expiring" {
  const now = Date.now();
  const expiryTime = expiry.getTime();
  const daysRemaining = (expiryTime - now) / (1000 * 60 * 60 * 24);

  if (daysRemaining < 0) return "expired";
  if (daysRemaining < 14) return "expiring"; // Alert if < 2 weeks
  return "valid";
}

// =============================================================================
// FULL CERTIFICATE RECONCILIATION
// =============================================================================
// The original sync was driven purely by the cert_sync_queue collection, which
// carries a 24-hour TTL index. That works for "a cert was just renewed, tell
// everyone", but it cannot bootstrap: a server added to the cluster today sees
// only the notifications from the last 24 hours, so EVERY custom domain issued
// before that is missing its certificate — and TLS fails for those domains on
// the new box while working fine on the old one.
//
// This reconciler asks the opposite question — "what does MongoDB hold that I
// don't?" — which is answerable at any time, by a server of any age. It runs on
// startup and on a timer, and is idempotent: with nothing new it does no writes
// and no nginx reload.
//
// Safety rules, in priority order, because a wrong write here takes a live
// domain offline:
//   1. Never downgrade. A local certificate is replaced only when the copy in
//      MongoDB is provably newer. When that can't be proven, skip and log.
//   2. Never clobber a hand-edited vhost. A missing vhost is written; an
//      existing one is replaced only when it is still exactly what an older
//      jrok template produced (utils/nginxConfig.ts, vhostNeedsUpgrade).
//      Anything else is left exactly as it is.
//   3. Never reload nginx on a config that fails `nginx -t`, and put back every
//      config file this run wrote, so a bad template can't linger on disk and
//      break the next reload.
//   4. Never throw. Certificate sync failing must not take the process down —
//      it fronts every tunnel on this server.

/** Resolved at call time, not module load, so import order can't change it. */
function certLivePath(): string {
  return process.env.CERT_LIVE_PATH || "/etc/letsencrypt/live";
}

/** Records which MongoDB version of a cert this server last wrote to disk. */
const SYNC_MARKER_FILE = ".jrok-sync-version";

interface ReconcileStats {
  synced: string[];
  skipped: number;
  failed: string[];
  /** Custom domains whose vhost was replaced with the current template. */
  upgraded: string[];
}

/**
 * Config files one reconcile run wrote, each mapped to what was there before
 * (null when the file didn't exist), so the run can be undone if `nginx -t`
 * rejects the result.
 */
type ConfigChanges = Map<string, string | null>;

async function writeConfigFile(changes: ConfigChanges, path: string, content: string): Promise<void> {
  const { readFile, writeFile } = await import("fs/promises");
  if (!changes.has(path)) {
    changes.set(path, await readFile(path, "utf8").catch(() => null));
  }
  await writeFile(path, content);
}

async function rollBackConfigChanges(changes: ConfigChanges): Promise<void> {
  const { writeFile, rm } = await import("fs/promises");
  for (const [path, previous] of changes) {
    try {
      if (previous === null) {
        await rm(path, { force: true });
      } else {
        await writeFile(path, previous);
      }
    } catch (error) {
      console.error(`❌ Could not roll back ${path}:`, error);
    }
  }
}

/**
 * Domain names come out of MongoDB and are interpolated into filesystem paths
 * and nginx configs, so they are validated here even though they were also
 * validated on the way in. Returns null for anything unsafe.
 */
function safeDomainOrNull(domain: unknown): string | null {
  if (typeof domain !== "string") return null;
  const d = domain.toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(d)) return null;
  if (d.length > 253) return null;
  if (d.includes("..") || d.includes("/")) return null;
  return d;
}

/** True when this domain is a customer's own domain rather than one of ours. */
function isCustomDomain(domain: string): boolean {
  // Checked against every accepted base domain: after a rename, a legacy
  // wildcard is still ours and must not be handed an auto-generated vhost.
  if (!process.env.BASE_DOMAIN) return false; // Can't tell — write nothing.
  return matchBaseDomain(domain) === null;
}

/**
 * Real notAfter date of a PEM certificate, via openssl.
 *
 * Only used to break a tie when a local certificate has no sync marker, so a
 * missing openssl means "cannot prove which is newer" — the caller then skips
 * rather than guessing, per safety rule 1.
 */
async function certNotAfter(pem: string): Promise<Date | null> {
  try {
    const proc = Bun.spawn(["openssl", "x509", "-enddate", "-noout"], {
      stdin: new TextEncoder().encode(pem),
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const match = out.match(/notAfter=(.+)/);
    if (!match?.[1]) return null;
    const parsed = new Date(match[1].trim());
    return isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

/** Version of the cert this server last synced for a domain, or null. */
async function readSyncMarker(certDir: string): Promise<number | null> {
  try {
    const { readFile } = await import("fs/promises");
    const raw = (await readFile(`${certDir}/${SYNC_MARKER_FILE}`, "utf8")).trim();
    const version = parseInt(raw, 10);
    return isNaN(version) ? null : version;
  } catch {
    return null;
  }
}

/**
 * Decide whether the MongoDB copy should replace what is on disk.
 *
 * Returns a reason string when it should be written, or null to skip.
 */
async function shouldWriteCertificate(
  certDir: string,
  cert: CertificateRecord
): Promise<string | null> {
  const { readFile } = await import("fs/promises");

  let localFullchain: string;
  try {
    localFullchain = await readFile(`${certDir}/fullchain.pem`, "utf8");
  } catch {
    return "no local certificate";
  }

  const marker = await readSyncMarker(certDir);
  if (marker !== null) {
    // This server wrote the local copy, so versions are directly comparable.
    return cert.version > marker ? `v${marker} -> v${cert.version}` : null;
  }

  // No marker: the local copy was issued here by certbot, or predates this
  // reconciler. Identical content needs no write — just record the version so
  // future runs take the cheap path above.
  const dbFullchain = Buffer.from(cert.fullchain, "base64").toString();
  if (dbFullchain === localFullchain) return null;

  // Different, and we have no version to compare. Only a provably later expiry
  // justifies overwriting a certificate that is currently serving traffic.
  const [localExpiry, dbExpiry] = await Promise.all([
    certNotAfter(localFullchain),
    certNotAfter(dbFullchain),
  ]);
  if (!localExpiry || !dbExpiry) {
    console.warn(
      `⚠️  ${cert.domain}: local cert differs from MongoDB but expiry could not be compared (openssl unavailable?) — leaving local copy untouched`
    );
    return null;
  }
  if (dbExpiry.getTime() > localExpiry.getTime()) {
    return `MongoDB copy expires later (${dbExpiry.toISOString()} > ${localExpiry.toISOString()})`;
  }
  return null;
}

/** Write the four PEM files plus the sync marker for one domain. */
async function writeCertificateFiles(certDir: string, cert: CertificateRecord): Promise<void> {
  const { writeFile, mkdir, chmod } = await import("fs/promises");
  await mkdir(certDir, { recursive: true });

  await writeFile(`${certDir}/cert.pem`, Buffer.from(cert.cert, "base64"));
  await writeFile(`${certDir}/chain.pem`, Buffer.from(cert.chain, "base64"));
  await writeFile(`${certDir}/fullchain.pem`, Buffer.from(cert.fullchain, "base64"));
  await writeFile(`${certDir}/privkey.pem`, Buffer.from(cert.privkey, "base64"));
  await chmod(`${certDir}/privkey.pem`, 0o600);

  // Written last: if anything above failed, the marker stays behind and the
  // next run retries rather than believing a half-written cert is current.
  await writeFile(`${certDir}/${SYNC_MARKER_FILE}`, String(cert.version));
}

/**
 * Ensure a custom domain has a current nginx vhost on this server.
 *
 * A missing vhost is created. An existing one is replaced only when it is
 * still exactly what an older jrok template produced; on the server that
 * originally issued the domain, domainService wrote it, and an operator may
 * since have edited it (production has vhosts proxying straight to a
 * customer's own server) — those are never touched.
 *
 * Returns what it did, recording every file it wrote in `changes`.
 */
async function ensureCustomDomainVhost(
  domain: string,
  certDir: string,
  changes: ConfigChanges
): Promise<"created" | "upgraded" | null> {
  const { readFile, mkdir } = await import("fs/promises");
  const { nginxSitesPath, nginxConfigFileName, generateCustomDomainNginxConfig, vhostNeedsUpgrade } =
    await import("../utils/nginxConfig");

  const sitesPath = nginxSitesPath();
  const configPath = `${sitesPath}/${nginxConfigFileName(domain)}`;
  const current = await readFile(configPath, "utf8").catch(() => null);

  const action = current === null ? "created" : vhostNeedsUpgrade(current, domain, certDir) ? "upgraded" : null;
  if (!action) return null;

  await mkdir(sitesPath, { recursive: true });

  // Current vhosts proxy to the shared upstream, so make sure it is there too.
  await refreshUpstreamFile(changes, { create: true });

  await writeConfigFile(changes, configPath, generateCustomDomainNginxConfig(domain, certDir));
  console.log(`✅ ${action === "created" ? "Created" : "Upgraded"} nginx vhost for custom domain: ${domain}`);
  return action;
}

/**
 * Bring the shared upstream file (custom-domain vhosts proxy to it) up to date,
 * at most once per run. Its peer list (JROK_PEERS) can change with no vhost
 * changing, so every run checks it.
 */
async function refreshUpstreamFile(changes: ConfigChanges, options: { create?: boolean } = {}): Promise<void> {
  const { readFile } = await import("fs/promises");
  const { nginxSitesPath, upstreamFileUpdate, JROK_UPSTREAM_FILE } = await import("../utils/nginxConfig");
  const upstreamPath = `${nginxSitesPath()}/${JROK_UPSTREAM_FILE}`;
  if (changes.has(upstreamPath)) return;
  const current = await readFile(upstreamPath, "utf8").catch(() => null);
  // Missing: written with the first custom-domain vhost (create), not before.
  if (current === null && !options.create) return;
  const update = upstreamFileUpdate(current);
  if (update !== null) await writeConfigFile(changes, upstreamPath, update);
}

export type NginxReloadResult = "reloaded" | "test-failed" | "reload-failed" | "unavailable";

/**
 * Validate and reload nginx. Does not reload when the config fails `nginx -t`,
 * so a bad config leaves the running server alone.
 *
 * NGINX_BIN, when set, replaces both `nginx -t` and the reload (as
 * `$NGINX_BIN -s reload`, skipping systemctl) — tests point it at a stand-in.
 */
export async function testAndReloadNginx(): Promise<NginxReloadResult> {
  const nginxBin = process.env.NGINX_BIN;

  try {
    const test = Bun.spawn([nginxBin || "nginx", "-t"], { stdout: "pipe", stderr: "pipe" });
    if ((await test.exited) !== 0) {
      const stderr = await new Response(test.stderr).text();
      console.error(`❌ nginx config test failed — NOT reloading. nginx is still serving the previous config:\n${stderr}`);
      return "test-failed";
    }

    if (!nginxBin) {
      const reload = Bun.spawn(["systemctl", "reload", "nginx"], { stdout: "ignore", stderr: "ignore" });
      if ((await reload.exited) === 0) {
        console.log("✅ nginx reloaded");
        return "reloaded";
      }
    }

    const fallback = Bun.spawn([nginxBin || "nginx", "-s", "reload"], { stdout: "ignore", stderr: "ignore" });
    if ((await fallback.exited) === 0) {
      console.log("✅ nginx reloaded (fallback)");
      return "reloaded";
    }

    console.error("❌ nginx reload failed — new certificates are on disk but not yet live");
    return "reload-failed";
  } catch (error) {
    // nginx absent (dev machine, container without it) — not an error worth noise.
    console.log(`ℹ️  Skipping nginx reload: ${error instanceof Error ? error.message : String(error)}`);
    return "unavailable";
  }
}

/**
 * Pull every certificate this server is missing or has an older copy of.
 *
 * Safe to call at any time, on any server, concurrently with certbot. Never
 * throws.
 */
export async function syncAllCertificatesToDisk(): Promise<ReconcileStats> {
  const stats: ReconcileStats = { synced: [], skipped: 0, failed: [], upgraded: [] };

  try {
    const certs = getDb()?.collection<CertificateRecord>("certificates");
    if (!certs) return stats;

    // Metadata first. The PEM bodies are only fetched for domains that actually
    // need writing, so the steady state (nothing changed) transfers almost
    // nothing even with thousands of domains.
    const summaries = await certs
      .find({}, { projection: { domain: 1, version: 1 } })
      .toArray();

    const configChanges: ConfigChanges = new Map();
    await refreshUpstreamFile(configChanges);
    const ensureVhost = async (domain: string, certDir: string) => {
      if ((await ensureCustomDomainVhost(domain, certDir, configChanges)) === "upgraded") {
        stats.upgraded.push(domain);
      }
    };

    for (const summary of summaries) {
      const domain = safeDomainOrNull(summary.domain ?? summary._id);
      if (!domain) {
        console.warn(`⚠️  Skipping certificate with unsafe domain name: ${String(summary._id)}`);
        continue;
      }

      const certDir = `${certLivePath()}/${domain}`;

      try {
        // Cheap pre-check: if the marker already matches, skip without
        // fetching the certificate body at all.
        const marker = await readSyncMarker(certDir);
        if (marker !== null && typeof summary.version === "number" && marker >= summary.version) {
          stats.skipped++;
          // Still make sure the vhost exists and is current — a cert can be in
          // sync while the nginx config is missing (exactly the state a new
          // server starts in) or from an older template.
          if (isCustomDomain(domain)) {
            await ensureVhost(domain, certDir);
          }
          continue;
        }

        const cert = await downloadCertificateFromMongoDB(domain);
        if (!cert) {
          stats.skipped++;
          continue;
        }

        const reason = await shouldWriteCertificate(certDir, cert);
        if (reason) {
          await writeCertificateFiles(certDir, cert);
          stats.synced.push(domain);
          console.log(`🔐 Synced certificate for ${domain} (${reason})`);
        } else {
          stats.skipped++;
        }

        if (isCustomDomain(domain)) {
          await ensureVhost(domain, certDir);
        }
      } catch (error) {
        stats.failed.push(domain);
        console.error(`❌ Failed to sync certificate for ${domain}:`, error);
      }
    }

    // One reload for the whole batch, and only when something actually changed.
    if (stats.synced.length > 0 || configChanges.size > 0) {
      if ((await testAndReloadNginx()) === "test-failed" && configChanges.size > 0) {
        await rollBackConfigChanges(configChanges);
        stats.upgraded = [];
        console.error(`↩️  Put back the ${configChanges.size} nginx config file(s) this run wrote; nginx was not reloaded`);
      }
    }

    if (stats.synced.length > 0 || stats.failed.length > 0 || stats.upgraded.length > 0) {
      console.log(
        `🔐 Certificate reconcile: ${stats.synced.length} synced, ${stats.skipped} already current, ` +
        `${stats.failed.length} failed, ${stats.upgraded.length} vhost(s) upgraded`
      );
    }
  } catch (error) {
    console.error("❌ Certificate reconciliation failed:", error);
  }

  return stats;
}

// One reconcile at a time on this server. A call while one runs starts
// another after it, so whatever prompted the call is always looked at.
let reconcileQueue: Promise<unknown> = Promise.resolve();

/** syncAllCertificatesToDisk, serialised. */
export function reconcileCertificates(): Promise<ReconcileStats> {
  const run = reconcileQueue.then(() => syncAllCertificatesToDisk());
  reconcileQueue = run.catch(() => {});
  return run;
}

let newestUploadSeen: Date | null = null;

/**
 * Reconcile now if a certificate was uploaded since the last look (one indexed
 * query). With several edges, a custom domain's new certificate exists only
 * on the edge that issued it until the others pull it; the 5-minute reconcile
 * left visitors DNS sent elsewhere with a certificate error for that long.
 * The first look only notes where things stand: startup reconciles anyway.
 */
export async function syncIfNewCertificates(): Promise<boolean> {
  const certs = getDb()?.collection<CertificateRecord>("certificates");
  if (!certs) return false;
  const newest = await certs.find({}, { projection: { uploadedAt: 1 } }).sort({ uploadedAt: -1 }).limit(1).next();
  const at = newest?.uploadedAt;
  if (!at) return false;
  const seen = newestUploadSeen;
  newestUploadSeen = at;
  if (seen === null || at <= seen) return false;
  await reconcileCertificates();
  return true;
}

/** Forget what syncIfNewCertificates has seen (tests). */
export function resetNewCertificateWatch(): void {
  newestUploadSeen = null;
}

/**
 * Initialize certificate sync infrastructure (runs on startup)
 */
export async function initializeCertificateSync(): Promise<void> {
  try {
    const db_instance = getDb();
    if (!db_instance) {
      console.error("❌ Database not connected");
      return;
    }

    // Create collections if they don't exist
    const collections = await db_instance.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);

    if (!collectionNames.includes("certificates")) {
      await db_instance.createCollection("certificates");
      console.log("✅ Created certificates collection");
    }

    if (!collectionNames.includes("leader_leases")) {
      await db_instance.createCollection("leader_leases");
      console.log("✅ Created leader_leases collection");
    }

    if (!collectionNames.includes("cert_sync_queue")) {
      await db_instance.createCollection("cert_sync_queue");
      console.log("✅ Created cert_sync_queue collection");
    }

    // Create indexes
    const certs = db_instance.collection("certificates");
    await certs.createIndex({ domain: 1 }, { unique: true });
    await certs.createIndex({ expiry: 1 });
    await certs.createIndex({ uploadedAt: -1 });

    const leases = db_instance.collection("leader_leases");
    await leases.createIndex({ leaseExpiry: 1 }, { expireAfterSeconds: 120 });

    const queue = db_instance.collection("cert_sync_queue");
    await queue.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });

    if (certificateKey()) {
      await sealStoredPrivateKeys();
    } else {
      console.warn("⚠️ JROK_CERT_KEY is not set: certificate private keys are stored in MongoDB unencrypted");
    }

    console.log("✅ Certificate sync infrastructure initialized");
  } catch (error) {
    console.error("❌ Failed to initialize certificate sync:", error);
  }
}
