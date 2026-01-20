/**
 * Monitoring Service
 * 
 * Comprehensive system monitoring for jrok including:
 * - Memory usage tracking
 * - WebSocket connection limits
 * - Rate limit statistics
 * - Authentication metrics
 * - Certificate renewal tracking
 * - System health metrics
 */

import { getClient, getCollections } from "../utils/mongodb";
import os from "os";

// ============ Configuration ============

// WebSocket connection limits
const MAX_AGENT_CONNECTIONS_PER_SERVER = parseInt(process.env.MAX_AGENT_CONNECTIONS || "5000");
const MAX_CLIENT_CONNECTIONS_PER_SERVER = parseInt(process.env.MAX_CLIENT_CONNECTIONS || "10000");
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP || "100");

// Monitoring intervals
const METRICS_COLLECTION_INTERVAL = 10000; // 10 seconds
const METRICS_RETENTION_DAYS = 7;

// ============ Tracking State ============

// Connection counters
let agentConnectionCount = 0;
let clientConnectionCount = 0;
const connectionsPerIp = new Map<string, number>();

// Rate limit statistics
interface RateLimitStats {
  endpoint: string;
  hits: number;
  blocked: number;
  lastHit: number;
}
const rateLimitStats = new Map<string, RateLimitStats>();

// Authentication metrics
interface AuthMetrics {
  successCount: number;
  failureCount: number;
  failedAttempts: Map<string, { count: number; lastAttempt: number }>;
}
const authMetrics: AuthMetrics = {
  successCount: 0,
  failureCount: 0,
  failedAttempts: new Map(),
};

// Certificate metrics
interface CertMetrics {
  renewalAttempts: number;
  renewalSuccesses: number;
  renewalFailures: number;
  lastRenewal: number | null;
  lastError: string | null;
}
const certMetrics: CertMetrics = {
  renewalAttempts: 0,
  renewalSuccesses: 0,
  renewalFailures: 0,
  lastRenewal: null,
  lastError: null,
};

// System metrics history (for graphs)
interface SystemMetricsSnapshot {
  timestamp: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  cpu: {
    user: number;
    system: number;
  };
  connections: {
    agents: number;
    clients: number;
  };
  mapSizes: {
    pendingRequests: number;
    orgPlanCache: number;
  };
}
const metricsHistory: SystemMetricsSnapshot[] = [];
const MAX_HISTORY_SIZE = 360; // 1 hour at 10-second intervals

// External map references (set during init)
let pendingRequestsMapRef: Map<any, any> | null = null;
let orgPlanCacheMapRef: Map<any, any> | null = null;

// Monitoring interval reference
let metricsInterval: Timer | null = null;

// ============ Connection Limit Functions ============

/**
 * Check if a new agent connection can be accepted
 */
export function canAcceptAgentConnection(clientIp: string): { allowed: boolean; reason?: string } {
  // Check per-server limit
  if (agentConnectionCount >= MAX_AGENT_CONNECTIONS_PER_SERVER) {
    return {
      allowed: false,
      reason: `Server agent connection limit reached (${MAX_AGENT_CONNECTIONS_PER_SERVER})`
    };
  }

  // Check per-IP limit
  const ipConnections = connectionsPerIp.get(clientIp) || 0;
  if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
    return {
      allowed: false,
      reason: `Per-IP connection limit reached (${MAX_CONNECTIONS_PER_IP})`
    };
  }

  return { allowed: true };
}

/**
 * Check if a new client WebSocket connection can be accepted
 */
export function canAcceptClientConnection(clientIp: string): { allowed: boolean; reason?: string } {
  // Check per-server limit
  if (clientConnectionCount >= MAX_CLIENT_CONNECTIONS_PER_SERVER) {
    return {
      allowed: false,
      reason: `Server client connection limit reached (${MAX_CLIENT_CONNECTIONS_PER_SERVER})`
    };
  }

  // Check per-IP limit
  const ipConnections = connectionsPerIp.get(clientIp) || 0;
  if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
    return {
      allowed: false,
      reason: `Per-IP connection limit reached (${MAX_CONNECTIONS_PER_IP})`
    };
  }

  return { allowed: true };
}

/**
 * Register a new agent connection
 */
export function registerAgentConnection(clientIp: string): void {
  agentConnectionCount++;
  const current = connectionsPerIp.get(clientIp) || 0;
  connectionsPerIp.set(clientIp, current + 1);
}

/**
 * Unregister an agent connection
 */
export function unregisterAgentConnection(clientIp: string): void {
  agentConnectionCount = Math.max(0, agentConnectionCount - 1);
  const current = connectionsPerIp.get(clientIp) || 0;
  if (current <= 1) {
    connectionsPerIp.delete(clientIp);
  } else {
    connectionsPerIp.set(clientIp, current - 1);
  }
}

/**
 * Register a new client connection
 */
export function registerClientConnection(clientIp: string): void {
  clientConnectionCount++;
  const current = connectionsPerIp.get(clientIp) || 0;
  connectionsPerIp.set(clientIp, current + 1);
}

/**
 * Unregister a client connection
 */
export function unregisterClientConnection(clientIp: string): void {
  clientConnectionCount = Math.max(0, clientConnectionCount - 1);
  const current = connectionsPerIp.get(clientIp) || 0;
  if (current <= 1) {
    connectionsPerIp.delete(clientIp);
  } else {
    connectionsPerIp.set(clientIp, current - 1);
  }
}

/**
 * Clear all connection tracking for a specific IP (admin use for stuck counters)
 */
export function clearConnectionsForIp(clientIp: string): { cleared: boolean; previousCount: number } {
  const previousCount = connectionsPerIp.get(clientIp) || 0;
  if (previousCount > 0) {
    connectionsPerIp.delete(clientIp);
    agentConnectionCount = Math.max(0, agentConnectionCount - previousCount);
    addLog('info', 'connections', `Cleared stuck connection counter for IP ${clientIp}`, { previousCount });
    return { cleared: true, previousCount };
  }
  return { cleared: false, previousCount: 0 };
}

/**
 * Get all tracked IP connection counts (admin debugging)
 */
export function getConnectionsPerIpDetails(): Array<{ ip: string; count: number }> {
  return Array.from(connectionsPerIp.entries()).map(([ip, count]) => ({ ip, count }));
}

// ============ Rate Limit Tracking ============

/**
 * Track a rate limit hit
 */
export function trackRateLimitHit(endpoint: string, blocked: boolean): void {
  const stats = rateLimitStats.get(endpoint) || {
    endpoint,
    hits: 0,
    blocked: 0,
    lastHit: 0,
  };

  stats.hits++;
  if (blocked) stats.blocked++;
  stats.lastHit = Date.now();

  rateLimitStats.set(endpoint, stats);
}

/**
 * Get rate limit statistics
 */
export function getRateLimitStats(): RateLimitStats[] {
  return Array.from(rateLimitStats.values());
}

// ============ Authentication Tracking ============

/**
 * Track authentication attempt
 */
export function trackAuthAttempt(success: boolean, identifier?: string): void {
  if (success) {
    authMetrics.successCount++;
  } else {
    authMetrics.failureCount++;

    if (identifier) {
      const existing = authMetrics.failedAttempts.get(identifier) || { count: 0, lastAttempt: 0 };
      existing.count++;
      existing.lastAttempt = Date.now();
      authMetrics.failedAttempts.set(identifier, existing);
    }
  }
}

/**
 * Get authentication metrics
 */
export function getAuthMetrics(): {
  successCount: number;
  failureCount: number;
  failureRate: number;
  topFailedIdentifiers: Array<{ identifier: string; count: number; lastAttempt: number }>;
} {
  const total = authMetrics.successCount + authMetrics.failureCount;
  const failureRate = total > 0 ? authMetrics.failureCount / total : 0;

  // Get top 10 failed identifiers
  const failedArray = Array.from(authMetrics.failedAttempts.entries())
    .map(([identifier, data]) => ({ identifier, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    successCount: authMetrics.successCount,
    failureCount: authMetrics.failureCount,
    failureRate,
    topFailedIdentifiers: failedArray,
  };
}

// ============ Certificate Tracking ============

/**
 * Track certificate renewal attempt
 */
export function trackCertRenewal(success: boolean, error?: string): void {
  certMetrics.renewalAttempts++;

  if (success) {
    certMetrics.renewalSuccesses++;
    certMetrics.lastRenewal = Date.now();
  } else {
    certMetrics.renewalFailures++;
    certMetrics.lastError = error || "Unknown error";
  }
}

/**
 * Get certificate metrics
 */
export function getCertMetrics(): CertMetrics {
  return { ...certMetrics };
}

// ============ System Metrics ============

/**
 * Collect current system metrics
 */
export function collectSystemMetrics(): SystemMetricsSnapshot {
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  return {
    timestamp: Date.now(),
    memory: {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external,
    },
    cpu: {
      user: cpuUsage.user,
      system: cpuUsage.system,
    },
    connections: {
      agents: agentConnectionCount,
      clients: clientConnectionCount,
    },
    mapSizes: {
      pendingRequests: pendingRequestsMapRef?.size || 0,
      orgPlanCache: orgPlanCacheMapRef?.size || 0,
    },
  };
}

/**
 * Get comprehensive system health report
 */
export function getSystemHealth(): {
  status: 'healthy' | 'degraded' | 'critical';
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
    heapUsed: number;
    heapTotal: number;
  };
  cpu: {
    loadAverage: number[];
    cores: number;
  };
  connections: {
    agents: number;
    clients: number;
    perIpCount: number;
    maxAgents: number;
    maxClients: number;
  };
  mapSizes: {
    pendingRequests: number;
    orgPlanCache: number;
    rateLimitStats: number;
    connectionsPerIp: number;
  };
} {
  const memUsage = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercentage = (usedMem / totalMem) * 100;

  // Determine health status
  let status: 'healthy' | 'degraded' | 'critical' = 'healthy';

  if (memPercentage > 90 || agentConnectionCount > MAX_AGENT_CONNECTIONS_PER_SERVER * 0.9) {
    status = 'critical';
  } else if (memPercentage > 80 || agentConnectionCount > MAX_AGENT_CONNECTIONS_PER_SERVER * 0.7) {
    status = 'degraded';
  }

  return {
    status,
    uptime: process.uptime(),
    memory: {
      used: usedMem,
      total: totalMem,
      percentage: memPercentage,
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
    },
    cpu: {
      loadAverage: os.loadavg(),
      cores: os.cpus().length,
    },
    connections: {
      agents: agentConnectionCount,
      clients: clientConnectionCount,
      perIpCount: connectionsPerIp.size,
      maxAgents: MAX_AGENT_CONNECTIONS_PER_SERVER,
      maxClients: MAX_CLIENT_CONNECTIONS_PER_SERVER,
    },
    mapSizes: {
      pendingRequests: pendingRequestsMapRef?.size || 0,
      orgPlanCache: orgPlanCacheMapRef?.size || 0,
      rateLimitStats: rateLimitStats.size,
      connectionsPerIp: connectionsPerIp.size,
    },
  };
}

/**
 * Get metrics history for graphs
 */
export function getMetricsHistory(minutes: number = 60): SystemMetricsSnapshot[] {
  const cutoff = Date.now() - minutes * 60 * 1000;
  return metricsHistory.filter(m => m.timestamp >= cutoff);
}

// ============ Logs & Events ============

interface SystemLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  category: string;
  message: string;
  metadata?: Record<string, any>;
}

const recentLogs: SystemLog[] = [];
const MAX_LOGS = 1000;

/**
 * Add a system log entry
 */
export function addLog(
  level: 'info' | 'warn' | 'error' | 'debug',
  category: string,
  message: string,
  metadata?: Record<string, any>
): void {
  const log: SystemLog = {
    timestamp: Date.now(),
    level,
    category,
    message,
    metadata,
  };

  recentLogs.unshift(log);

  // Trim to max size
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.length = MAX_LOGS;
  }

  // Also store critical logs in MongoDB
  if (level === 'error' || level === 'warn') {
    storeLogToDb(log).catch(console.error);
  }
}

async function storeLogToDb(log: SystemLog): Promise<void> {
  try {
    const db = getClient()?.db("jrok");
    if (!db) return;

    await db.collection("system_logs").insertOne({
      ...log,
      serverId: process.env.VPS_ID || "unknown",
      createdAt: new Date(log.timestamp),
    });
  } catch (error) {
    console.error("Failed to store log:", error);
  }
}

/**
 * Get recent logs
 */
export function getRecentLogs(
  count: number = 100,
  level?: 'info' | 'warn' | 'error' | 'debug',
  category?: string
): SystemLog[] {
  let filtered = recentLogs;

  if (level) {
    filtered = filtered.filter(l => l.level === level);
  }

  if (category) {
    filtered = filtered.filter(l => l.category === category);
  }

  return filtered.slice(0, count);
}

// ============ Comprehensive Dashboard Data ============

export interface MonitoringDashboardData {
  health: ReturnType<typeof getSystemHealth>;
  rateLimits: RateLimitStats[];
  auth: ReturnType<typeof getAuthMetrics>;
  certificates: CertMetrics;
  logs: SystemLog[];
  history: SystemMetricsSnapshot[];
  config: {
    maxAgentConnections: number;
    maxClientConnections: number;
    maxConnectionsPerIp: number;
    metricsRetentionDays: number;
  };
}

/**
 * Get all monitoring data for dashboard
 */
export function getDashboardData(): MonitoringDashboardData {
  return {
    health: getSystemHealth(),
    rateLimits: getRateLimitStats(),
    auth: getAuthMetrics(),
    certificates: getCertMetrics(),
    logs: getRecentLogs(100),
    history: getMetricsHistory(60),
    config: {
      maxAgentConnections: MAX_AGENT_CONNECTIONS_PER_SERVER,
      maxClientConnections: MAX_CLIENT_CONNECTIONS_PER_SERVER,
      maxConnectionsPerIp: MAX_CONNECTIONS_PER_IP,
      metricsRetentionDays: METRICS_RETENTION_DAYS,
    },
  };
}

// ============ Configuration Management ============

export interface SystemConfig {
  maxAgentConnections: number;
  maxClientConnections: number;
  maxConnectionsPerIp: number;
  rateLimits: {
    auth: { requests: number; windowMinutes: number };
    domain: { requests: number; windowHours: number };
    certificate: { requests: number; windowHours: number };
    http: { requests: number; windowMinutes: number };
  };
  features: {
    waitingListEnabled: boolean;
    autoCleanupEnabled: boolean;
    crossServerRoutingEnabled: boolean;
  };
}

/**
 * Get current system configuration
 */
export async function getSystemConfig(): Promise<SystemConfig> {
  try {
    const db = getClient()?.db("jrok");
    if (!db) throw new Error("Database not connected");

    const config = await db.collection("system_config").findOne({ configId: "main" });

    // Return defaults merged with stored config
    return {
      maxAgentConnections: config?.maxAgentConnections || MAX_AGENT_CONNECTIONS_PER_SERVER,
      maxClientConnections: config?.maxClientConnections || MAX_CLIENT_CONNECTIONS_PER_SERVER,
      maxConnectionsPerIp: config?.maxConnectionsPerIp || MAX_CONNECTIONS_PER_IP,
      rateLimits: config?.rateLimits || {
        auth: { requests: 20, windowMinutes: 15 },
        domain: { requests: 5, windowHours: 1 },
        certificate: { requests: 5, windowHours: 24 },
        http: { requests: 1000, windowMinutes: 1 },
      },
      features: config?.features || {
        waitingListEnabled: false,
        autoCleanupEnabled: true,
        crossServerRoutingEnabled: true,
      },
    };
  } catch (error) {
    console.error("Failed to get system config:", error);
    // Return defaults
    return {
      maxAgentConnections: MAX_AGENT_CONNECTIONS_PER_SERVER,
      maxClientConnections: MAX_CLIENT_CONNECTIONS_PER_SERVER,
      maxConnectionsPerIp: MAX_CONNECTIONS_PER_IP,
      rateLimits: {
        auth: { requests: 20, windowMinutes: 15 },
        domain: { requests: 5, windowHours: 1 },
        certificate: { requests: 5, windowHours: 24 },
        http: { requests: 1000, windowMinutes: 1 },
      },
      features: {
        waitingListEnabled: false,
        autoCleanupEnabled: true,
        crossServerRoutingEnabled: true,
      },
    };
  }
}

/**
 * Update system configuration
 */
export async function updateSystemConfig(updates: Partial<SystemConfig>): Promise<SystemConfig> {
  try {
    const db = getClient()?.db("jrok");
    if (!db) throw new Error("Database not connected");

    await db.collection("system_config").updateOne(
      { configId: "main" },
      {
        $set: {
          ...updates,
          updatedAt: new Date(),
        }
      },
      { upsert: true }
    );

    addLog('info', 'config', 'System configuration updated', updates);

    return getSystemConfig();
  } catch (error) {
    addLog('error', 'config', 'Failed to update system configuration', { error: String(error) });
    throw error;
  }
}

// ============ Initialization ============

/**
 * Initialize monitoring service
 */
export function initMonitoringService(
  pendingRequestsMap?: Map<any, any>,
  orgPlanCacheMap?: Map<any, any>
): void {
  // Store map references for size tracking
  pendingRequestsMapRef = pendingRequestsMap || null;
  orgPlanCacheMapRef = orgPlanCacheMap || null;

  // Start metrics collection
  metricsInterval = setInterval(() => {
    const snapshot = collectSystemMetrics();
    metricsHistory.push(snapshot);

    // Trim history
    while (metricsHistory.length > MAX_HISTORY_SIZE) {
      metricsHistory.shift();
    }
  }, METRICS_COLLECTION_INTERVAL);

  // Create indexes for system_logs collection
  createMonitoringIndexes().catch(console.error);

  addLog('info', 'monitoring', 'Monitoring service initialized', {
    maxAgentConnections: MAX_AGENT_CONNECTIONS_PER_SERVER,
    maxClientConnections: MAX_CLIENT_CONNECTIONS_PER_SERVER,
  });

  console.log("✅ Monitoring service initialized");
}

async function createMonitoringIndexes(): Promise<void> {
  try {
    const db = getClient()?.db("jrok");
    if (!db) return;

    // System logs indexes
    await db.collection("system_logs").createIndex({ timestamp: -1 });
    await db.collection("system_logs").createIndex({ level: 1, timestamp: -1 });
    await db.collection("system_logs").createIndex({ category: 1, timestamp: -1 });
    await db.collection("system_logs").createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: METRICS_RETENTION_DAYS * 24 * 60 * 60 }
    );

    console.log("✅ Monitoring indexes created");
  } catch (error) {
    console.error("Failed to create monitoring indexes:", error);
  }
}

/**
 * Shutdown monitoring service
 */
export function shutdownMonitoringService(): void {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }

  addLog('info', 'monitoring', 'Monitoring service shutdown');
}
