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
  // Security collections
  connectionLogs: Collection;
  blockedIps: Collection;
  ipAllowlists: Collection;
  // Distributed state collections (multi-server)
  agentConnections: Collection; // Active WebSocket connections registry
  tcpPortAllocations: Collection; // Distributed TCP port allocation
  rateLimits: Collection; // Distributed rate limiting
  bandwidthUsage: Collection; // Distributed bandwidth tracking
  serverHeartbeats: Collection; // Server health tracking
  // Multi-agent load balancing collections
  agentGroups: Collection; // Agent groups for load balancing
  agentGroupMembers: Collection; // Individual agent memberships in groups
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
      // Security collections
      connectionLogs: db.collection("connectionLogs"),
      blockedIps: db.collection("blockedIps"),
      ipAllowlists: db.collection("ipAllowlists"),
      // Distributed state collections (multi-server)
      agentConnections: db.collection("agentConnections"),
      tcpPortAllocations: db.collection("tcpPortAllocations"),
      rateLimits: db.collection("rateLimits"),
      bandwidthUsage: db.collection("bandwidthUsage"),
      serverHeartbeats: db.collection("serverHeartbeats"),
      // Multi-agent load balancing collections
      agentGroups: db.collection("agentGroups"),
      agentGroupMembers: db.collection("agentGroupMembers"),
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

  // Security indexes
  await createSecurityIndexes();
}

async function createSecurityIndexes(): Promise<void> {
  // Connection logs indexes (only if logging is enabled)
  if (process.env.ENABLE_CONNECTION_LOGS === 'true') {
    await collections.connectionLogs.createIndex({ tunnelId: 1, timestamp: -1 });
    await collections.connectionLogs.createIndex({ organizationId: 1, timestamp: -1 });
    await collections.connectionLogs.createIndex({ remoteIp: 1, timestamp: -1 });
    await collections.connectionLogs.createIndex({ status: 1 });
    await collections.connectionLogs.createIndex({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // 30 days TTL
    console.log('✅ Connection logs indexes created (logging enabled)');
  } else {
    console.log('⏭️  Connection logs indexes skipped (logging disabled via ENABLE_CONNECTION_LOGS)');
  }

  // Blocked IPs indexes
  await collections.blockedIps.createIndex({ ip: 1 }, { unique: true });
  await collections.blockedIps.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // IP Allowlists indexes
  await collections.ipAllowlists.createIndex({ tunnelId: 1 }, { unique: true });

  console.log("✅ Security database indexes created");

  // Create distributed state indexes
  await createDistributedStateIndexes();
}

// Helper to safely create an index, dropping conflicting ones first
async function safeCreateIndex(
  collection: Collection,
  indexSpec: Record<string, number>,
  options?: { unique?: boolean; expireAfterSeconds?: number; sparse?: boolean }
): Promise<void> {
  try {
    await collection.createIndex(indexSpec, options);
  } catch (error: any) {
    // IndexOptionsConflict (code 85) - drop and recreate
    if (error.code === 85) {
      const indexName = Object.keys(indexSpec).join("_") + "_" + Object.values(indexSpec).join("_");
      try {
        await collection.dropIndex(indexName);
      } catch {
        // Index might have a different name, try to find and drop it
        const indexes = await collection.indexes();
        for (const idx of indexes) {
          if (JSON.stringify(idx.key) === JSON.stringify(indexSpec)) {
            await collection.dropIndex(idx.name!);
            break;
          }
        }
      }
      await collection.createIndex(indexSpec, options);
    } else {
      throw error;
    }
  }
}

export async function createDistributedStateIndexes(): Promise<void> {
  // Agent connections - distributed WebSocket registry
  await safeCreateIndex(collections.agentConnections, { agentId: 1 }, { unique: true });
  
  // MIGRATION: Drop old domain-only unique index if it exists (was blocking multi-agent mode)
  try {
    await collections.agentConnections.dropIndex("domain_1");
    console.log("🔄 Dropped old domain_1 index for multi-agent support");
  } catch {
    // Index doesn't exist, that's fine
  }
  
  // NOTE: We use domain + instanceId as unique key to support multi-agent groups
  // Single agents use their agentId as instanceId, group agents use provided instanceId
  await safeCreateIndex(collections.agentConnections, { domain: 1, instanceId: 1 }, { unique: true });
  // Non-unique domain index for fast lookups
  await safeCreateIndex(collections.agentConnections, { domain: 1 });
  await safeCreateIndex(collections.agentConnections, { serverId: 1 });
  await safeCreateIndex(collections.agentConnections, { organizationId: 1 });
  // Auto-expire stale connections after 2 minutes of no heartbeat
  await safeCreateIndex(collections.agentConnections, { lastHeartbeat: 1 }, { expireAfterSeconds: 120 });

  // TCP port allocations - distributed port management
  await safeCreateIndex(collections.tcpPortAllocations, { port: 1, serverId: 1 }, { unique: true });
  await safeCreateIndex(collections.tcpPortAllocations, { tunnelId: 1 });
  await safeCreateIndex(collections.tcpPortAllocations, { agentId: 1 });
  await safeCreateIndex(collections.tcpPortAllocations, { serverId: 1 });
  await safeCreateIndex(collections.tcpPortAllocations, { active: 1 });

  // Distributed rate limits - sliding window counters
  await safeCreateIndex(collections.rateLimits, { key: 1 }, { unique: true });
  await safeCreateIndex(collections.rateLimits, { expiresAt: 1 }, { expireAfterSeconds: 0 });

  // Bandwidth usage tracking
  await safeCreateIndex(collections.bandwidthUsage, { tunnelId: 1, period: 1 }, { unique: true });
  await safeCreateIndex(collections.bandwidthUsage, { organizationId: 1, period: 1 });
  await safeCreateIndex(collections.bandwidthUsage, { period: 1 });

  // Server heartbeats for health monitoring
  await safeCreateIndex(collections.serverHeartbeats, { serverId: 1 }, { unique: true });
  // Auto-expire dead servers after 1 minute
  await safeCreateIndex(collections.serverHeartbeats, { lastHeartbeat: 1 }, { expireAfterSeconds: 60 });

  // Agent groups for multi-agent load balancing
  await safeCreateIndex(collections.agentGroups, { id: 1 }, { unique: true });
  await safeCreateIndex(collections.agentGroups, { domain: 1 }, { unique: true });
  await safeCreateIndex(collections.agentGroups, { organizationId: 1 });

  // Agent group members - track individual agents in groups
  // MIGRATION: Drop old agentId-only unique index
  try {
    await collections.agentGroupMembers.dropIndex("agentId_1");
    console.log("🔄 Dropped old agentId_1 index for agentGroupMembers");
  } catch {
    // Index doesn't exist, that's fine
  }
  // Unique by groupId + instanceId (instanceId stays consistent across reconnections)
  await safeCreateIndex(collections.agentGroupMembers, { groupId: 1, instanceId: 1 }, { unique: true });
  await safeCreateIndex(collections.agentGroupMembers, { agentId: 1 });
  await safeCreateIndex(collections.agentGroupMembers, { groupId: 1, healthy: 1 });

  console.log("✅ Distributed state indexes created");
}

/**
 * Clean up stale connections from this server on startup
 * This prevents duplicate key errors when the server restarts
 */
export async function cleanupStaleConnectionsOnStartup(): Promise<void> {
  const serverId = process.env.SERVER_ID || "default";
  
  try {
    // Remove all agent connections from this server (they're stale after restart)
    const connResult = await collections.agentConnections.deleteMany({ serverId });
    if (connResult.deletedCount > 0) {
      console.log(`🧹 Cleaned up ${connResult.deletedCount} stale agent connections from server ${serverId}`);
    }
    
    // Clean up stale group members (agents that were on this server)
    // We find all connections that were on this server and remove their group memberships
    const membersResult = await collections.agentGroupMembers.deleteMany({});
    if (membersResult.deletedCount > 0) {
      console.log(`🧹 Cleaned up ${membersResult.deletedCount} stale group members`);
    }
    
    // Clean up empty groups (groups with no active members)
    const emptyGroups = await collections.agentGroups.deleteMany({ activeAgentCount: { $lte: 0 } });
    if (emptyGroups.deletedCount > 0) {
      console.log(`🧹 Cleaned up ${emptyGroups.deletedCount} empty agent groups`);
    }
    
    // Reset agent counts on remaining groups
    await collections.agentGroups.updateMany({}, { $set: { activeAgentCount: 0, agentIds: [] } });
    
  } catch (error) {
    console.error("⚠️ Error cleaning up stale connections:", error);
  }
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
