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

  await collection.insertOne(activity);
  
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

export async function logAgentConnected(orgId: string, agentId: string, domain: string, ip?: string): Promise<void> {
  await logActivity({
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
  await logActivity({
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
