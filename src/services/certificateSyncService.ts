import * as db from "../utils/database";
import { getClient } from "../utils/mongodb";
import * as notificationService from "./notificationService";

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
 * Attempt to become leader for certificate renewal
 * Uses MongoDB atomic operations for distributed consensus
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

    const isLeader = result.value?.leader === serverId;
    
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

    return result.value?.leader === serverId;
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
    const record: CertificateRecord = {
      _id: domain,
      domain,
      cert: certPem,
      chain: chainPem,
      fullchain: fullchainPem,
      privkey: privkeyPem,
      expiry,
      uploadedAt: now,
      uploadedBy,
      version: 0,
      status: calculateCertStatus(expiry)
    };

    // Upsert with atomic increment
    const result = await certs.findOneAndUpdate(
      { _id: domain },
      {
        $set: {
          ...record,
          updatedAt: now
        },
        $inc: { version: 1 }
      },
      { upsert: true, returnDocument: "after" }
    );

    if (!result.value) {
      throw new Error("Failed to save certificate to MongoDB");
    }

    console.log(`✅ Certificate uploaded to MongoDB: ${domain} (v${result.value.version})`);

    // Notify all VPS servers to sync
    await notifyVpsServersToSync(domain, result.value.version);

    return result.value;
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
