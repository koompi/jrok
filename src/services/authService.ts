import { getCollections } from "../utils/mongodb";
import { generateId } from "../utils/helpers";
import { getSystemSettings } from "./adminService";
import type { 
  User, 
  AuthSession, 
  KoompiOAuthTokens, 
  KoompiUserInfo,
  AuthContext,
  ApiKey,
  Organization
} from "../types/index";
import crypto from "crypto";

// Environment configuration
const KOOMPI_CLIENT_ID = process.env.KOOMPI_CLIENT_ID || "";
const KOOMPI_CLIENT_SECRET = process.env.KOOMPI_CLIENT_SECRET || "";
const KOOMPI_REDIRECT_URI = process.env.KOOMPI_REDIRECT_URI || "http://localhost:3000/auth/callback";
const KOOMPI_OAUTH_URL = "https://oauth.koompi.org";
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ CRITICAL: JWT_SECRET environment variable is not set!");
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set in production");
  }
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || "dev-only-secret-do-not-use-in-production";
const JWT_EXPIRES_IN = 7 * 24 * 60 * 60; // 7 days in seconds

// Simple JWT implementation using crypto
function createJWT(payload: Record<string, unknown>, expiresIn: number): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresIn,
  };

  const base64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const base64Payload = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
  
  const signature = crypto
    .createHmac("sha256", EFFECTIVE_JWT_SECRET)
    .update(`${base64Header}.${base64Payload}`)
    .digest("base64url");

  return `${base64Header}.${base64Payload}.${signature}`;
}

function verifyJWT(token: string | null | undefined): Record<string, unknown> | null {
  try {
    if (!token || typeof token !== 'string') {
      return null;
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    
    const [header, payload, signature] = parts;
    
    const expectedSignature = crypto
      .createHmac("sha256", EFFECTIVE_JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");

    if (signature !== expectedSignature) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    
    // Check expiration
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

// Generate OAuth authorization URL
export function getOAuthLoginUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: KOOMPI_CLIENT_ID,
    redirect_uri: KOOMPI_REDIRECT_URI,
    scope: "profile.basic profile.contact",
    state: state || generateId(),
  });

  return `${KOOMPI_OAUTH_URL}/v1/oauth?${params.toString()}`;
}

// Exchange authorization code for tokens
export async function exchangeCodeForTokens(
  code: string, 
  state?: string,
  codeVerifier?: string
): Promise<KoompiOAuthTokens> {
  if (!KOOMPI_CLIENT_ID || !KOOMPI_CLIENT_SECRET) {
    throw new Error("KOOMPI_CLIENT_ID and KOOMPI_CLIENT_SECRET must be set");
  }

  console.log("Exchanging code for tokens...", { 
    code: code.substring(0, 10) + "...", 
    redirect_uri: KOOMPI_REDIRECT_URI,
    has_verifier: !!codeVerifier 
  });

  const response = await fetch(`${KOOMPI_OAUTH_URL}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: KOOMPI_CLIENT_ID,
      client_secret: KOOMPI_CLIENT_SECRET,
      redirect_uri: KOOMPI_REDIRECT_URI,
      state,
      code_verifier: codeVerifier,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Token exchange failed:", data);
    throw new Error(data.error || data.message || "Token exchange failed");
  }

  return data as KoompiOAuthTokens;
}

// Fetch user info from KOOMPI OAuth
export async function fetchKoompiUserInfo(accessToken: string): Promise<KoompiUserInfo> {
  if (!accessToken) {
    throw new Error("Access token is required to fetch user info");
  }

  const response = await fetch(`${KOOMPI_OAUTH_URL}/v1/oauth/userinfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || data.message || "Failed to fetch user info");
  }

  return data as KoompiUserInfo;
}

// Find or create user from KOOMPI OAuth data
export async function findOrCreateUser(koompUser: KoompiUserInfo["user"]): Promise<User> {
  const collections = getCollections();
  
  // Check if user exists
  let user = await collections.users.findOne({ koompId: koompUser._id }) as User | null;

  if (user) {
    // Update user info
    await collections.users.updateOne(
      { koompId: koompUser._id },
      {
        $set: {
          fullname: koompUser.fullname,
          username: koompUser.username,
          email: koompUser.email,
          profile: koompUser.profile,
          lastLoginAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
    );

    return {
      ...user,
      fullname: koompUser.fullname,
      username: koompUser.username,
      email: koompUser.email || user.email,
      profile: koompUser.profile,
      lastLoginAt: Date.now(),
    };
  }

  // Check if this is the first user (make them super admin)
  const userCount = await collections.users.countDocuments();
  const isSuperAdmin = userCount === 0;

  // Check system settings for waiting list
  const settings = await getSystemSettings();
  const initialStatus = isSuperAdmin ? 'active' : (settings.waitingListEnabled ? 'pending' : 'active');

  // Create new user
  const newUser: User = {
    id: generateId(),
    koompId: koompUser._id,
    email: koompUser.email || "",
    fullname: koompUser.fullname,
    username: koompUser.username,
    profile: koompUser.profile,
    role: isSuperAdmin ? "super_admin" : "member",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastLoginAt: Date.now(),
    isActive: true, // Keep for backward compatibility
    status: initialStatus,
  };

  await collections.users.insertOne(newUser);

  if (isSuperAdmin) {
    console.log(`🔑 First user registered as super admin: ${newUser.email || newUser.fullname}`);
  }

  return newUser;
}

// Create session for user
export async function createSession(
  userId: string, 
  userAgent?: string, 
  ipAddress?: string
): Promise<AuthSession> {
  const collections = getCollections();

  const expiresAt = Date.now() + JWT_EXPIRES_IN * 1000;
  const sessionId = generateId();

  const token = createJWT(
    { 
      sessionId,
      userId,
      type: "session",
    }, 
    JWT_EXPIRES_IN
  );

  const session: AuthSession = {
    id: sessionId,
    userId,
    token,
    expiresAt,
    createdAt: Date.now(),
    userAgent,
    ipAddress,
  };

  await collections.sessions.insertOne(session);

  return session;
}

// Validate session token
export async function validateSessionToken(token: string | null | undefined): Promise<User | null> {
  if (!token) {
    return null;
  }
  
  const decoded = verifyJWT(token);
  if (!decoded || decoded.type !== "session") {
    return null;
  }

  const collections = getCollections();
  
  // Check if session exists and is valid
  const session = await collections.sessions.findOne({
    id: decoded.sessionId,
    expiresAt: { $gt: Date.now() },
  });

  if (!session) {
    return null;
  }

  // Get user
  const user = await collections.users.findOne({ 
    id: decoded.userId,
    isActive: true,
  }) as User | null;

  return user;
}

// Get session by token
export async function getSession(token: string): Promise<AuthSession | null> {
  const decoded = verifyJWT(token);
  if (!decoded || decoded.type !== "session") {
    return null;
  }

  const collections = getCollections();
  
  const session = await collections.sessions.findOne({
    id: decoded.sessionId,
    expiresAt: { $gt: Date.now() },
  }) as AuthSession | null;

  return session;
}

// Validate API key
export async function validateApiKey(key: string): Promise<{ apiKey: ApiKey; organization: Organization } | null> {
  const collections = getCollections();

  // Hash the key for comparison
  const keyHash = crypto.createHash("sha256").update(key).digest("hex");

  const apiKey = await collections.apiKeys.findOne({
    key: keyHash,
    isActive: true,
    $or: [
      { expiresAt: null },
      { expiresAt: { $gt: Date.now() } },
    ],
  }) as ApiKey | null;

  if (!apiKey) {
    return null;
  }

  // Update last used
  await collections.apiKeys.updateOne(
    { id: apiKey.id },
    { $set: { lastUsedAt: Date.now() } }
  );

  // Get organization
  const organization = await collections.organizations.findOne({
    id: apiKey.organizationId,
    isActive: true,
  }) as Organization | null;

  if (!organization) {
    return null;
  }

  return { apiKey, organization };
}

// Authenticate request (supports both session token and API key)
export async function authenticateRequest(req: Request): Promise<AuthContext | null> {
  const authHeader = req.headers.get("authorization");

  if (!authHeader) {
    return null;
  }

  // Check for Bearer token (session)
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const user = await validateSessionToken(token);
    
    if (user) {
      return {
        user,
        isApiKeyAuth: false,
      };
    }

    // Try as API key (jrok_xxx format)
    if (token.startsWith("jrok_")) {
      const result = await validateApiKey(token);
      if (result) {
        return {
          apiKey: result.apiKey,
          organization: result.organization,
          isApiKeyAuth: true,
        };
      }
    }
  }

  // Check for API key in x-api-key header
  const apiKeyHeader = req.headers.get("x-api-key");
  if (apiKeyHeader) {
    const result = await validateApiKey(apiKeyHeader);
    if (result) {
      return {
        apiKey: result.apiKey,
        organization: result.organization,
        isApiKeyAuth: true,
      };
    }
  }

  return null;
}

// Revoke session
export async function revokeSession(sessionId: string): Promise<boolean> {
  const collections = getCollections();
  const result = await collections.sessions.deleteOne({ id: sessionId });
  return result.deletedCount > 0;
}

// Revoke all sessions for user
export async function revokeAllUserSessions(userId: string): Promise<number> {
  const collections = getCollections();
  const result = await collections.sessions.deleteMany({ userId });
  return result.deletedCount;
}

// Get user by ID
export async function getUserById(userId: string): Promise<User | null> {
  const collections = getCollections();
  return await collections.users.findOne({ id: userId, isActive: true }) as User | null;
}

// Get user by KOOMPI ID
export async function getUserByKoompId(koompId: string): Promise<User | null> {
  const collections = getCollections();
  return await collections.users.findOne({ koompId, isActive: true }) as User | null;
}

// Update user role (super admin only)
export async function updateUserRole(userId: string, role: User["role"]): Promise<User | null> {
  const collections = getCollections();
  
  const result = await collections.users.findOneAndUpdate(
    { id: userId },
    { $set: { role, updatedAt: Date.now() } },
    { returnDocument: "after" }
  );

  return result as User | null;
}

// Get all users (super admin only)
export async function getAllUsers(limit = 100, skip = 0): Promise<User[]> {
  const collections = getCollections();
  return await collections.users
    .find({ isActive: true })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray() as User[];
}

// Deactivate user (super admin only)
export async function deactivateUser(userId: string): Promise<boolean> {
  const collections = getCollections();
  
  const result = await collections.users.updateOne(
    { id: userId },
    { $set: { isActive: false, updatedAt: Date.now() } }
  );

  // Revoke all sessions
  await revokeAllUserSessions(userId);

  return result.modifiedCount > 0;
}

// Validate API key for agent WebSocket connections
export async function validateApiKeyForAgent(rawKey: string): Promise<{
  valid: boolean;
  reason?: string;
  organizationId?: string;
  apiKeyId?: string;
}> {
  if (!rawKey || typeof rawKey !== 'string') {
    return { valid: false, reason: "API key is required" };
  }

  // Must be a proper jrok_ prefixed key
  if (!rawKey.startsWith('jrok_')) {
    return { valid: false, reason: "Invalid API key format" };
  }

  const collections = getCollections();
  
  // Hash the key to compare with stored hash
  const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
  
  const apiKey = await collections.apiKeys.findOne({ 
    key: hash, 
    isActive: true 
  });
  
  if (!apiKey) {
    return { valid: false, reason: "Invalid or revoked API key" };
  }
  
  // Check expiration
  if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) {
    return { valid: false, reason: "API key has expired" };
  }
  
  // Check if key has tunnel:create permission (also accept tunnels:write for backward compatibility)
  const hasTunnelPermission = apiKey.permissions.includes('tunnel:create') || 
                               apiKey.permissions.includes('tunnels:write') || 
                               apiKey.permissions.includes('*');
  if (!hasTunnelPermission) {
    return { valid: false, reason: "API key does not have tunnel:create permission" };
  }
  
  // Update last used timestamp
  await collections.apiKeys.updateOne(
    { id: apiKey.id },
    { $set: { lastUsedAt: Date.now() } }
  );
  
  return { 
    valid: true, 
    organizationId: apiKey.organizationId,
    apiKeyId: apiKey.id
  };
}
