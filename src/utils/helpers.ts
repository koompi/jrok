import crypto from "crypto";

export function generateId(): string {
  return crypto.randomUUID();
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
