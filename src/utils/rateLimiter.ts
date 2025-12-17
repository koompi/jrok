/**
 * Rate limiting to prevent abuse
 * Tracks requests per IP and per domain
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequestsPerWindow: number; // Max requests per window
}

// Store for rate limit entries
const globalLimiter = new Map<string, RateLimitEntry>();
const domainLimiter = new Map<string, RateLimitEntry>();

/**
 * Global rate limiter config for domain registration
 */
const DOMAIN_REGISTER_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequestsPerWindow: 5, // Max 5 registrations per hour per IP
};

/**
 * Per-domain rate limiter config for certificate operations
 */
const DOMAIN_CERT_LIMIT: RateLimitConfig = {
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  maxRequestsPerWindow: 5, // Max 5 cert operations per 24h per domain (Let's Encrypt limit is 50/week)
};

/**
 * Auth rate limiter config for login/callback endpoints (prevent brute force)
 */
const AUTH_LIMIT: RateLimitConfig = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequestsPerWindow: 20, // Max 20 auth attempts per 15 min per IP
};

// Store for auth rate limit entries
const authLimiter = new Map<string, RateLimitEntry>();

/**
 * Check if auth request is rate limited (per IP)
 * Returns null if allowed, error message if rate limited
 */
export function checkAuthRateLimit(ip: string): null | { retryAfter: number } {
  const now = Date.now();
  const key = `auth:${ip}`;

  let entry = authLimiter.get(key);

  if (!entry || now > entry.resetTime) {
    // Create new entry
    entry = {
      count: 1,
      resetTime: now + AUTH_LIMIT.windowMs,
    };
    authLimiter.set(key, entry);
    return null;
  }

  entry.count++;

  if (entry.count > AUTH_LIMIT.maxRequestsPerWindow) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
    return { retryAfter };
  }

  return null;
}

/**
 * Check if request is rate limited (global per IP)
 * Returns null if allowed, error message if rate limited
 */
export function checkGlobalRateLimit(ip: string): null | { retryAfter: number } {
  const now = Date.now();
  const key = ip;

  let entry = globalLimiter.get(key);

  if (!entry || now > entry.resetTime) {
    // Create new entry
    entry = {
      count: 1,
      resetTime: now + DOMAIN_REGISTER_LIMIT.windowMs,
    };
    globalLimiter.set(key, entry);
    return null;
  }

  entry.count++;

  if (entry.count > DOMAIN_REGISTER_LIMIT.maxRequestsPerWindow) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
    return { retryAfter };
  }

  return null;
}

/**
 * Check if request is rate limited (per domain)
 * Returns null if allowed, error message if rate limited
 */
export function checkDomainRateLimit(domain: string): null | { retryAfter: number } {
  const now = Date.now();
  const key = `cert:${domain}`;

  let entry = domainLimiter.get(key);

  if (!entry || now > entry.resetTime) {
    // Create new entry
    entry = {
      count: 1,
      resetTime: now + DOMAIN_CERT_LIMIT.windowMs,
    };
    domainLimiter.set(key, entry);
    return null;
  }

  entry.count++;

  if (entry.count > DOMAIN_CERT_LIMIT.maxRequestsPerWindow) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
    return { retryAfter };
  }

  return null;
}

/**
 * Get client IP from request
 */
export function getClientIp(req: Request): string {
  // Check X-Forwarded-For header (for proxies)
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }

  // Check X-Real-IP header
  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  // Fallback to connection IP if available via Bun
  const connectionIp = (req as any).socket?.remoteAddress || "unknown";
  return connectionIp;
}

/**
 * Reset rate limit for a specific IP
 */
export function resetGlobalRateLimit(ip: string): void {
  globalLimiter.delete(ip);
  console.log(`🔄 Reset global rate limit for IP: ${ip}`);
}

/**
 * Reset rate limit for a specific domain
 */
export function resetDomainRateLimit(domain: string): void {
  domainLimiter.delete(`cert:${domain}`);
  console.log(`🔄 Reset domain rate limit for: ${domain}`);
}

/**
 * Cleanup old entries (run periodically)
 */
export function cleanupExpiredLimits(): void {
  const now = Date.now();
  let globalCleanedCount = 0;
  let domainCleanedCount = 0;
  let authCleanedCount = 0;

  // Clean global limiter
  for (const [key, entry] of globalLimiter.entries()) {
    if (now > entry.resetTime) {
      globalLimiter.delete(key);
      globalCleanedCount++;
    }
  }

  // Clean domain limiter
  for (const [key, entry] of domainLimiter.entries()) {
    if (now > entry.resetTime) {
      domainLimiter.delete(key);
      domainCleanedCount++;
    }
  }

  // Clean auth limiter
  for (const [key, entry] of authLimiter.entries()) {
    if (now > entry.resetTime) {
      authLimiter.delete(key);
      authCleanedCount++;
    }
  }

  if (globalCleanedCount > 0 || domainCleanedCount > 0 || authCleanedCount > 0) {
    console.log(
      `🧹 Rate limit cleanup: ${globalCleanedCount} global, ${domainCleanedCount} domain, ${authCleanedCount} auth entries`
    );
  }
}

/**
 * Get current rate limit status for an IP
 */
export function getGlobalLimitStatus(ip: string): {
  count: number;
  limit: number;
  resetIn: number;
} | null {
  const entry = globalLimiter.get(ip);
  if (!entry) return null;

  const now = Date.now();
  if (now > entry.resetTime) {
    return null;
  }

  return {
    count: entry.count,
    limit: DOMAIN_REGISTER_LIMIT.maxRequestsPerWindow,
    resetIn: entry.resetTime - now,
  };
}

/**
 * Get current rate limit status for a domain
 */
export function getDomainLimitStatus(domain: string): {
  count: number;
  limit: number;
  resetIn: number;
} | null {
  const entry = domainLimiter.get(`cert:${domain}`);
  if (!entry) return null;

  const now = Date.now();
  if (now > entry.resetTime) {
    return null;
  }

  return {
    count: entry.count,
    limit: DOMAIN_CERT_LIMIT.maxRequestsPerWindow,
    resetIn: entry.resetTime - now,
  };
}
