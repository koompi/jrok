/**
 * DISTRIBUTED Rate Limiting using MongoDB
 * 
 * Rate limits are stored in MongoDB for consistency across all servers.
 * Uses sliding window algorithm with atomic operations.
 */

import { getCollections } from "./mongodb";

// =============================================================================
// CONFIGURATION
// =============================================================================

interface RateLimitConfig {
  windowMs: number;
  maxRequestsPerWindow: number;
}

const DOMAIN_REGISTER_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequestsPerWindow: 5, // Max 5 registrations per hour per IP
};

const DOMAIN_CERT_LIMIT: RateLimitConfig = {
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  maxRequestsPerWindow: 5, // Max 5 cert operations per 24h per domain
};

const AUTH_LIMIT: RateLimitConfig = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequestsPerWindow: 20, // Max 20 auth attempts per 15 min per IP
};

const HTTP_REQUEST_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequestsPerWindow: 1000, // Max 1000 requests per minute per tunnel
};

// =============================================================================
// DISTRIBUTED RATE LIMIT CHECK (MongoDB)
// =============================================================================

interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  remaining?: number;
}

/**
 * Check rate limit using MongoDB atomic operations
 */
async function checkRateLimitMongo(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const collections = getCollections();
  const now = new Date();
  const windowStart = new Date(now.getTime() - config.windowMs);
  const expiresAt = new Date(now.getTime() + config.windowMs);

  try {
    // Atomic increment with sliding window
    const result = await collections.rateLimits.findOneAndUpdate(
      { key },
      {
        $setOnInsert: {
          key,
          windowStart: now,
          expiresAt,
        },
        $inc: { count: 1 },
        $set: { lastRequest: now },
      },
      { upsert: true, returnDocument: 'after' }
    );

    const doc = result.value;
    if (!doc) {
      return { allowed: true, remaining: config.maxRequestsPerWindow - 1 };
    }

    // Check if window has expired
    if (doc.windowStart && new Date(doc.windowStart) < windowStart) {
      // Reset the window
      await collections.rateLimits.updateOne(
        { key },
        {
          $set: {
            count: 1,
            windowStart: now,
            expiresAt,
            lastRequest: now,
          },
        }
      );
      return { allowed: true, remaining: config.maxRequestsPerWindow - 1 };
    }

    // Check if over limit
    if (doc.count > config.maxRequestsPerWindow) {
      const resetTime = new Date(doc.windowStart).getTime() + config.windowMs;
      const retryAfter = Math.ceil((resetTime - now.getTime()) / 1000);
      return { allowed: false, retryAfter, remaining: 0 };
    }

    return {
      allowed: true,
      remaining: config.maxRequestsPerWindow - doc.count,
    };
  } catch (error) {
    console.error("Rate limit check error:", error);
    // Fail open to avoid blocking requests during DB issues
    return { allowed: true };
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Check auth rate limit (per IP) - distributed
 */
export async function checkAuthRateLimitAsync(ip: string): Promise<null | { retryAfter: number }> {
  const result = await checkRateLimitMongo(`auth:${ip}`, AUTH_LIMIT);
  return result.allowed ? null : { retryAfter: result.retryAfter || 60 };
}

/**
 * Check global rate limit (per IP) - distributed
 */
export async function checkGlobalRateLimitAsync(ip: string): Promise<null | { retryAfter: number }> {
  const result = await checkRateLimitMongo(`global:${ip}`, DOMAIN_REGISTER_LIMIT);
  return result.allowed ? null : { retryAfter: result.retryAfter || 3600 };
}

/**
 * Check domain rate limit - distributed
 */
export async function checkDomainRateLimitAsync(domain: string): Promise<null | { retryAfter: number }> {
  const result = await checkRateLimitMongo(`cert:${domain}`, DOMAIN_CERT_LIMIT);
  return result.allowed ? null : { retryAfter: result.retryAfter || 86400 };
}

/**
 * Check HTTP request rate limit per tunnel - distributed
 */
export async function checkHttpRateLimitAsync(tunnelId: string): Promise<RateLimitResult> {
  return checkRateLimitMongo(`http:${tunnelId}`, HTTP_REQUEST_LIMIT);
}

/**
 * Check HTTP request rate limit per tunnel with custom limits
 */
export async function checkHttpRateLimitWithConfig(
  tunnelId: string,
  maxRequestsPerMinute: number
): Promise<RateLimitResult> {
  return checkRateLimitMongo(`http:${tunnelId}`, {
    windowMs: 60 * 1000,
    maxRequestsPerWindow: maxRequestsPerMinute,
  });
}

// =============================================================================
// BACKWARD COMPATIBLE SYNC WRAPPERS
// =============================================================================

// In-memory fallback for sync functions (used during DB connection issues)
const localFallback = new Map<string, { count: number; resetTime: number }>();

function checkLocalRateLimit(key: string, config: RateLimitConfig): null | { retryAfter: number } {
  const now = Date.now();
  let entry = localFallback.get(key);

  if (!entry || now > entry.resetTime) {
    entry = { count: 1, resetTime: now + config.windowMs };
    localFallback.set(key, entry);
    return null;
  }

  entry.count++;
  if (entry.count > config.maxRequestsPerWindow) {
    return { retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
  }
  return null;
}

/**
 * Sync version - uses local fallback, prefer async version
 */
export function checkAuthRateLimit(ip: string): null | { retryAfter: number } {
  return checkLocalRateLimit(`auth:${ip}`, AUTH_LIMIT);
}

/**
 * Sync version - uses local fallback, prefer async version
 */
export function checkGlobalRateLimit(ip: string): null | { retryAfter: number } {
  return checkLocalRateLimit(`global:${ip}`, DOMAIN_REGISTER_LIMIT);
}

/**
 * Sync version - uses local fallback, prefer async version
 */
export function checkDomainRateLimit(domain: string): null | { retryAfter: number } {
  return checkLocalRateLimit(`cert:${domain}`, DOMAIN_CERT_LIMIT);
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Get client IP from request
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  const connectionIp = (req as any).socket?.remoteAddress || "unknown";
  return connectionIp;
}

/**
 * Reset rate limit for a specific key - distributed
 */
export async function resetRateLimitAsync(key: string): Promise<void> {
  const collections = getCollections();
  await collections.rateLimits.deleteOne({ key });
  localFallback.delete(key);
  console.log(`🔄 Reset rate limit for: ${key}`);
}

/**
 * Reset global rate limit for IP - distributed
 */
export async function resetGlobalRateLimitAsync(ip: string): Promise<void> {
  await resetRateLimitAsync(`global:${ip}`);
}

/**
 * Reset domain rate limit - distributed
 */
export async function resetDomainRateLimitAsync(domain: string): Promise<void> {
  await resetRateLimitAsync(`cert:${domain}`);
}

// Sync wrappers that also clear local
export function resetGlobalRateLimit(ip: string): void {
  localFallback.delete(`global:${ip}`);
  resetGlobalRateLimitAsync(ip).catch(console.error);
}

export function resetDomainRateLimit(domain: string): void {
  localFallback.delete(`cert:${domain}`);
  resetDomainRateLimitAsync(domain).catch(console.error);
}

/**
 * Cleanup expired entries - MongoDB TTL index handles this automatically
 * This cleans up local fallback only
 */
export function cleanupExpiredLimits(): void {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [key, entry] of localFallback.entries()) {
    if (now > entry.resetTime) {
      localFallback.delete(key);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`🧹 Local rate limit cleanup: ${cleanedCount} entries`);
  }
}

/**
 * Get rate limit status - distributed
 */
export async function getRateLimitStatusAsync(key: string): Promise<{
  count: number;
  limit: number;
  resetIn: number;
} | null> {
  const collections = getCollections();
  const doc = await collections.rateLimits.findOne({ key });
  
  if (!doc) return null;

  const now = Date.now();
  const resetTime = new Date(doc.windowStart).getTime() + (doc.windowMs || 60000);
  
  if (now > resetTime) {
    return null;
  }

  return {
    count: doc.count,
    limit: doc.maxRequestsPerWindow || 100,
    resetIn: resetTime - now,
  };
}

// Sync versions for backward compat
export function getGlobalLimitStatus(ip: string): {
  count: number;
  limit: number;
  resetIn: number;
} | null {
  const entry = localFallback.get(`global:${ip}`);
  if (!entry) return null;

  const now = Date.now();
  if (now > entry.resetTime) return null;

  return {
    count: entry.count,
    limit: DOMAIN_REGISTER_LIMIT.maxRequestsPerWindow,
    resetIn: entry.resetTime - now,
  };
}

export function getDomainLimitStatus(domain: string): {
  count: number;
  limit: number;
  resetIn: number;
} | null {
  const entry = localFallback.get(`cert:${domain}`);
  if (!entry) return null;

  const now = Date.now();
  if (now > entry.resetTime) return null;

  return {
    count: entry.count,
    limit: DOMAIN_CERT_LIMIT.maxRequestsPerWindow,
    resetIn: entry.resetTime - now,
  };
}
