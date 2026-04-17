import type { 
  DashboardStats, 
  BandwidthRecord, 
  EnhancedTunnel, 
  EnhancedAgent, 
  EnhancedDomain,
  PlanTier 
} from "../types/index";
import { generateId } from "../utils/helpers";
import { getDatabase } from "../utils/mongodb";
import * as agentService from "./agentService";

const BANDWIDTH_COLLECTION = "bandwidth_records";
const TUNNEL_STATS_COLLECTION = "tunnel_stats";

// In-memory stats for real-time tracking (persisted periodically)
const realtimeStats = new Map<string, {
  bytesIn: number;
  bytesOut: number;
  requests: number;
  lastUpdated: number;
}>();

// Pending flush metadata: key → hour bucket + agentId for the next DB write
const pendingFlushMeta = new Map<string, {
  organizationId: string;
  tunnelId?: string;
  agentId?: string;
  hourKey: string;
}>();

/**
 * Record bandwidth usage for a tunnel/agent.
 * Accumulates in-memory and flushes to MongoDB in a background batch every 30 seconds.
 * This reduces MongoDB writes by up to 1000x at high traffic.
 */
export function recordBandwidth(params: {
  organizationId: string;
  tunnelId?: string;
  agentId?: string;
  bytesIn: number;
  bytesOut: number;
  requests?: number;
}): Promise<void> {
  const key = `${params.organizationId}:${params.tunnelId || 'global'}`;

  // Accumulate in-memory
  const current = realtimeStats.get(key) || { bytesIn: 0, bytesOut: 0, requests: 0, lastUpdated: Date.now() };
  current.bytesIn += params.bytesIn;
  current.bytesOut += params.bytesOut;
  current.requests += params.requests || 1;
  current.lastUpdated = Date.now();
  realtimeStats.set(key, current);

  // Track metadata needed at flush time
  if (!pendingFlushMeta.has(key)) {
    const now = new Date();
    const hourKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}`;
    pendingFlushMeta.set(key, {
      organizationId: params.organizationId,
      tunnelId: params.tunnelId,
      agentId: params.agentId,
      hourKey,
    });
  }

  // Return resolved promise to keep call sites unchanged
  return Promise.resolve();
}

/**
 * Flush all accumulated bandwidth stats to MongoDB.
 * Called automatically every 30 seconds by the background interval.
 */
export async function flushBandwidthToMongo(): Promise<void> {
  if (pendingFlushMeta.size === 0) return;

  const db = await getDatabase();
  const collection = db.collection(BANDWIDTH_COLLECTION);

  // Snapshot and clear pending entries atomically
  const entries = Array.from(pendingFlushMeta.entries());
  pendingFlushMeta.clear();

  // Snapshot current stats for each key and reset the accumulators so the
  // next 30s window starts fresh (avoids double-counting on every flush).
  const statsSnapshot = new Map<string, { bytesIn: number; bytesOut: number; requests: number }>();
  for (const [key] of entries) {
    const s = realtimeStats.get(key);
    if (s) {
      statsSnapshot.set(key, { bytesIn: s.bytesIn, bytesOut: s.bytesOut, requests: s.requests });
      // Delete the entry entirely after snapshot — it gets re-created on next activity.
      // This prevents realtimeStats from accumulating stale zero-value entries forever.
      realtimeStats.delete(key);
    }
  }

  const ops = entries.map(([key, meta]) => {
    const stats = statsSnapshot.get(key);
    if (!stats || (stats.bytesIn === 0 && stats.bytesOut === 0 && stats.requests === 0)) return null;
    return {
      updateOne: {
        filter: {
          organizationId: meta.organizationId,
          tunnelId: meta.tunnelId,
          periodKey: meta.hourKey,
          period: "hour",
        },
        update: {
          $inc: {
            bytesIn: stats.bytesIn,
            bytesOut: stats.bytesOut,
            requests: stats.requests,
          },
          $set: {
            agentId: meta.agentId,
            timestamp: Date.now(),
          },
          $setOnInsert: { id: generateId() },
        },
        upsert: true,
      },
    };
  }).filter(Boolean);

  if (ops.length > 0) {
    await collection.bulkWrite(ops as any[], { ordered: false });
  }
}

/**
 * Get bandwidth usage for an organization
 */
export async function getBandwidthUsage(
  organizationId: string,
  period: "day" | "week" | "month" = "month"
): Promise<{
  totalIn: number;
  totalOut: number;
  totalRequests: number;
  byTunnel: Array<{ tunnelId: string; bytesIn: number; bytesOut: number; requests: number }>;
  timeline: Array<{ date: string; bytesIn: number; bytesOut: number; requests: number }>;
}> {
  const db = await getDatabase();
  const collection = db.collection(BANDWIDTH_COLLECTION);

  const periodDays = period === "day" ? 1 : period === "week" ? 7 : 30;
  const startDate = Date.now() - (periodDays * 24 * 60 * 60 * 1000);

  const records = await collection.find({
    organizationId,
    timestamp: { $gte: startDate },
  }).toArray();

  let totalIn = 0;
  let totalOut = 0;
  let totalRequests = 0;
  const byTunnelMap = new Map<string, { bytesIn: number; bytesOut: number; requests: number }>();
  const timelineMap = new Map<string, { bytesIn: number; bytesOut: number; requests: number }>();

  for (const record of records) {
    totalIn += record.bytesIn || 0;
    totalOut += record.bytesOut || 0;
    totalRequests += record.requests || 0;

    if (record.tunnelId) {
      const tunnelStats = byTunnelMap.get(record.tunnelId) || { bytesIn: 0, bytesOut: 0, requests: 0 };
      tunnelStats.bytesIn += record.bytesIn || 0;
      tunnelStats.bytesOut += record.bytesOut || 0;
      tunnelStats.requests += record.requests || 0;
      byTunnelMap.set(record.tunnelId, tunnelStats);
    }

    // Group by date for timeline
    const date = new Date(record.timestamp).toISOString().split('T')[0];
    const dateStats = timelineMap.get(date) || { bytesIn: 0, bytesOut: 0, requests: 0 };
    dateStats.bytesIn += record.bytesIn || 0;
    dateStats.bytesOut += record.bytesOut || 0;
    dateStats.requests += record.requests || 0;
    timelineMap.set(date, dateStats);
  }

  return {
    totalIn,
    totalOut,
    totalRequests,
    byTunnel: Array.from(byTunnelMap.entries()).map(([tunnelId, stats]) => ({ tunnelId, ...stats })),
    timeline: Array.from(timelineMap.entries())
      .map(([date, stats]) => ({ date, ...stats }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Get dashboard stats for an organization
 */
export async function getDashboardStats(organizationId: string): Promise<DashboardStats> {
  const db = await getDatabase();
  
  // Get tunnels
  const tunnelsCollection = db.collection("tunnels");
  const tunnels = await tunnelsCollection.find({ organizationId }).toArray();
  const agents = await agentService.getAllAgentsAsync();
  
  const activeTunnelDomains = new Set(agents.filter(a => a.active).map(a => a.domain));
  const onlineTunnels = tunnels.filter(t => activeTunnelDomains.has(t.domain));
  
  // Get domains
  const domainsCollection = db.collection("custom_domains");
  const domains = await domainsCollection.find({ organizationId }).toArray();
  const now = Date.now();
  const thirtyDaysFromNow = now + (30 * 24 * 60 * 60 * 1000);
  
  const validDomains = domains.filter(d => d.certExpiry && d.certExpiry > now);
  const expiringDomains = domains.filter(d => d.certExpiry && d.certExpiry > now && d.certExpiry < thirtyDaysFromNow);
  
  // Get bandwidth
  const bandwidth = await getBandwidthUsage(organizationId, "month");
  const todayBandwidth = await getBandwidthUsage(organizationId, "day");
  
  // Get organization's subscription/plan
  const subscriptionCollection = db.collection("subscriptions");
  const plansCollection = db.collection("plans");
  
  const subscription = await subscriptionCollection.findOne({ organizationId, status: "active" });
  let plan = null;
  
  if (subscription) {
    plan = await plansCollection.findOne({ id: subscription.planId });
  }
  
  // Default free plan if no subscription
  const planInfo = plan || {
    name: "Free",
    tier: "free" as PlanTier,
    limits: {
      maxTunnels: 3,
      maxDomains: 1,
      maxBandwidthGb: 1,
    },
  };

  // Calculate requests
  const weekBandwidth = await getBandwidthUsage(organizationId, "week");

  return {
    tunnels: {
      total: tunnels.length,
      online: onlineTunnels.length,
      offline: tunnels.length - onlineTunnels.length,
    },
    domains: {
      total: domains.length,
      sslValid: validDomains.length,
      sslExpiring: expiringDomains.length,
    },
    agents: {
      total: agents.length,
      connected: agents.filter(a => a.active).length,
    },
    bandwidth: {
      totalIn: bandwidth.totalIn,
      totalOut: bandwidth.totalOut,
      periodIn: todayBandwidth.totalIn,
      periodOut: todayBandwidth.totalOut,
    },
    requests: {
      total: bandwidth.totalRequests,
      today: todayBandwidth.totalRequests,
      thisWeek: weekBandwidth.totalRequests,
    },
    plan: {
      name: planInfo.name,
      tier: planInfo.tier,
      tunnelLimit: planInfo.limits?.maxTunnels || 3,
      domainLimit: planInfo.limits?.maxDomains || 1,
      bandwidthLimit: planInfo.limits?.maxBandwidthGb || 1,
      usedTunnels: tunnels.length,
      usedDomains: domains.length,
      usedBandwidth: Math.round((bandwidth.totalIn + bandwidth.totalOut) / (1024 * 1024 * 1024) * 100) / 100,
    },
  };
}

/**
 * Get enhanced tunnel list with stats
 */
export async function getEnhancedTunnels(organizationId: string): Promise<EnhancedTunnel[]> {
  const db = await getDatabase();
  const tunnelsCollection = db.collection("tunnels");
  const tunnels = await tunnelsCollection.find({ organizationId }).toArray();
  
  // Use async version to get agents from MongoDB
  const agents = await agentService.getAllAgentsAsync();
  const agentMap = new Map(agents.map(a => [a.domain, a]));
  
  const bandwidth = await getBandwidthUsage(organizationId, "month");
  const bandwidthByTunnel = new Map(bandwidth.byTunnel.map(b => [b.tunnelId, b]));

  return tunnels.map(tunnel => {
    const agent = agentMap.get(tunnel.domain);
    const stats = bandwidthByTunnel.get(tunnel.id) || { bytesIn: 0, bytesOut: 0, requests: 0 };
    
    return {
      ...tunnel,
      status: agent?.active ? "online" : "offline",
      totalRequests: stats.requests,
      bytesIn: stats.bytesIn,
      bytesOut: stats.bytesOut,
      lastRequestAt: undefined, // Would need to track this separately
      avgResponseTime: undefined,
      errorRate: 0,
    } as EnhancedTunnel;
  });
}

/**
 * Get enhanced agent list with system info
 */
export async function getEnhancedAgents(organizationId?: string): Promise<EnhancedAgent[]> {
  const agents = await agentService.getAllAgentsAsync();
  
  // Get stored system info from database
  const db = await getDatabase();
  const agentInfoCollection = db.collection("agent_info");
  const agentInfos = await agentInfoCollection.find({}).toArray();
  const agentInfoMap = new Map(agentInfos.map(a => [a.agentId, a]));

  return agents.map(agent => {
    const info = agentInfoMap.get(agent.id);
    
    return {
      ...agent,
      platform: info?.platform || 'unknown',
      platformVersion: info?.platformVersion,
      arch: info?.arch,
      cliVersion: info?.cliVersion || '0.1.0',
      cpuUsage: info?.cpuUsage || Math.floor(Math.random() * 30 + 10), // Placeholder until real data
      memoryUsage: info?.memoryUsage || Math.floor(Math.random() * 40 + 20),
      signalStrength: calculateSignalStrength(agent.lastHeartbeat),
      tunnelCount: 1,
      bytesIn: info?.bytesIn || 0,
      bytesOut: info?.bytesOut || 0,
      totalRequests: info?.totalRequests || 0,
    } as EnhancedAgent;
  });
}

/**
 * Calculate signal strength based on last heartbeat
 */
function calculateSignalStrength(lastHeartbeat: number): number {
  const now = Date.now();
  const diff = now - lastHeartbeat;
  
  if (diff < 5000) return 100; // < 5s = excellent
  if (diff < 15000) return 80; // < 15s = good
  if (diff < 30000) return 60; // < 30s = fair
  if (diff < 60000) return 40; // < 1min = poor
  return 20; // > 1min = very poor
}

/**
 * Get enhanced domain list with SSL info
 */
export async function getEnhancedDomains(organizationId: string): Promise<EnhancedDomain[]> {
  const db = await getDatabase();
  const domainsCollection = db.collection("custom_domains");
  const tunnelsCollection = db.collection("tunnels");
  
  const domains = await domainsCollection.find({ organizationId }).toArray();
  const tunnels = await tunnelsCollection.find({ organizationId }).toArray();
  
  const now = Date.now();
  const thirtyDaysFromNow = now + (30 * 24 * 60 * 60 * 1000);

  return domains.map(domain => {
    const tunnelCount = tunnels.filter(t => t.customDomain === domain.domain).length;
    
    let sslStatus: EnhancedDomain["sslStatus"] = "none";
    if (domain.certExpiry) {
      if (domain.certExpiry < now) {
        sslStatus = "expired";
      } else if (domain.certExpiry < thirtyDaysFromNow) {
        sslStatus = "expiring";
      } else {
        sslStatus = "valid";
      }
    } else if (domain.active === false) {
      sslStatus = "pending";
    }

    return {
      ...domain,
      sslStatus,
      dnsVerified: domain.synced || false,
      dnsRecords: [
        {
          type: "A" as const,
          name: domain.domain,
          value: process.env.VPS_HOST || "your-vps-ip",
          verified: domain.synced || false,
        },
        {
          type: "A" as const,
          name: `*.${domain.domain}`,
          value: process.env.VPS_HOST || "your-vps-ip",
          verified: domain.synced || false,
        },
      ],
      tunnelCount,
    } as EnhancedDomain;
  });
}

/**
 * Update agent system info (called when agent sends heartbeat with system info)
 */
export async function updateAgentInfo(agentId: string, info: {
  platform?: string;
  platformVersion?: string;
  arch?: string;
  cliVersion?: string;
  cpuUsage?: number;
  memoryUsage?: number;
}): Promise<void> {
  const db = await getDatabase();
  const collection = db.collection("agent_info");
  
  await collection.updateOne(
    { agentId },
    {
      $set: {
        ...info,
        updatedAt: Date.now(),
      },
      $setOnInsert: {
        createdAt: Date.now(),
      },
    },
    { upsert: true }
  );
}

/**
 * Aggregate hourly stats into daily (run via cron)
 */
export async function aggregateDailyStats(): Promise<void> {
  const db = await getDatabase();
  const collection = db.collection(BANDWIDTH_COLLECTION);
  
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateKey = yesterday.toISOString().split('T')[0];
  
  // Aggregate hourly records into daily
  const hourlyRecords = await collection.find({
    period: "hour",
    periodKey: { $regex: `^${dateKey}` },
  }).toArray();
  
  // Group by org + tunnel
  const groups = new Map<string, { bytesIn: number; bytesOut: number; requests: number; organizationId: string; tunnelId?: string }>();
  
  for (const record of hourlyRecords) {
    const key = `${record.organizationId}:${record.tunnelId || 'global'}`;
    const current = groups.get(key) || { bytesIn: 0, bytesOut: 0, requests: 0, organizationId: record.organizationId, tunnelId: record.tunnelId };
    current.bytesIn += record.bytesIn || 0;
    current.bytesOut += record.bytesOut || 0;
    current.requests += record.requests || 0;
    groups.set(key, current);
  }
  
  // Insert daily aggregates
  for (const [key, stats] of groups) {
    await collection.insertOne({
      id: generateId(),
      organizationId: stats.organizationId,
      tunnelId: stats.tunnelId,
      periodKey: dateKey,
      period: "day",
      bytesIn: stats.bytesIn,
      bytesOut: stats.bytesOut,
      requests: stats.requests,
      timestamp: yesterday.getTime(),
    });
  }
  
  console.log(`✅ Aggregated ${groups.size} daily stats for ${dateKey}`);
}
