import type { 
  ActivityLog, 
  ActivityLogFilters, 
  ActivityCategory, 
  ActivityAction,
  ListActivityResponse 
} from "../types/index";
import { generateId } from "../utils/helpers";
import { getDatabase } from "../utils/mongodb";

const COLLECTION_NAME = "activity_logs";

/**
 * Log an activity event
 */
export async function logActivity(params: {
  organizationId: string;
  userId?: string;
  category: ActivityCategory;
  action: ActivityAction;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}): Promise<ActivityLog> {
  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);
  const activity = activityRecord(params);
  await collection.insertOne(activity);
  return activity;
}

/** An activity entry as stored. */
function activityRecord(params: {
  organizationId: string;
  userId?: string;
  category: ActivityCategory;
  action: ActivityAction;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}): ActivityLog {
  const activity: ActivityLog = {
    id: generateId(),
    organizationId: params.organizationId,
    userId: params.userId,
    category: params.category,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    resourceName: params.resourceName,
    description: params.description,
    metadata: params.metadata,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    createdAt: Date.now(),
  };
  return activity;
}

/**
 * Get activity logs with filters
 */
export async function getActivityLogs(filters: ActivityLogFilters): Promise<ListActivityResponse> {
  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);

  const query: Record<string, unknown> = {
    organizationId: filters.organizationId,
  };

  if (filters.category) {
    query.category = filters.category;
  }

  if (filters.action) {
    query.action = filters.action;
  }

  if (filters.startDate || filters.endDate) {
    query.createdAt = {};
    if (filters.startDate) {
      (query.createdAt as Record<string, number>).$gte = filters.startDate;
    }
    if (filters.endDate) {
      (query.createdAt as Record<string, number>).$lte = filters.endDate;
    }
  }

  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const [activities, total] = await Promise.all([
    collection
      .find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray(),
    collection.countDocuments(query),
  ]);

  return {
    success: true,
    activities: activities as unknown as ActivityLog[],
    total,
    hasMore: offset + activities.length < total,
  };
}

/**
 * Get recent activity for an organization (last N items)
 */
export async function getRecentActivity(organizationId: string, limit: number = 10): Promise<ActivityLog[]> {
  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);

  const activities = await collection
    .find({ organizationId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  return activities as unknown as ActivityLog[];
}

/**
 * Get activity summary for dashboard
 */
export async function getActivitySummary(organizationId: string, days: number = 7): Promise<{
  totalActivities: number;
  byCategory: Record<ActivityCategory, number>;
  byAction: Record<ActivityAction, number>;
  recentActivity: ActivityLog[];
}> {
  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);

  const startDate = Date.now() - (days * 24 * 60 * 60 * 1000);
  const query = {
    organizationId,
    createdAt: { $gte: startDate },
  };

  const [totalActivities, categoryAggregation, actionAggregation, recentActivity] = await Promise.all([
    collection.countDocuments(query),
    collection.aggregate([
      { $match: query },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]).toArray(),
    collection.aggregate([
      { $match: query },
      { $group: { _id: "$action", count: { $sum: 1 } } },
    ]).toArray(),
    collection.find(query).sort({ createdAt: -1 }).limit(5).toArray(),
  ]);

  const byCategory = categoryAggregation.reduce((acc, item) => {
    acc[item._id as ActivityCategory] = item.count;
    return acc;
  }, {} as Record<ActivityCategory, number>);

  const byAction = actionAggregation.reduce((acc, item) => {
    acc[item._id as ActivityAction] = item.count;
    return acc;
  }, {} as Record<ActivityAction, number>);

  return {
    totalActivities,
    byCategory,
    byAction,
    recentActivity: recentActivity as unknown as ActivityLog[],
  };
}

/**
 * Delete old activity logs (for cleanup)
 */
export async function cleanupOldActivityLogs(olderThanDays: number = 90): Promise<number> {
  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);

  const cutoffDate = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
  const result = await collection.deleteMany({ createdAt: { $lt: cutoffDate } });

  return result.deletedCount;
}

// ============ Helper functions for common activity logging ============

export async function logTunnelCreated(orgId: string, userId: string | undefined, tunnelId: string, domain: string, ip?: string): Promise<void> {
  await logActivity({
    organizationId: orgId,
    userId,
    category: "tunnels",
    action: "created",
    resourceType: "tunnel",
    resourceId: tunnelId,
    resourceName: domain,
    description: `Tunnel created for ${domain}`,
    ipAddress: ip,
  });
}

export async function logTunnelDeleted(orgId: string, userId: string | undefined, tunnelId: string, domain: string, ip?: string): Promise<void> {
  await logActivity({
    organizationId: orgId,
    userId,
    category: "tunnels",
    action: "deleted",
    resourceType: "tunnel",
    resourceId: tunnelId,
    resourceName: domain,
    description: `Tunnel deleted: ${domain}`,
    ipAddress: ip,
  });
}

// Agents' connects and disconnects are written together: one insert per agent cost one of the ~100 operations
// a second the database gives each edge, in the bursts that need them most (an edge or a deploy server
// restarting reconnects every agent it had; KOOMPI Cloud's load test, 2026-11-13). Written every
// AGENT_LOG_FLUSH_MS or at AGENT_LOG_BATCH entries, and at shutdown (index.ts): a crash loses at most the
// last couple of seconds of them.
export const AGENT_LOG_FLUSH_MS = 2000;
export const AGENT_LOG_BATCH = 500;
let agentLogs: ActivityLog[] = [];
let agentLogTimer: ReturnType<typeof setTimeout> | null = null;

function queueAgentLog(params: Parameters<typeof logActivity>[0]): Promise<void> {
  agentLogs.push(activityRecord(params));
  if (agentLogs.length >= AGENT_LOG_BATCH) return flushAgentLogs();
  if (!agentLogTimer) {
    agentLogTimer = setTimeout(() => { void flushAgentLogs(); }, AGENT_LOG_FLUSH_MS);
    (agentLogTimer as { unref?: () => void }).unref?.();
  }
  return Promise.resolve();
}

/** Writes the agent connects and disconnects waiting, in one insert. Never throws. */
export async function flushAgentLogs(): Promise<void> {
  if (agentLogTimer) clearTimeout(agentLogTimer);
  agentLogTimer = null;
  const batch = agentLogs;
  agentLogs = [];
  if (!batch.length) return;
  try {
    const db = await getDatabase();
    await db.collection(COLLECTION_NAME).insertMany(batch, { ordered: false });
  } catch (error) {
    console.error(`Failed to write ${batch.length} agent activity entries:`, error);
  }
}

export async function logAgentConnected(orgId: string, agentId: string, domain: string, ip?: string): Promise<void> {
  await queueAgentLog({
    organizationId: orgId,
    category: "agents",
    action: "connected",
    resourceType: "agent",
    resourceId: agentId,
    resourceName: domain,
    description: `Agent connected from ${ip || 'unknown'}`,
    ipAddress: ip,
  });
}

export async function logAgentDisconnected(orgId: string, agentId: string, domain: string, ip?: string): Promise<void> {
  await queueAgentLog({
    organizationId: orgId,
    category: "agents",
    action: "disconnected",
    resourceType: "agent",
    resourceId: agentId,
    resourceName: domain,
    description: `Agent disconnected`,
    ipAddress: ip,
  });
}

export async function logDomainCreated(orgId: string, userId: string | undefined, domainId: string, domain: string, ip?: string): Promise<void> {
  await logActivity({
    organizationId: orgId,
    userId,
    category: "domains",
    action: "created",
    resourceType: "domain",
    resourceId: domainId,
    resourceName: domain,
    description: `Domain registered: ${domain}`,
    ipAddress: ip,
  });
}

export async function logDomainVerified(orgId: string, domainId: string, domain: string): Promise<void> {
  await logActivity({
    organizationId: orgId,
    category: "domains",
    action: "verified",
    resourceType: "domain",
    resourceId: domainId,
    resourceName: domain,
    description: `DNS verified for ${domain}`,
  });
}

export async function logCertificateRenewed(orgId: string, domainId: string, domain: string): Promise<void> {
  await logActivity({
    organizationId: orgId,
    category: "domains",
    action: "renewed",
    resourceType: "certificate",
    resourceId: domainId,
    resourceName: domain,
    description: `SSL certificate renewed for ${domain}`,
  });
}

export async function logApiKeyCreated(orgId: string, userId: string, keyId: string, keyName: string, ip?: string): Promise<void> {
  await logActivity({
    organizationId: orgId,
    userId,
    category: "api_keys",
    action: "created",
    resourceType: "api_key",
    resourceId: keyId,
    resourceName: keyName,
    description: `API key created: ${keyName}`,
    ipAddress: ip,
  });
}

export async function logApiKeyDeleted(orgId: string, userId: string, keyId: string, keyName: string, ip?: string): Promise<void> {
  await logActivity({
    organizationId: orgId,
    userId,
    category: "api_keys",
    action: "deleted",
    resourceType: "api_key",
    resourceId: keyId,
    resourceName: keyName,
    description: `API key revoked: ${keyName}`,
    ipAddress: ip,
  });
}

export async function logUserLogin(orgId: string, userId: string, email: string, ip?: string): Promise<void> {
  await logActivity({
    organizationId: orgId,
    userId,
    category: "auth",
    action: "login",
    resourceType: "user",
    resourceId: userId,
    resourceName: email,
    description: `User logged in: ${email}`,
    ipAddress: ip,
  });
}

export async function logOrganizationCreated(orgId: string, userId: string, orgName: string, ip?: string): Promise<void> {
  await logActivity({
    organizationId: orgId,
    userId,
    category: "organization",
    action: "created",
    resourceType: "organization",
    resourceId: orgId,
    resourceName: orgName,
    description: `Organization created: ${orgName}`,
    ipAddress: ip,
  });
}
