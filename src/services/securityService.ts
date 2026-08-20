/**
 * Security Service
 * 
 * Comprehensive security, rate limiting, and abuse prevention for jrok tunnels.
 * Handles both HTTP and TCP tunnel security.
 */

import { getCollections } from "../utils/mongodb";
import type { Organization, Plan, Tunnel, TunnelIpSecurity } from "../types/index";

// ============ Configuration ============

// Default limits (can be overridden by plan)
// NOTE: These limits are multiplied by plan tier (free=1x, starter=5x, pro=20x, enterprise=100x)
const DEFAULT_LIMITS = {
  // HTTP Limits - Increased to handle modern web apps with HMR, asset loading, API calls
  maxHttpRequestsPerMinute: 300,     // Per tunnel (was 60, increased for burst support)
  maxHttpRequestsPerHour: 5000,      // Per tunnel (was 1000)
  maxHttpConnectionsPerTunnel: 200,  // Concurrent connections per tunnel (was 100)

  // TCP Limits - Increased for database connections like MongoDB, PostgreSQL
  maxTcpConnectionsPerTunnel: 5000,    // Concurrent TCP connections per tunnel (was 10)
  maxTcpConnectionsPerOrg: 20000,      // Total TCP connections for org (was 50)
  maxTcpBytesPerMinute: 100 * 1024 * 1024, // 100MB per minute per tunnel (was 10MB)
  maxTcpBytesPerHour: 1000 * 1024 * 1024,  // 1GB per hour per tunnel (was 100MB)

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

// ============ Token Bucket Rate Limiting ============
// Token bucket allows burst traffic while maintaining average rate limits
// This handles shared public IPs better than fixed window

interface TokenBucket {
  tokens: number;          // Current available tokens
  lastRefill: number;      // Last time tokens were refilled
  maxTokens: number;       // Maximum bucket capacity (burst limit)
  refillRate: number;      // Tokens added per second
}

// Token buckets per client identifier (layered: session > apiKey > IP+UA > IP)
const httpTokenBuckets = new Map<string, TokenBucket>();
const tcpTokenBuckets = new Map<string, TokenBucket>();

// Per-tunnel global limits (secondary safety net for DDoS)
const tunnelRequestCounts = new Map<string, { count: number; windowStart: number }>();

// Connection tracking
const httpConnectionsPerTunnel = new Map<string, number>();
const tcpConnectionsPerTunnel = new Map<string, number>();
const tcpConnectionsPerOrg = new Map<string, number>();
const tcpConnectionsPerClient = new Map<string, number>(); // Per-client TCP limits
const tcpBytesPerMinute = new Map<string, { count: number; windowStart: number }>();
const tcpBytesPerHour = new Map<string, { count: number; windowStart: number }>();

// Bandwidth tracking (monthly)
const monthlyBandwidth = new Map<string, { bytes: number; month: string }>();

// IP Security Cache (tunnelId -> TunnelIpSecurity) - synced with MongoDB
const ipSecurityCache = new Map<string, TunnelIpSecurity>();

// IP Allowlist (tunnelId -> Set of allowed IPs/CIDRs) - legacy, kept for backward compat
const ipAllowlists = new Map<string, Set<string>>();

// Connection logs (stored in memory, periodically flushed to DB)
// Feature flag: Set ENABLE_CONNECTION_LOGS=true to enable (default: disabled)
const ENABLE_CONNECTION_LOGS = process.env.ENABLE_CONNECTION_LOGS === 'true';

interface ConnectionLog {
  id: string;
  tunnelId: string;
  organizationId?: string;
  type: 'http' | 'tcp';
  remoteIp: string;
  clientId?: string;  // The layered client identifier used
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

// ============ Layered Client Identification ============

/**
 * Generate a client identifier using layered identification strategy:
 * Priority: sessionToken > apiKeyId > IP+UserAgent > IP
 * This handles shared public IPs (offices, cafes, mobile carriers)
 */
export interface ClientIdentifier {
  id: string;
  type: 'session' | 'apiKey' | 'ip_ua' | 'ip';
  ip: string;
  userAgent?: string;
  sessionToken?: string;
  apiKeyId?: string;
}

export function generateClientId(
  ip: string,
  userAgent?: string,
  sessionToken?: string,
  apiKeyId?: string
): ClientIdentifier {
  // Priority 1: Session token (most accurate for authenticated users)
  if (sessionToken) {
    return {
      id: `session:${sessionToken.substring(0, 32)}`,
      type: 'session',
      ip,
      sessionToken
    };
  }

  // Priority 2: API Key (for programmatic access)
  if (apiKeyId) {
    return {
      id: `apikey:${apiKeyId}`,
      type: 'apiKey',
      ip,
      apiKeyId
    };
  }

  // Priority 3: IP + User-Agent hash (differentiates devices on same IP)
  if (userAgent && userAgent.length > 10) {
    // Simple hash of user agent to keep key size reasonable
    const uaHash = simpleHash(userAgent);
    return {
      id: `ip_ua:${ip}:${uaHash}`,
      type: 'ip_ua',
      ip,
      userAgent
    };
  }

  // Priority 4: IP only (fallback)
  return {
    id: `ip:${ip}`,
    type: 'ip',
    ip
  };
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

// ============ Token Bucket Functions ============

/**
 * Get or create a token bucket for a client
 * @param buckets - The bucket map (http or tcp)
 * @param key - Client identifier + tunnel combo
 * @param maxTokens - Maximum tokens (burst capacity)
 * @param refillRate - Tokens per second
 */
function getOrCreateBucket(
  buckets: Map<string, TokenBucket>,
  key: string,
  maxTokens: number,
  refillRate: number
): TokenBucket {
  let bucket = buckets.get(key);
  const now = Date.now();

  if (!bucket) {
    bucket = {
      tokens: maxTokens, // Start with full bucket
      lastRefill: now,
      maxTokens,
      refillRate
    };
    buckets.set(key, bucket);
    return bucket;
  }

  // Refill tokens based on time elapsed
  const elapsed = (now - bucket.lastRefill) / 1000; // seconds
  const tokensToAdd = elapsed * bucket.refillRate;
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;

  // Update limits if they changed (e.g., plan upgrade)
  bucket.maxTokens = maxTokens;
  bucket.refillRate = refillRate;

  return bucket;
}

/**
 * Try to consume tokens from a bucket
 * @returns { allowed, retryAfter, remaining }
 */
function consumeToken(bucket: TokenBucket, tokensNeeded: number = 1): {
  allowed: boolean;
  retryAfter?: number;
  remaining: number;
} {
  if (bucket.tokens >= tokensNeeded) {
    bucket.tokens -= tokensNeeded;
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }

  // Calculate when enough tokens will be available
  const tokensDeficit = tokensNeeded - bucket.tokens;
  const retryAfter = Math.ceil(tokensDeficit / bucket.refillRate);

  return {
    allowed: false,
    retryAfter,
    remaining: 0
  };
}

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

// Legacy rate limit entry type (kept for backward compatibility with cleanup functions)
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

// Legacy rate limit maps (being phased out, but kept for cleanup functions)
const httpRequestsPerMinute = new Map<string, RateLimitEntry>();
const httpRequestsPerHour = new Map<string, RateLimitEntry>();

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
 * Check if IP matches a list (supports CIDR notation)
 */
function ipMatchesList(ip: string, ipList: string[]): boolean {
  if (!ipList || ipList.length === 0) return false;

  // Direct match
  if (ipList.includes(ip)) return true;

  // CIDR match
  for (const entry of ipList) {
    if (entry.includes('/') && ipInCidr(ip, entry)) {
      return true;
    }
  }

  return false;
}

/**
 * Check IP against tunnel's IP security settings
 * Returns { allowed: true } if IP should be allowed
 * Returns { allowed: false, reason: string } if IP should be blocked
 */
export function checkIpSecurity(tunnelId: string, remoteIp: string): { allowed: boolean; reason?: string } {
  const security = ipSecurityCache.get(tunnelId);

  // Default: allow-all mode
  if (!security || security.mode === 'allow-all') {
    // Check legacy allowlist for backward compatibility
    const legacyAllowlist = ipAllowlists.get(tunnelId);
    if (legacyAllowlist && legacyAllowlist.size > 0 && !ipMatchesAllowlist(remoteIp, legacyAllowlist)) {
      return { allowed: false, reason: 'IP not in allowlist' };
    }
    return { allowed: true };
  }

  // Allowlist mode: only listed IPs can access
  if (security.mode === 'allowlist') {
    if (!security.allowedIps || security.allowedIps.length === 0) {
      // Empty allowlist = block all (user hasn't set any IPs yet)
      return { allowed: false, reason: 'No IPs in allowlist. Add IPs or switch to allow-all mode.' };
    }
    if (ipMatchesList(remoteIp, security.allowedIps)) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'IP not in allowlist' };
  }

  // Blocklist mode: listed IPs are blocked, all others allowed
  if (security.mode === 'blocklist') {
    if (security.blockedIps && ipMatchesList(remoteIp, security.blockedIps)) {
      return { allowed: false, reason: 'IP is blocklisted' };
    }
    return { allowed: true };
  }

  return { allowed: true };
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
  remaining?: number;  // remaining tokens/requests
  clientId?: string;   // the client identifier used for rate limiting
}

/**
 * Extended options for HTTP request security check
 */
export interface HttpSecurityOptions {
  userAgent?: string;
  sessionToken?: string;
  apiKeyId?: string;
}

/**
 * Check if HTTP request should be allowed using Token Bucket algorithm
 * with layered client identification for fair rate limiting
 * 
 * Rate limits are applied per-client (session > apiKey > IP+UA > IP) within each tunnel,
 * with a secondary global tunnel limit as DDoS protection.
 */
export async function checkHttpRequest(
  tunnelId: string,
  organizationId: string | undefined,
  remoteIp: string,
  planTier?: string,
  options?: HttpSecurityOptions
): Promise<HttpSecurityCheck> {
  const now = Date.now();
  const multiplier = getMultiplier(planTier);

  // Check global blocked IPs first
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

  // Check tunnel IP security (allowlist/blocklist)
  const ipSecurityCheck = checkIpSecurity(tunnelId, remoteIp);
  if (!ipSecurityCheck.allowed) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'http',
      remoteIp,
      status: 'blocked',
      reason: ipSecurityCheck.reason || 'IP security check failed',
    });
    return { allowed: false, reason: ipSecurityCheck.reason };
  }

  // Generate layered client identifier
  const clientInfo = generateClientId(
    remoteIp,
    options?.userAgent,
    options?.sessionToken,
    options?.apiKeyId
  );

  // === Token Bucket Rate Limiting (per-client within tunnel) ===
  // 
  // Token bucket config:
  // - maxTokens (burst capacity): requests per minute * 2 (allows burst)
  // - refillRate: requests per minute / 60 (tokens per second)
  const maxTokens = DEFAULT_LIMITS.maxHttpRequestsPerMinute * multiplier * 2; // 2x burst capacity
  const refillRate = (DEFAULT_LIMITS.maxHttpRequestsPerMinute * multiplier) / 60; // per second

  const bucketKey = `${tunnelId}:${clientInfo.id}`;
  const bucket = getOrCreateBucket(httpTokenBuckets, bucketKey, maxTokens, refillRate);
  const tokenResult = consumeToken(bucket, 1);

  if (!tokenResult.allowed) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'http',
      remoteIp,
      clientId: clientInfo.id,
      status: 'rate_limited',
      reason: 'Rate limit exceeded (token bucket)',
    });
    return {
      allowed: false,
      reason: `Rate limit exceeded. You can make ${Math.round(refillRate * 60)} requests/minute.`,
      retryAfter: tokenResult.retryAfter,
      clientId: clientInfo.id
    };
  }

  // === Secondary: Global tunnel limit (DDoS protection) ===
  // This prevents all clients combined from overwhelming a tunnel
  const globalTunnelLimit = DEFAULT_LIMITS.maxHttpRequestsPerMinute * multiplier * 10; // 10x for all clients
  const tunnelCount = tunnelRequestCounts.get(tunnelId);

  if (tunnelCount) {
    // Check if we're in a new window
    if (now - tunnelCount.windowStart > 60000) {
      tunnelCount.count = 1;
      tunnelCount.windowStart = now;
    } else {
      tunnelCount.count++;
      if (tunnelCount.count > globalTunnelLimit) {
        logConnection({
          tunnelId,
          organizationId,
          type: 'http',
          remoteIp,
          clientId: clientInfo.id,
          status: 'rate_limited',
          reason: 'Global tunnel rate limit exceeded (DDoS protection)',
        });
        return {
          allowed: false,
          reason: 'Service is experiencing high traffic. Please try again later.',
          retryAfter: Math.ceil((60000 - (now - tunnelCount.windowStart)) / 1000),
          clientId: clientInfo.id
        };
      }
    }
  } else {
    tunnelRequestCounts.set(tunnelId, { count: 1, windowStart: now });
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
      clientId: clientInfo.id,
      status: 'rate_limited',
      reason: 'Max concurrent connections reached',
    });
    return { allowed: false, reason: 'Too many concurrent connections' };
  }

  logConnection({
    tunnelId,
    organizationId,
    type: 'http',
    remoteIp,
    clientId: clientInfo.id,
    status: 'allowed',
  });

  return {
    allowed: true,
    remaining: tokenResult.remaining,
    clientId: clientInfo.id
  };
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
  retryAfter?: number;
  clientId?: string;
}

/**
 * Check if TCP connection should be allowed
 * Uses per-client rate limiting to prevent one client from monopolizing connections
 */
export async function checkTcpConnection(
  tunnelId: string,
  organizationId: string | undefined,
  remoteIp: string,
  planTier?: string
): Promise<TcpSecurityCheck> {
  const now = Date.now();
  const multiplier = getMultiplier(planTier);

  // Generate client identifier (IP-based for TCP since no User-Agent)
  const clientInfo = generateClientId(remoteIp);

  // Check global blocked IPs first
  const blocked = blockedIps.get(remoteIp);
  if (blocked && blocked.expiresAt > now) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'tcp',
      remoteIp,
      clientId: clientInfo.id,
      status: 'blocked',
      reason: blocked.reason,
    });
    return { allowed: false, reason: `IP blocked: ${blocked.reason}`, clientId: clientInfo.id };
  }

  // Check tunnel IP security (allowlist/blocklist)
  const ipSecurityCheck = checkIpSecurity(tunnelId, remoteIp);
  if (!ipSecurityCheck.allowed) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'tcp',
      remoteIp,
      clientId: clientInfo.id,
      status: 'blocked',
      reason: ipSecurityCheck.reason || 'IP security check failed',
    });
    return { allowed: false, reason: ipSecurityCheck.reason, clientId: clientInfo.id };
  }

  // === Per-client TCP connection limit ===
  // Prevents one client from using all connections
  const clientKey = `${tunnelId}:${clientInfo.id}`;
  const clientConnections = tcpConnectionsPerClient.get(clientKey) || 0;
  const maxPerClient = Math.max(5, Math.floor(DEFAULT_LIMITS.maxTcpConnectionsPerTunnel * multiplier / 10)); // Each client gets 10% of tunnel limit, min 5

  if (clientConnections >= maxPerClient) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'tcp',
      remoteIp,
      clientId: clientInfo.id,
      status: 'rate_limited',
      reason: 'Max TCP connections per client reached',
    });
    return {
      allowed: false,
      reason: `Max TCP connections per client (${maxPerClient}) reached. Other users can still connect.`,
      clientId: clientInfo.id
    };
  }

  // === Global tunnel limit (DDoS protection) ===
  const tunnelConnections = tcpConnectionsPerTunnel.get(tunnelId) || 0;
  const maxPerTunnel = DEFAULT_LIMITS.maxTcpConnectionsPerTunnel * multiplier;
  if (tunnelConnections >= maxPerTunnel) {
    logConnection({
      tunnelId,
      organizationId,
      type: 'tcp',
      remoteIp,
      clientId: clientInfo.id,
      status: 'rate_limited',
      reason: 'Max TCP connections per tunnel reached',
    });
    return {
      allowed: false,
      reason: `Max TCP connections per tunnel (${maxPerTunnel}) reached`,
      clientId: clientInfo.id
    };
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
        clientId: clientInfo.id,
        status: 'rate_limited',
        reason: 'Max TCP connections per organization reached',
      });
      return {
        allowed: false,
        reason: `Max TCP connections per organization (${maxPerOrg}) reached`,
        clientId: clientInfo.id
      };
    }
  }

  logConnection({
    tunnelId,
    organizationId,
    type: 'tcp',
    remoteIp,
    clientId: clientInfo.id,
    status: 'allowed',
  });

  return { allowed: true, clientId: clientInfo.id };
}

/**
 * Track TCP connection open/close
 * Now tracks per-client to support fair rate limiting
 */
export function trackTcpConnection(
  tunnelId: string,
  organizationId: string | undefined,
  isOpen: boolean,
  remoteIp?: string  // Optional: for per-client tracking
): void {
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

  // Per-client tracking (for fair rate limiting)
  if (remoteIp) {
    const clientInfo = generateClientId(remoteIp);
    const clientKey = `${tunnelId}:${clientInfo.id}`;
    const clientCurrent = tcpConnectionsPerClient.get(clientKey) || 0;
    if (isOpen) {
      tcpConnectionsPerClient.set(clientKey, clientCurrent + 1);
    } else {
      // Drop the key at zero instead of leaving a 0 behind. This map is keyed
      // by client IP, so retaining spent entries meant one slot per remote IP
      // that ever opened a TCP connection — unbounded growth on a public
      // endpoint, which sees continuous internet scanning.
      const next = clientCurrent - 1;
      if (next > 0) {
        tcpConnectionsPerClient.set(clientKey, next);
      } else {
        tcpConnectionsPerClient.delete(clientKey);
      }
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
 * Set IP allowlist for a tunnel (legacy - kept for backward compatibility)
 */
export function setIpAllowlist(tunnelId: string, ips: string[]): void {
  if (ips.length === 0) {
    ipAllowlists.delete(tunnelId);
  } else {
    ipAllowlists.set(tunnelId, new Set(ips));
  }
}

/**
 * Get IP allowlist for a tunnel (legacy)
 */
export function getIpAllowlist(tunnelId: string): string[] {
  const allowlist = ipAllowlists.get(tunnelId);
  return allowlist ? Array.from(allowlist) : [];
}

/**
 * Add IP to allowlist (legacy)
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
 * Remove IP from allowlist (legacy)
 */
export function removeIpFromAllowlist(tunnelId: string, ip: string): void {
  const allowlist = ipAllowlists.get(tunnelId);
  if (allowlist) {
    allowlist.delete(ip);
  }
}

// ============ New IP Security Management (with persistence) ============

/**
 * Get IP security settings for a tunnel
 */
export function getTunnelIpSecurity(tunnelId: string): TunnelIpSecurity {
  return ipSecurityCache.get(tunnelId) || { mode: 'allow-all' };
}

/**
 * Set IP security settings for a tunnel and persist to MongoDB
 */
export async function setTunnelIpSecurity(
  tunnelId: string,
  security: TunnelIpSecurity,
  updatedBy?: string
): Promise<void> {
  const collections = getCollections();

  // Add metadata
  security.updatedAt = Date.now();
  if (updatedBy) security.updatedBy = updatedBy;

  // Update cache with provided key
  ipSecurityCache.set(tunnelId, security);

  // Find the tunnel to get both ID and domain for caching
  const tunnel = await collections.tunnels.findOne(
    { $or: [{ id: tunnelId }, { domain: tunnelId }] }
  );

  // Also cache by the alternate key (domain or ID) for lookups
  if (tunnel) {
    if (tunnel.id && tunnel.id !== tunnelId) {
      ipSecurityCache.set(tunnel.id, security);
    }
    if (tunnel.domain && tunnel.domain !== tunnelId) {
      ipSecurityCache.set(tunnel.domain, security);
    }
  }

  // Persist to MongoDB (update tunnel document)
  await collections.tunnels.updateOne(
    { $or: [{ id: tunnelId }, { domain: tunnelId }] },
    { $set: { ipSecurity: security, updatedAt: Date.now() } }
  );

  console.log(`🔐 Updated IP security for tunnel ${tunnelId}: mode=${security.mode}`);
}

/**
 * Set allowlist mode with IPs
 */
export async function setTunnelAllowlist(
  tunnelId: string,
  allowedIps: string[],
  updatedBy?: string
): Promise<void> {
  await setTunnelIpSecurity(tunnelId, {
    mode: 'allowlist',
    allowedIps,
    blockedIps: [],
  }, updatedBy);
}

/**
 * Set blocklist mode with IPs
 */
export async function setTunnelBlocklist(
  tunnelId: string,
  blockedIps: string[],
  updatedBy?: string
): Promise<void> {
  await setTunnelIpSecurity(tunnelId, {
    mode: 'blocklist',
    allowedIps: [],
    blockedIps,
  }, updatedBy);
}

/**
 * Set allow-all mode (default, no restrictions)
 */
export async function setTunnelAllowAll(tunnelId: string, updatedBy?: string): Promise<void> {
  await setTunnelIpSecurity(tunnelId, {
    mode: 'allow-all',
    allowedIps: [],
    blockedIps: [],
  }, updatedBy);
}

/**
 * Add IP to tunnel's allowlist (if in allowlist mode) or blocklist (if in blocklist mode)
 */
export async function addIpToTunnelSecurity(
  tunnelId: string,
  ip: string,
  listType: 'allow' | 'block',
  updatedBy?: string
): Promise<void> {
  const current = getTunnelIpSecurity(tunnelId);

  if (listType === 'allow') {
    const allowedIps = current.allowedIps || [];
    if (!allowedIps.includes(ip)) {
      allowedIps.push(ip);
    }
    await setTunnelIpSecurity(tunnelId, {
      ...current,
      mode: 'allowlist',
      allowedIps,
    }, updatedBy);
  } else {
    const blockedIps = current.blockedIps || [];
    if (!blockedIps.includes(ip)) {
      blockedIps.push(ip);
    }
    await setTunnelIpSecurity(tunnelId, {
      ...current,
      mode: 'blocklist',
      blockedIps,
    }, updatedBy);
  }
}

/**
 * Remove IP from tunnel's allowlist or blocklist
 */
export async function removeIpFromTunnelSecurity(
  tunnelId: string,
  ip: string,
  updatedBy?: string
): Promise<void> {
  const current = getTunnelIpSecurity(tunnelId);

  const allowedIps = (current.allowedIps || []).filter(i => i !== ip);
  const blockedIps = (current.blockedIps || []).filter(i => i !== ip);

  await setTunnelIpSecurity(tunnelId, {
    ...current,
    allowedIps,
    blockedIps,
  }, updatedBy);
}

/**
 * Load IP security settings from MongoDB on startup
 */
export async function loadIpSecurityFromDb(): Promise<void> {
  try {
    const collections = getCollections();

    // Load from tunnels collection
    const tunnels = await collections.tunnels.find(
      { ipSecurity: { $exists: true } },
      { projection: { id: 1, domain: 1, ipSecurity: 1 } }
    ).toArray();

    for (const tunnel of tunnels) {
      if (tunnel.ipSecurity) {
        const tunnelKey = tunnel.id || tunnel.domain;
        ipSecurityCache.set(tunnelKey, tunnel.ipSecurity as TunnelIpSecurity);
      }
    }

    console.log(`📋 Loaded IP security settings for ${ipSecurityCache.size} tunnels from DB`);
  } catch (error) {
    console.error('⚠️ Failed to load IP security from DB:', error);
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
  clientId?: string;  // Layered client identifier
  status: 'allowed' | 'blocked' | 'rate_limited';
  reason?: string;
  bytesIn?: number;
  bytesOut?: number;
  duration?: number;
}): void {
  // Feature flag: Skip logging if disabled
  if (!ENABLE_CONNECTION_LOGS) {
    // Still log to console for security events (blocked/rate_limited)
    if (params.status !== 'allowed') {
      console.log(`🛡️ [${params.type.toUpperCase()}] ${params.status}: ${params.remoteIp} -> ${params.tunnelId} (${params.reason})`);
    }
    return;
  }

  const log: ConnectionLog = {
    id: generateLogId(),
    tunnelId: params.tunnelId,
    organizationId: params.organizationId,
    type: params.type,
    remoteIp: params.remoteIp,
    clientId: params.clientId,
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
  // Feature flag: Skip flushing if logging disabled
  if (!ENABLE_CONNECTION_LOGS) return;

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

// How long an abuse-pattern entry stays relevant. Entries older than this are
// swept in cleanupExpiredEntries — without that sweep this map grows forever,
// since a key is only deleted when its IP actually crosses a block threshold.
// Every scanner that probes once and leaves used to occupy a slot permanently.
const ABUSE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

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

  const entry = suspiciousPatterns.get(key);

  if (!entry || now - entry.firstSeen > ABUSE_WINDOW_MS) {
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

// Hard cap on token bucket maps to prevent unbounded growth
// (1 tunnelId × many unique IPs = many entries)
const MAX_TOKEN_BUCKET_ENTRIES = 50_000;

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

  // =========================================================
  // PRIMARY MEMORY LEAK FIX: Token bucket cleanup
  // These Maps grow for every unique IP/client that ever
  // hit a tunnel and were NEVER cleaned up previously.
  // Evict any bucket that is fully refilled (client has been
  // quiet) and hasn't been touched in the last 5 minutes.
  // =========================================================
  const BUCKET_IDLE_TTL = 5 * 60 * 1000; // 5 minutes idle = evict
  for (const [key, bucket] of httpTokenBuckets.entries()) {
    if (bucket.tokens >= bucket.maxTokens && now - bucket.lastRefill > BUCKET_IDLE_TTL) {
      httpTokenBuckets.delete(key);
    }
  }
  for (const [key, bucket] of tcpTokenBuckets.entries()) {
    if (bucket.tokens >= bucket.maxTokens && now - bucket.lastRefill > BUCKET_IDLE_TTL) {
      tcpTokenBuckets.delete(key);
    }
  }

  // Hard cap: if we somehow still have too many entries (very high traffic),
  // evict the oldest-inserted half to keep memory bounded.
  if (httpTokenBuckets.size > MAX_TOKEN_BUCKET_ENTRIES) {
    const toDelete = httpTokenBuckets.size - MAX_TOKEN_BUCKET_ENTRIES;
    let deleted = 0;
    for (const key of httpTokenBuckets.keys()) {
      if (deleted++ >= toDelete) break;
      httpTokenBuckets.delete(key);
    }
  }
  if (tcpTokenBuckets.size > MAX_TOKEN_BUCKET_ENTRIES) {
    const toDelete = tcpTokenBuckets.size - MAX_TOKEN_BUCKET_ENTRIES;
    let deleted = 0;
    for (const key of tcpTokenBuckets.keys()) {
      if (deleted++ >= toDelete) break;
      tcpTokenBuckets.delete(key);
    }
  }

  // Cleanup expired tunnel-level request count windows
  for (const [key, entry] of tunnelRequestCounts.entries()) {
    if (now - entry.windowStart > 60000) tunnelRequestCounts.delete(key);
  }

  // Cleanup expired blocked IPs
  for (const [ip, entry] of blockedIps.entries()) {
    if (entry.expiresAt <= now) blockedIps.delete(ip);
  }

  // Cleanup old suspicious patterns
  for (const [key, entry] of suspiciousPatterns.entries()) {
    if (now - entry.firstSeen > ABUSE_WINDOW_MS) suspiciousPatterns.delete(key);
  }

  // Safety net for per-client TCP connection counts. These are keyed by client
  // IP and are now deleted at zero on the decrement path, but a connection that
  // closes without its handler running would otherwise strand a slot forever —
  // and on a public endpoint that means one slot per scanning IP.
  for (const [key, count] of tcpConnectionsPerClient.entries()) {
    if (count <= 0) tcpConnectionsPerClient.delete(key);
  }

  console.log(
    `🧹 Security cleanup: httpBuckets=${httpTokenBuckets.size} tcpBuckets=${tcpTokenBuckets.size} ` +
    `blocked=${blockedIps.size} abuse=${suspiciousPatterns.size} tcpClients=${tcpConnectionsPerClient.size}`
  );
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

  // Flush logs every minute (only if logging enabled)
  if (ENABLE_CONNECTION_LOGS) {
    flushInterval = setInterval(flushConnectionLogs, LOG_FLUSH_INTERVAL);
    console.log('🛡️ Security service initialized (connection logging: ENABLED)');
  } else {
    console.log('🛡️ Security service initialized (connection logging: DISABLED)');
  }
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
