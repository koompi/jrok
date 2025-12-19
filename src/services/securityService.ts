/**
 * Security Service
 * 
 * Comprehensive security, rate limiting, and abuse prevention for jrok tunnels.
 * Handles both HTTP and TCP tunnel security.
 */

import { getCollections } from "../utils/mongodb";
import type { Organization, Plan, Tunnel } from "../types/index";

// ============ Configuration ============

// Default limits (can be overridden by plan)
const DEFAULT_LIMITS = {
  // HTTP Limits
  maxHttpRequestsPerMinute: 60,      // Per tunnel
  maxHttpRequestsPerHour: 1000,      // Per tunnel
  maxHttpConnectionsPerTunnel: 100,  // Concurrent connections per tunnel
  
  // TCP Limits  
  maxTcpConnectionsPerTunnel: 10,    // Concurrent TCP connections per tunnel
  maxTcpConnectionsPerOrg: 50,       // Total TCP connections for org
  maxTcpBytesPerMinute: 10 * 1024 * 1024, // 10MB per minute per tunnel
  maxTcpBytesPerHour: 100 * 1024 * 1024,  // 100MB per hour per tunnel
  
  // Global limits
  maxBandwidthBytesPerMonth: 1 * 1024 * 1024 * 1024, // 1GB default
};

// Plan-specific multipliers
const PLAN_MULTIPLIERS: Record<string, number> = {
  free: 1,
  starter: 5,
  pro: 20,
  enterprise: 100, // Effectively unlimited
};

// ============ In-Memory Tracking ============

// Rate limit tracking (key: tunnelId or orgId)
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

// HTTP rate limits
const httpRequestsPerMinute = new Map<string, RateLimitEntry>();
const httpRequestsPerHour = new Map<string, RateLimitEntry>();
const httpConnectionsPerTunnel = new Map<string, number>();

// TCP rate limits
const tcpConnectionsPerTunnel = new Map<string, number>();
const tcpConnectionsPerOrg = new Map<string, number>();
const tcpBytesPerMinute = new Map<string, RateLimitEntry>();
const tcpBytesPerHour = new Map<string, RateLimitEntry>();

// Bandwidth tracking (monthly)
const monthlyBandwidth = new Map<string, { bytes: number; month: string }>();

// IP Allowlist (tunnelId -> Set of allowed IPs/CIDRs)
const ipAllowlists = new Map<string, Set<string>>();

// Connection logs (stored in memory, periodically flushed to DB)
interface ConnectionLog {
  id: string;
  tunnelId: string;
  organizationId?: string;
  type: 'http' | 'tcp';
  remoteIp: string;
  timestamp: number;
  bytesIn: number;
  bytesOut: number;
  duration?: number;
  status: 'allowed' | 'blocked' | 'rate_limited';
  reason?: string;
}

const connectionLogBuffer: ConnectionLog[] = [];
const LOG_FLUSH_INTERVAL = 60000; // Flush logs every minute
const MAX_LOG_BUFFER_SIZE = 1000;

// Blocked IPs (temporary blocks for abuse)
interface BlockedIp {
  ip: string;
  reason: string;
  blockedAt: number;
  expiresAt: number;
}

const blockedIps = new Map<string, BlockedIp>();

// ============ Helper Functions ============

function generateLogId(): string {
  return `log_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getMultiplier(planTier?: string): number {
  return PLAN_MULTIPLIERS[planTier || 'free'] || 1;
}

/**
 * Check if IP matches an allowlist entry (supports CIDR notation)
 */
function ipMatchesAllowlist(ip: string, allowlist: Set<string>): boolean {
  if (allowlist.size === 0) return true; // Empty allowlist = allow all
  
  // Direct match
  if (allowlist.has(ip)) return true;
  
  // CIDR match (basic implementation)
  for (const entry of allowlist) {
    if (entry.includes('/')) {
      if (ipInCidr(ip, entry)) return true;
    }
  }
  
  return false;
}

/**
 * Check if IP is in CIDR range (simplified IPv4 only)
 */
function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const parts = cidr.split('/');
    const range = parts[0];
    const bits = parts[1];
    if (!range || !bits) return false;
    
    const mask = ~(2 ** (32 - parseInt(bits)) - 1);
    
    const ipNum = ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0);
    const rangeNum = range.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0);
    
    return (ipNum & mask) === (rangeNum & mask);
  } catch {
    return false;
  }
}

// ============ HTTP Security ============

export interface HttpSecurityCheck {
  allowed: boolean;
  reason?: string;
  retryAfter?: number; // seconds
}

/**
 * Check if HTTP request should be allowed
 */
export async function checkHttpRequest(
  tunnelId: string,
  organizationId: string | undefined,
  remoteIp: string,
  planTier?: string
): Promise<HttpSecurityCheck> {
  const now = Date.now();
  const multiplier = getMultiplier(planTier);
  
  // Check blocked IPs
  const blocked = blockedIps.get(remoteIp);
  if (blocked && blocked.expiresAt > now) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'http',
      remoteIp,
      status: 'blocked',
      reason: blocked.reason,
    });
    return { allowed: false, reason: `IP blocked: ${blocked.reason}`, retryAfter: Math.ceil((blocked.expiresAt - now) / 1000) };
  }
  
  // Check IP allowlist if configured
  const allowlist = ipAllowlists.get(tunnelId);
  if (allowlist && allowlist.size > 0 && !ipMatchesAllowlist(remoteIp, allowlist)) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'http',
      remoteIp,
      status: 'blocked',
      reason: 'IP not in allowlist',
    });
    return { allowed: false, reason: 'IP not in allowlist' };
  }
  
  // Check per-minute rate limit
  const minuteKey = `${tunnelId}:minute`;
  const minuteLimit = DEFAULT_LIMITS.maxHttpRequestsPerMinute * multiplier;
  const minuteCheck = checkRateLimit(httpRequestsPerMinute, minuteKey, minuteLimit, 60000, now);
  if (!minuteCheck.allowed) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'http',
      remoteIp,
      status: 'rate_limited',
      reason: 'Per-minute rate limit exceeded',
    });
    return { allowed: false, reason: 'Rate limit exceeded (per minute)', retryAfter: minuteCheck.retryAfter };
  }
  
  // Check per-hour rate limit
  const hourKey = `${tunnelId}:hour`;
  const hourLimit = DEFAULT_LIMITS.maxHttpRequestsPerHour * multiplier;
  const hourCheck = checkRateLimit(httpRequestsPerHour, hourKey, hourLimit, 3600000, now);
  if (!hourCheck.allowed) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'http',
      remoteIp,
      status: 'rate_limited',
      reason: 'Per-hour rate limit exceeded',
    });
    return { allowed: false, reason: 'Rate limit exceeded (per hour)', retryAfter: hourCheck.retryAfter };
  }
  
  // Check concurrent connections
  const currentConnections = httpConnectionsPerTunnel.get(tunnelId) || 0;
  const maxConnections = DEFAULT_LIMITS.maxHttpConnectionsPerTunnel * multiplier;
  if (currentConnections >= maxConnections) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'http',
      remoteIp,
      status: 'rate_limited',
      reason: 'Max concurrent connections reached',
    });
    return { allowed: false, reason: 'Too many concurrent connections' };
  }
  
  // Increment counters
  incrementRateLimit(httpRequestsPerMinute, minuteKey, 60000, now);
  incrementRateLimit(httpRequestsPerHour, hourKey, 3600000, now);
  
  logConnection({
    tunnelId,
    organizationId,
    type: 'http',
    remoteIp,
    status: 'allowed',
  });
  
  return { allowed: true };
}

/**
 * Track HTTP connection open/close
 */
export function trackHttpConnection(tunnelId: string, isOpen: boolean): void {
  const current = httpConnectionsPerTunnel.get(tunnelId) || 0;
  if (isOpen) {
    httpConnectionsPerTunnel.set(tunnelId, current + 1);
  } else {
    httpConnectionsPerTunnel.set(tunnelId, Math.max(0, current - 1));
  }
}

// ============ TCP Security ============

export interface TcpSecurityCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if TCP connection should be allowed
 */
export async function checkTcpConnection(
  tunnelId: string,
  organizationId: string | undefined,
  remoteIp: string,
  planTier?: string
): Promise<TcpSecurityCheck> {
  const now = Date.now();
  const multiplier = getMultiplier(planTier);
  
  // Check blocked IPs
  const blocked = blockedIps.get(remoteIp);
  if (blocked && blocked.expiresAt > now) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'tcp',
      remoteIp,
      status: 'blocked',
      reason: blocked.reason,
    });
    return { allowed: false, reason: `IP blocked: ${blocked.reason}` };
  }
  
  // Check IP allowlist if configured
  const allowlist = ipAllowlists.get(tunnelId);
  if (allowlist && allowlist.size > 0 && !ipMatchesAllowlist(remoteIp, allowlist)) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'tcp',
      remoteIp,
      status: 'blocked',
      reason: 'IP not in allowlist',
    });
    return { allowed: false, reason: 'IP not in allowlist' };
  }
  
  // Check per-tunnel TCP connection limit
  const tunnelConnections = tcpConnectionsPerTunnel.get(tunnelId) || 0;
  const maxPerTunnel = DEFAULT_LIMITS.maxTcpConnectionsPerTunnel * multiplier;
  if (tunnelConnections >= maxPerTunnel) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'tcp',
      remoteIp,
      status: 'rate_limited',
      reason: 'Max TCP connections per tunnel reached',
    });
    return { allowed: false, reason: `Max TCP connections per tunnel (${maxPerTunnel}) reached` };
  }
  
  // Check per-org TCP connection limit
  if (organizationId) {
    const orgConnections = tcpConnectionsPerOrg.get(organizationId) || 0;
    const maxPerOrg = DEFAULT_LIMITS.maxTcpConnectionsPerOrg * multiplier;
    if (orgConnections >= maxPerOrg) {
      logConnection({
        tunnelId,
        organizationId,
        type: 'tcp',
        remoteIp,
        status: 'rate_limited',
        reason: 'Max TCP connections per organization reached',
      });
      return { allowed: false, reason: `Max TCP connections per organization (${maxPerOrg}) reached` };
    }
  }
  
  logConnection({
    tunnelId,
    organizationId,
    type: 'tcp',
    remoteIp,
    status: 'allowed',
  });
  
  return { allowed: true };
}

/**
 * Track TCP connection open/close
 */
export function trackTcpConnection(tunnelId: string, organizationId: string | undefined, isOpen: boolean): void {
  // Per-tunnel tracking
  const tunnelCurrent = tcpConnectionsPerTunnel.get(tunnelId) || 0;
  if (isOpen) {
    tcpConnectionsPerTunnel.set(tunnelId, tunnelCurrent + 1);
  } else {
    tcpConnectionsPerTunnel.set(tunnelId, Math.max(0, tunnelCurrent - 1));
  }
  
  // Per-org tracking
  if (organizationId) {
    const orgCurrent = tcpConnectionsPerOrg.get(organizationId) || 0;
    if (isOpen) {
      tcpConnectionsPerOrg.set(organizationId, orgCurrent + 1);
    } else {
      tcpConnectionsPerOrg.set(organizationId, Math.max(0, orgCurrent - 1));
    }
  }
}

/**
 * Check TCP bandwidth limit
 */
export function checkTcpBandwidth(
  tunnelId: string,
  bytes: number,
  planTier?: string
): { allowed: boolean; reason?: string } {
  const now = Date.now();
  const multiplier = getMultiplier(planTier);
  
  // Check per-minute bandwidth
  const minuteKey = `${tunnelId}:minute`;
  const minuteEntry = tcpBytesPerMinute.get(minuteKey);
  const minuteLimit = DEFAULT_LIMITS.maxTcpBytesPerMinute * multiplier;
  
  if (minuteEntry && now - minuteEntry.windowStart < 60000) {
    if (minuteEntry.count + bytes > minuteLimit) {
      return { allowed: false, reason: 'TCP bandwidth limit exceeded (per minute)' };
    }
  }
  
  // Check per-hour bandwidth
  const hourKey = `${tunnelId}:hour`;
  const hourEntry = tcpBytesPerHour.get(hourKey);
  const hourLimit = DEFAULT_LIMITS.maxTcpBytesPerHour * multiplier;
  
  if (hourEntry && now - hourEntry.windowStart < 3600000) {
    if (hourEntry.count + bytes > hourLimit) {
      return { allowed: false, reason: 'TCP bandwidth limit exceeded (per hour)' };
    }
  }
  
  return { allowed: true };
}

/**
 * Track TCP bandwidth usage
 */
export function trackTcpBandwidth(tunnelId: string, organizationId: string | undefined, bytes: number): void {
  const now = Date.now();
  
  // Track per-minute
  const minuteKey = `${tunnelId}:minute`;
  incrementBandwidth(tcpBytesPerMinute, minuteKey, bytes, 60000, now);
  
  // Track per-hour
  const hourKey = `${tunnelId}:hour`;
  incrementBandwidth(tcpBytesPerHour, hourKey, bytes, 3600000, now);
  
  // Track monthly bandwidth for org
  if (organizationId) {
    trackMonthlyBandwidth(organizationId, bytes);
  }
}

// ============ Bandwidth Tracking ============

/**
 * Track monthly bandwidth usage
 */
export function trackMonthlyBandwidth(organizationId: string, bytes: number): void {
  const currentMonth = getCurrentMonth();
  const entry = monthlyBandwidth.get(organizationId);
  
  if (!entry || entry.month !== currentMonth) {
    monthlyBandwidth.set(organizationId, { bytes, month: currentMonth });
  } else {
    entry.bytes += bytes;
  }
}

/**
 * Get monthly bandwidth usage
 */
export function getMonthlyBandwidth(organizationId: string): number {
  const currentMonth = getCurrentMonth();
  const entry = monthlyBandwidth.get(organizationId);
  
  if (!entry || entry.month !== currentMonth) {
    return 0;
  }
  
  return entry.bytes;
}

/**
 * Check if organization has exceeded monthly bandwidth
 */
export function checkMonthlyBandwidth(
  organizationId: string,
  planTier?: string
): { allowed: boolean; usedBytes: number; limitBytes: number; percentUsed: number } {
  const multiplier = getMultiplier(planTier);
  const limitBytes = DEFAULT_LIMITS.maxBandwidthBytesPerMonth * multiplier;
  const usedBytes = getMonthlyBandwidth(organizationId);
  const percentUsed = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;
  
  // Enterprise plan (-1 bandwidth) means unlimited
  if (planTier === 'enterprise') {
    return { allowed: true, usedBytes, limitBytes: -1, percentUsed: 0 };
  }
  
  return {
    allowed: usedBytes < limitBytes,
    usedBytes,
    limitBytes,
    percentUsed,
  };
}

// ============ IP Allowlist Management ============

/**
 * Set IP allowlist for a tunnel
 */
export function setIpAllowlist(tunnelId: string, ips: string[]): void {
  if (ips.length === 0) {
    ipAllowlists.delete(tunnelId);
  } else {
    ipAllowlists.set(tunnelId, new Set(ips));
  }
}

/**
 * Get IP allowlist for a tunnel
 */
export function getIpAllowlist(tunnelId: string): string[] {
  const allowlist = ipAllowlists.get(tunnelId);
  return allowlist ? Array.from(allowlist) : [];
}

/**
 * Add IP to allowlist
 */
export function addIpToAllowlist(tunnelId: string, ip: string): void {
  let allowlist = ipAllowlists.get(tunnelId);
  if (!allowlist) {
    allowlist = new Set();
    ipAllowlists.set(tunnelId, allowlist);
  }
  allowlist.add(ip);
}

/**
 * Remove IP from allowlist
 */
export function removeIpFromAllowlist(tunnelId: string, ip: string): void {
  const allowlist = ipAllowlists.get(tunnelId);
  if (allowlist) {
    allowlist.delete(ip);
  }
}

// ============ IP Blocking ============

/**
 * Block an IP temporarily
 */
export function blockIp(ip: string, reason: string, durationSeconds: number = 3600): void {
  const now = Date.now();
  blockedIps.set(ip, {
    ip,
    reason,
    blockedAt: now,
    expiresAt: now + durationSeconds * 1000,
  });
  console.log(`🚫 Blocked IP ${ip} for ${durationSeconds}s: ${reason}`);
}

/**
 * Unblock an IP
 */
export function unblockIp(ip: string): void {
  blockedIps.delete(ip);
  console.log(`✅ Unblocked IP ${ip}`);
}

/**
 * Check if IP is blocked
 */
export function isIpBlocked(ip: string): boolean {
  const blocked = blockedIps.get(ip);
  if (!blocked) return false;
  
  if (blocked.expiresAt <= Date.now()) {
    blockedIps.delete(ip);
    return false;
  }
  
  return true;
}

/**
 * Get all blocked IPs
 */
export function getBlockedIps(): BlockedIp[] {
  const now = Date.now();
  const result: BlockedIp[] = [];
  
  for (const [ip, entry] of blockedIps.entries()) {
    if (entry.expiresAt > now) {
      result.push(entry);
    } else {
      blockedIps.delete(ip);
    }
  }
  
  return result;
}

// ============ Connection Logging ============

function logConnection(params: {
  tunnelId: string;
  organizationId?: string;
  type: 'http' | 'tcp';
  remoteIp: string;
  status: 'allowed' | 'blocked' | 'rate_limited';
  reason?: string;
  bytesIn?: number;
  bytesOut?: number;
  duration?: number;
}): void {
  const log: ConnectionLog = {
    id: generateLogId(),
    tunnelId: params.tunnelId,
    organizationId: params.organizationId,
    type: params.type,
    remoteIp: params.remoteIp,
    timestamp: Date.now(),
    bytesIn: params.bytesIn || 0,
    bytesOut: params.bytesOut || 0,
    duration: params.duration,
    status: params.status,
    reason: params.reason,
  };
  
  connectionLogBuffer.push(log);
  
  // Log blocked/rate_limited to console
  if (params.status !== 'allowed') {
    console.log(`🛡️ [${params.type.toUpperCase()}] ${params.status}: ${params.remoteIp} -> ${params.tunnelId} (${params.reason})`);
  }
  
  // Flush if buffer is full
  if (connectionLogBuffer.length >= MAX_LOG_BUFFER_SIZE) {
    flushConnectionLogs();
  }
}

/**
 * Flush connection logs to database
 */
export async function flushConnectionLogs(): Promise<void> {
  if (connectionLogBuffer.length === 0) return;
  
  const logsToFlush = connectionLogBuffer.splice(0, connectionLogBuffer.length);
  
  try {
    const collections = getCollections();
    await collections.connectionLogs?.insertMany(logsToFlush);
  } catch (error) {
    console.error('❌ Failed to flush connection logs:', error);
    // Re-add logs to buffer (at the beginning)
    connectionLogBuffer.unshift(...logsToFlush);
  }
}

/**
 * Get connection logs for a tunnel
 */
export async function getConnectionLogs(
  tunnelId: string,
  limit: number = 100,
  offset: number = 0
): Promise<ConnectionLog[]> {
  try {
    const collections = getCollections();
    const logs = await collections.connectionLogs
      ?.find({ tunnelId })
      .sort({ timestamp: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    
    return (logs || []) as unknown as ConnectionLog[];
  } catch {
    return [];
  }
}

/**
 * Get connection logs for an organization
 */
export async function getOrganizationConnectionLogs(
  organizationId: string,
  limit: number = 100,
  offset: number = 0
): Promise<ConnectionLog[]> {
  try {
    const collections = getCollections();
    const logs = await collections.connectionLogs
      ?.find({ organizationId })
      .sort({ timestamp: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    
    return (logs || []) as unknown as ConnectionLog[];
  } catch {
    return [];
  }
}

// ============ Rate Limit Helpers ============

function checkRateLimit(
  store: Map<string, RateLimitEntry>,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): { allowed: boolean; retryAfter?: number } {
  const entry = store.get(key);
  
  if (!entry || now - entry.windowStart >= windowMs) {
    return { allowed: true };
  }
  
  if (entry.count >= limit) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }
  
  return { allowed: true };
}

function incrementRateLimit(
  store: Map<string, RateLimitEntry>,
  key: string,
  windowMs: number,
  now: number
): void {
  const entry = store.get(key);
  
  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

function incrementBandwidth(
  store: Map<string, RateLimitEntry>,
  key: string,
  bytes: number,
  windowMs: number,
  now: number
): void {
  const entry = store.get(key);
  
  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(key, { count: bytes, windowStart: now });
  } else {
    entry.count += bytes;
  }
}

// ============ Abuse Detection ============

// Track suspicious patterns
const suspiciousPatterns = new Map<string, { count: number; firstSeen: number }>();

/**
 * Detect potential abuse patterns
 */
export function detectAbuse(
  ip: string,
  tunnelId: string,
  pattern: 'rapid_requests' | 'connection_flood' | 'bandwidth_spike' | 'auth_failure'
): void {
  const key = `${ip}:${pattern}`;
  const now = Date.now();
  const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  
  const entry = suspiciousPatterns.get(key);
  
  if (!entry || now - entry.firstSeen > WINDOW_MS) {
    suspiciousPatterns.set(key, { count: 1, firstSeen: now });
    return;
  }
  
  entry.count++;
  
  // Thresholds for auto-blocking
  const thresholds: Record<string, number> = {
    rapid_requests: 100,     // 100 suspicious rapid request patterns
    connection_flood: 50,    // 50 connection flood attempts
    bandwidth_spike: 10,     // 10 bandwidth spike events
    auth_failure: 20,        // 20 auth failures
  };
  
  if (entry.count >= (thresholds[pattern] || 50)) {
    blockIp(ip, `Auto-blocked: ${pattern}`, 3600); // Block for 1 hour
    suspiciousPatterns.delete(key);
  }
}

// ============ Statistics ============

export interface SecurityStats {
  http: {
    activeConnections: number;
    requestsBlocked: number;
    requestsRateLimited: number;
  };
  tcp: {
    activeConnections: number;
    connectionsBlocked: number;
    connectionsRateLimited: number;
  };
  blockedIps: number;
  logsBuffered: number;
}

/**
 * Get security statistics
 */
export function getSecurityStats(): SecurityStats {
  let httpConnections = 0;
  for (const count of httpConnectionsPerTunnel.values()) {
    httpConnections += count;
  }
  
  let tcpConnections = 0;
  for (const count of tcpConnectionsPerTunnel.values()) {
    tcpConnections += count;
  }
  
  return {
    http: {
      activeConnections: httpConnections,
      requestsBlocked: 0, // Would need to track this
      requestsRateLimited: 0,
    },
    tcp: {
      activeConnections: tcpConnections,
      connectionsBlocked: 0,
      connectionsRateLimited: 0,
    },
    blockedIps: blockedIps.size,
    logsBuffered: connectionLogBuffer.length,
  };
}

// ============ Cleanup ============

/**
 * Cleanup expired entries (call periodically)
 */
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  
  // Cleanup rate limit entries older than their window
  for (const [key, entry] of httpRequestsPerMinute.entries()) {
    if (now - entry.windowStart > 60000) httpRequestsPerMinute.delete(key);
  }
  
  for (const [key, entry] of httpRequestsPerHour.entries()) {
    if (now - entry.windowStart > 3600000) httpRequestsPerHour.delete(key);
  }
  
  for (const [key, entry] of tcpBytesPerMinute.entries()) {
    if (now - entry.windowStart > 60000) tcpBytesPerMinute.delete(key);
  }
  
  for (const [key, entry] of tcpBytesPerHour.entries()) {
    if (now - entry.windowStart > 3600000) tcpBytesPerHour.delete(key);
  }
  
  // Cleanup expired blocked IPs
  for (const [ip, entry] of blockedIps.entries()) {
    if (entry.expiresAt <= now) blockedIps.delete(ip);
  }
  
  // Cleanup old suspicious patterns
  for (const [key, entry] of suspiciousPatterns.entries()) {
    if (now - entry.firstSeen > 5 * 60 * 1000) suspiciousPatterns.delete(key);
  }
  
  console.log('🧹 Security service cleanup completed');
}

// ============ Initialization ============

let cleanupInterval: Timer | null = null;
let flushInterval: Timer | null = null;

/**
 * Initialize security service
 */
export function initSecurityService(): void {
  // Cleanup every 5 minutes
  cleanupInterval = setInterval(cleanupExpiredEntries, 5 * 60 * 1000);
  
  // Flush logs every minute
  flushInterval = setInterval(flushConnectionLogs, LOG_FLUSH_INTERVAL);
  
  console.log('🛡️ Security service initialized');
}

/**
 * Shutdown security service
 */
export function shutdownSecurityService(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  
  // Final flush
  flushConnectionLogs();
  
  console.log('🛡️ Security service shutdown');
}
