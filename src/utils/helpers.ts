import crypto from "crypto";

export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a short random suffix (4 hex characters)
 * Used for making subdomains unique when there's a conflict
 */
export function generateShortSuffix(): string {
  return crypto.randomBytes(2).toString('hex'); // 4 chars like "a7b3"
}

/**
 * Sanitize a domain name for use as a subdomain
 * Converts dots to hyphens and removes invalid characters
 * Example: "jersen.app" -> "jersen-app"
 */
export function sanitizeDomainToSubdomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/\./g, '-')           // Replace dots with hyphens
    .replace(/[^a-z0-9-]/g, '')    // Remove invalid characters
    .replace(/-+/g, '-')           // Collapse multiple hyphens
    .replace(/^-|-$/g, '');        // Remove leading/trailing hyphens
}

export function validateApiKey(provided: string, expected: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function createBasicAuthMiddleware(apiKey: string) {
  return (req: Request): boolean => {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return false;
    }

    const token = authHeader.slice(7); // Remove "Bearer "
    try {
      return validateApiKey(token, apiKey);
    } catch {
      return false;
    }
  };
}
