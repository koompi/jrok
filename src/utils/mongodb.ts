import { MongoClient, Db, Collection } from "mongodb";

let db: Db;
let client: MongoClient;

export interface Collections {
  tunnels: Collection;
  agents: Collection;
  vpsServers: Collection;
  customDomains: Collection;
  auditLogs: Collection;
  // SaaS collections
  users: Collection;
  organizations: Collection;
  apiKeys: Collection;
  plans: Collection;
  subscriptions: Collection;
  usageRecords: Collection;
  sessions: Collection;
  settings: Collection;
}

let collections: Collections;

export async function connectDatabase(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/jrok";

  client = new MongoClient(mongoUri);

  try {
    await client.connect();
    db = client.db("jrok");

    // Initialize collections
    collections = {
      tunnels: db.collection("tunnels"),
      agents: db.collection("agents"),
      vpsServers: db.collection("vpsServers"),
      customDomains: db.collection("customDomains"),
      auditLogs: db.collection("auditLogs"),
      // SaaS collections
      users: db.collection("users"),
      organizations: db.collection("organizations"),
      apiKeys: db.collection("apiKeys"),
      plans: db.collection("plans"),
      subscriptions: db.collection("subscriptions"),
      usageRecords: db.collection("usageRecords"),
      sessions: db.collection("sessions"),
      settings: db.collection("settings"),
    };

    // Create indexes
    await createIndexes();
    await createSaaSIndexes();

    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ Failed to connect to MongoDB:", error);
    throw error;
  }
}

async function createIndexes(): Promise<void> {
  // Tunnels indexes
  await collections.tunnels.createIndex({ domain: 1, customDomain: 1 });
  await collections.tunnels.createIndex({ agentId: 1 });
  await collections.tunnels.createIndex({ active: 1 });
  await collections.tunnels.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // Agents indexes
  await collections.agents.createIndex({ domain: 1 }, { unique: true });
  await collections.agents.createIndex({ active: 1 });
  await collections.agents.createIndex({ lastHeartbeat: 1 });

  // VPS Servers indexes
  await collections.vpsServers.createIndex({ name: 1 }, { unique: true });
  await collections.vpsServers.createIndex({ healthy: 1 });

  // Custom Domains indexes
  await collections.customDomains.createIndex({ domain: 1 }, { unique: true });
  await collections.customDomains.createIndex({ active: 1 });
  await collections.customDomains.createIndex({ synced: 1 });
  await collections.customDomains.createIndex({ certExpiry: 1 });

  // Audit logs indexes
  await collections.auditLogs.createIndex({ createdAt: -1 });
  await collections.auditLogs.createIndex({ type: 1 });

  console.log("✅ Database indexes created");
}

async function createSaaSIndexes(): Promise<void> {
  // Users indexes
  await collections.users.createIndex({ koompId: 1 }, { unique: true });
  await collections.users.createIndex({ email: 1 }, { unique: true, sparse: true });
  await collections.users.createIndex({ role: 1 });
  await collections.users.createIndex({ isActive: 1 });

  // Organizations indexes
  await collections.organizations.createIndex({ slug: 1 }, { unique: true });
  await collections.organizations.createIndex({ ownerId: 1 });
  await collections.organizations.createIndex({ "members.userId": 1 });
  await collections.organizations.createIndex({ isActive: 1 });

  // API Keys indexes
  await collections.apiKeys.createIndex({ key: 1 }, { unique: true });
  await collections.apiKeys.createIndex({ keyPrefix: 1 });
  await collections.apiKeys.createIndex({ organizationId: 1 });
  await collections.apiKeys.createIndex({ isActive: 1 });
  await collections.apiKeys.createIndex({ expiresAt: 1 });

  // Plans indexes
  await collections.plans.createIndex({ tier: 1 });
  await collections.plans.createIndex({ isActive: 1 });

  // Subscriptions indexes
  await collections.subscriptions.createIndex({ organizationId: 1 }, { unique: true });
  await collections.subscriptions.createIndex({ planId: 1 });
  await collections.subscriptions.createIndex({ status: 1 });
  await collections.subscriptions.createIndex({ currentPeriodEnd: 1 });

  // Usage Records indexes
  await collections.usageRecords.createIndex({ organizationId: 1, period: 1 }, { unique: true });
  await collections.usageRecords.createIndex({ period: 1 });

  // Sessions indexes
  await collections.sessions.createIndex({ userId: 1 });
  await collections.sessions.createIndex({ token: 1 }, { unique: true });
  await collections.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  console.log("✅ SaaS database indexes created");
}

export function getCollections(): Collections {
  if (!collections) {
    throw new Error("Database not connected. Call connectDatabase() first.");
  }
  return collections;
}

export async function getDatabase(): Promise<Db> {
  if (!db) {
    throw new Error("Database not connected. Call connectDatabase() first.");
  }
  return db;
}

export function getClient(): MongoClient | null {
  return client || null;
}

export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
    console.log("✅ Closed MongoDB connection");
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    if (!db) return false;
    await db.admin().ping();
    return true;
  } catch {
    return false;
  }
}
