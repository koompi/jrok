import * as db from "../utils/database";
import { getClient } from "../utils/mongodb";
import * as notificationService from "./notificationService";
import { matchBaseDomain } from "../utils/baseDomains";

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
    const client = getClient();
    const leases = client?.db("jrok").collection<LeaderLease>("leader_leases");
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
    const leases = getClient()?.db("jrok").collection<LeaderLease>("leader_leases");
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
    const certs = getClient()?.db("jrok").collection<CertificateRecord>("certificates");
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
      privkey: privkeyPem,
      expiry,
      uploadedAt: now,
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
        $inc: { version: 1 }
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

    return saved;
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
    const certs = getClient()?.db("jrok").collection<CertificateRecord>("certificates");
    if (!certs) {
      throw new Error("Database connection not available");
    }

    const cert = await certs.findOne({ _id: domain });
    return cert || null;
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
    const certs = getClient()?.db("jrok").collection<CertificateRecord>("certificates");
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
    const certs = getClient()?.db("jrok").collection<CertificateRecord>("certificates");
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
    const syncQueue = getClient()?.db("jrok").collection("cert_sync_queue");
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
//   2. Never clobber an existing vhost. A missing vhost is written; an existing
//      one is left exactly as it is (it may have been hand-tuned).
//   3. Never reload nginx on a config that fails `nginx -t`.
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
 * Ensure a custom domain has an nginx vhost on this server.
 *
 * Returns true if a config was created. An existing file is never modified —
 * on the server that originally issued the domain, domainService already wrote
 * one, and it may since have been edited by hand.
 */
async function ensureCustomDomainVhost(domain: string, certDir: string): Promise<boolean> {
  const { writeFile, mkdir, access } = await import("fs/promises");
  const { nginxSitesPath, nginxConfigFileName, generateCustomDomainNginxConfig } =
    await import("../utils/nginxConfig");

  const sitesPath = nginxSitesPath();
  const configPath = `${sitesPath}/${nginxConfigFileName(domain)}`;
  try {
    await access(configPath);
    return false; // Already present — leave it alone.
  } catch {
    // Not present; fall through and create it.
  }

  await mkdir(sitesPath, { recursive: true });
  await writeFile(configPath, generateCustomDomainNginxConfig(domain, certDir));
  console.log(`✅ Created nginx vhost for custom domain: ${domain}`);
  return true;
}

/**
 * Validate and reload nginx. Returns false (without reloading) if the config
 * does not pass `nginx -t`, so a bad config leaves the running server alone.
 */
async function testAndReloadNginx(): Promise<boolean> {
  try {
    const test = Bun.spawn(["nginx", "-t"], { stdout: "pipe", stderr: "pipe" });
    if ((await test.exited) !== 0) {
      const stderr = await new Response(test.stderr).text();
      console.error(`❌ nginx config test failed — NOT reloading. nginx is still serving the previous config:\n${stderr}`);
      return false;
    }

    const reload = Bun.spawn(["systemctl", "reload", "nginx"], { stdout: "ignore", stderr: "ignore" });
    if ((await reload.exited) === 0) {
      console.log("✅ nginx reloaded");
      return true;
    }

    const fallback = Bun.spawn(["nginx", "-s", "reload"], { stdout: "ignore", stderr: "ignore" });
    if ((await fallback.exited) === 0) {
      console.log("✅ nginx reloaded (fallback)");
      return true;
    }

    console.error("❌ nginx reload failed — new certificates are on disk but not yet live");
    return false;
  } catch (error) {
    // nginx absent (dev machine, container without it) — not an error worth noise.
    console.log(`ℹ️  Skipping nginx reload: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Pull every certificate this server is missing or has an older copy of.
 *
 * Safe to call at any time, on any server, concurrently with certbot. Never
 * throws.
 */
export async function syncAllCertificatesToDisk(): Promise<ReconcileStats> {
  const stats: ReconcileStats = { synced: [], skipped: 0, failed: [] };

  try {
    const certs = getClient()?.db("jrok").collection<CertificateRecord>("certificates");
    if (!certs) return stats;

    // Metadata first. The PEM bodies are only fetched for domains that actually
    // need writing, so the steady state (nothing changed) transfers almost
    // nothing even with thousands of domains.
    const summaries = await certs
      .find({}, { projection: { domain: 1, version: 1 } })
      .toArray();

    let vhostCreated = false;

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
          // Still make sure the vhost exists — a cert can be in sync while the
          // nginx config is missing (exactly the state a new server starts in).
          if (isCustomDomain(domain)) {
            vhostCreated = (await ensureCustomDomainVhost(domain, certDir)) || vhostCreated;
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
          vhostCreated = (await ensureCustomDomainVhost(domain, certDir)) || vhostCreated;
        }
      } catch (error) {
        stats.failed.push(domain);
        console.error(`❌ Failed to sync certificate for ${domain}:`, error);
      }
    }

    // One reload for the whole batch, and only when something actually changed.
    if (stats.synced.length > 0 || vhostCreated) {
      await testAndReloadNginx();
    }

    if (stats.synced.length > 0 || stats.failed.length > 0) {
      console.log(
        `🔐 Certificate reconcile: ${stats.synced.length} synced, ${stats.skipped} already current, ${stats.failed.length} failed`
      );
    }
  } catch (error) {
    console.error("❌ Certificate reconciliation failed:", error);
  }

  return stats;
}

/**
 * Initialize certificate sync infrastructure (runs on startup)
 */
export async function initializeCertificateSync(): Promise<void> {
  try {
    const db_client = getClient();
    if (!db_client) {
      console.error("❌ Database not connected");
      return;
    }

    const db_instance = db_client.db("jrok");

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

    console.log("✅ Certificate sync infrastructure initialized");
  } catch (error) {
    console.error("❌ Failed to initialize certificate sync:", error);
  }
}
