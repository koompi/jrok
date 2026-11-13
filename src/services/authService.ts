import { getCollections } from "../utils/mongodb";
import { generateId } from "../utils/helpers";
import { getSystemSettings } from "./adminService";
import { newAccountStatus } from "../config/selfServe";
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
    hasCode: !!code,
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
    console.error("Token exchange failed:", { status: response.status, hasError: !!data.error });
    // Generic error message for security - don't expose OAuth details
    throw new Error("Authentication failed. Please try again.");
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

  // Waiting list, or self-serve closed (config/selfServe.ts): a new account
  // starts pending, with no organization and no way to make one.
  const settings = await getSystemSettings();
  const initialStatus = newAccountStatus(isSuperAdmin, settings.waitingListEnabled);

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

// ===== SESSION CACHE FOR PERFORMANCE =====
interface SessionCacheEntry {
  user: User;
  timestamp: number;
}

const sessionCache = new Map<string, SessionCacheEntry>();
const SESSION_CACHE_TTL = 60 * 1000; // 1 minute cache TTL (sessions change less frequently)

export function invalidateSessionCache(sessionId?: string): void {
  if (sessionId) {
    sessionCache.delete(sessionId);
  } else {
    sessionCache.clear();
  }
}

// Validate session token (with caching)
export async function validateSessionToken(token: string | null | undefined): Promise<User | null> {
  if (!token) {
    return null;
  }

  const decoded = verifyJWT(token);
  if (!decoded || decoded.type !== "session") {
    return null;
  }

  const sessionId = decoded.sessionId as string;

  // Check cache first
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL) {
    return cached.user;
  }

  const collections = getCollections();

  // Check if session exists and is valid
  const session = await collections.sessions.findOne({
    id: sessionId,
    expiresAt: { $gt: Date.now() },
  });

  if (!session) {
    sessionCache.delete(sessionId);
    return null;
  }

  // Get user
  const user = await collections.users.findOne({
    id: decoded.userId,
    isActive: true,
  }) as User | null;

  // Cache the result
  if (user) {
    sessionCache.set(sessionId, { user, timestamp: Date.now() });
  }

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

// ===== API KEY CACHE FOR PERFORMANCE =====
// Avoids DB queries on every authenticated request.
//
// A revoked key, or a key of a disabled organization, used to keep working for
// up to 5 minutes from this cache, on every edge (nothing ever invalidated it).
// Now: 30 s on the other edges, at once on the edge that revoked it or disabled
// the organization (invalidateApiKeyCacheWhere), and never past the key's own
// expiry.

interface ApiKeyCacheEntry {
  apiKey: ApiKey;
  organization: Organization;
  timestamp: number;
}

const apiKeyCache = new Map<string, ApiKeyCacheEntry>();
export const API_KEY_CACHE_TTL = 30 * 1000;
const LAST_USED_UPDATE_INTERVAL = 60 * 1000; // Update lastUsedAt every minute max
const lastUsedUpdateTimes = new Map<string, number>();

export function invalidateApiKeyCache(keyHash?: string): void {
  agentKeyGeneration++;
  if (keyHash) {
    apiKeyCache.delete(keyHash);
    agentKeyCache.delete(keyHash);
  } else {
    apiKeyCache.clear();
    agentKeyCache.clear();
  }
}

/** Forget cached keys with this id, or of this organization (revoked, rotated, disabled): the REST and the agent caches. */
export function invalidateApiKeyCacheWhere(match: { keyId?: string; organizationId?: string }): void {
  agentKeyGeneration++;
  for (const [hash, entry] of apiKeyCache) {
    if ((match.keyId && entry.apiKey.id === match.keyId) ||
      (match.organizationId && entry.apiKey.organizationId === match.organizationId)) {
      apiKeyCache.delete(hash);
    }
  }
  for (const [hash, entry] of agentKeyCache) {
    if ((match.keyId && entry.result.apiKeyId === match.keyId) ||
      (match.organizationId && entry.result.organizationId === match.organizationId)) {
      agentKeyCache.delete(hash);
    }
  }
}

/** lastUsedAt, at most once a minute per key and never waited for. */
function touchKeyLastUsed(keyHash: string, keyId: string): void {
  const lastUpdate = lastUsedUpdateTimes.get(keyHash) || 0;
  if (Date.now() - lastUpdate <= LAST_USED_UPDATE_INTERVAL) return;
  lastUsedUpdateTimes.set(keyHash, Date.now());
  getCollections().apiKeys.updateOne({ id: keyId }, { $set: { lastUsedAt: Date.now() } }).catch(() => { });
}

// ===== AGENT KEY CACHE =====
// Every replica's agent connects with the platform's key, and each connect cost three operations (the key, its
// organization, an awaited lastUsedAt write to that one document) on a database that answers each edge about 100
// a second: 200 apps at once (600 agents) waited a median 32 s for their tunnels in KOOMPI Cloud's load test
// (2026-11-13), and every agent of a restarting edge or deploy server registers again the same way. A key that
// passed is kept like the REST cache keeps one: 30 s on the other edges, forgotten at once on the edge that
// revokes or rotates it or disables its organization, never past its own expiry. Agents connecting at the same
// moment share one lookup; a lookup an invalidation overtook is not kept (agentKeyGeneration).

type AgentKeyCheck = { valid: boolean; reason?: string; organizationId?: string; apiKeyId?: string; permissions?: string[] };
interface AgentKeyEntry { result: AgentKeyCheck & { valid: true; apiKeyId: string }; expiresAt?: number | null; timestamp: number }
const agentKeyCache = new Map<string, AgentKeyEntry>();
const agentKeyLookups = new Map<string, Promise<{ result: AgentKeyCheck; expiresAt?: number | null }>>();
let agentKeyGeneration = 0;

// Validate API key (with caching)
export async function validateApiKey(key: string): Promise<{ apiKey: ApiKey; organization: Organization } | null> {
  const collections = getCollections();

  // Hash the key for comparison
  const keyHash = crypto.createHash("sha256").update(key).digest("hex");

  // Check cache first
  const cached = apiKeyCache.get(keyHash);
  if (cached && Date.now() - cached.timestamp < API_KEY_CACHE_TTL &&
    !(cached.apiKey.expiresAt && cached.apiKey.expiresAt <= Date.now())) {
    // Update lastUsedAt only once per minute (not on every request!)
    const lastUpdate = lastUsedUpdateTimes.get(keyHash) || 0;
    if (Date.now() - lastUpdate > LAST_USED_UPDATE_INTERVAL) {
      lastUsedUpdateTimes.set(keyHash, Date.now());
      // Fire-and-forget update (don't await)
      collections.apiKeys.updateOne(
        { id: cached.apiKey.id },
        { $set: { lastUsedAt: Date.now() } }
      ).catch(() => { }); // Ignore errors for this non-critical update
    }
    return { apiKey: cached.apiKey, organization: cached.organization };
  }

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

  // Get organization
  const organization = await collections.organizations.findOne({
    id: apiKey.organizationId,
    isActive: true,
  }) as Organization | null;

  if (!organization) {
    return null;
  }

  // Cache the result
  apiKeyCache.set(keyHash, { apiKey, organization, timestamp: Date.now() });

  // Update lastUsedAt (fire-and-forget)
  lastUsedUpdateTimes.set(keyHash, Date.now());
  collections.apiKeys.updateOne(
    { id: apiKey.id },
    { $set: { lastUsedAt: Date.now() } }
  ).catch(() => { });

  return { apiKey, organization };
}

// ===== USER ORGANIZATION CACHE =====
interface UserOrgCacheEntry {
  organization: Organization | null;
  timestamp: number;
}

const userOrgCache = new Map<string, UserOrgCacheEntry>();
const USER_ORG_CACHE_TTL = 2 * 60 * 1000; // 2 minutes cache TTL

export function invalidateUserOrgCache(userId?: string): void {
  if (userId) {
    userOrgCache.delete(userId);
  } else {
    userOrgCache.clear();
  }
}

// Authenticate request (supports both session token and API key)
export async function authenticateRequest(req: Request): Promise<AuthContext | null> {
  const authHeader = req.headers.get("authorization");

  // Note: We don't return null immediately if authHeader is missing
  // because we also want to check for X-API-Key header below

  const collections = getCollections();

  // Check for Bearer token (session)
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const user = await validateSessionToken(token);

    if (user) {
      // Check cache for user's organization
      let organization: Organization | null = null;
      const cached = userOrgCache.get(user.id);

      if (cached && Date.now() - cached.timestamp < USER_ORG_CACHE_TTL) {
        organization = cached.organization;
      } else {
        // Fetch user's organization (they may be owner or member)
        organization = await collections.organizations.findOne({
          $or: [
            { ownerId: user.id },
            { "members.userId": user.id }
          ],
          isActive: true,
        }) as Organization | null;

        // Cache the result
        userOrgCache.set(user.id, { organization, timestamp: Date.now() });
      }

      return {
        user,
        organization: organization || undefined,
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

/** An organization that exists and isn't disabled (isActive unset counts as active). */
export function organizationIsActive(org: Pick<Organization, "isActive" | "status"> | null | undefined): boolean {
  return !!org && org.isActive !== false && org.status !== "disabled";
}

// Validate API key for agent WebSocket connections (cached: AGENT KEY CACHE above)
export async function validateApiKeyForAgent(rawKey: string): Promise<AgentKeyCheck> {
  if (!rawKey || typeof rawKey !== 'string') {
    return { valid: false, reason: "API key is required" };
  }

  // Must be a proper jrok_ prefixed key
  if (!rawKey.startsWith('jrok_')) {
    return { valid: false, reason: "Invalid API key format" };
  }

  // Hash the key to compare with stored hash
  const hash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const cached = agentKeyCache.get(hash);
  if (cached && Date.now() - cached.timestamp < API_KEY_CACHE_TTL && !(cached.expiresAt && cached.expiresAt < Date.now())) {
    touchKeyLastUsed(hash, cached.result.apiKeyId);
    return { ...cached.result, permissions: [...(cached.result.permissions ?? [])] };
  }

  let lookup = agentKeyLookups.get(hash);
  if (!lookup) {
    const generation = agentKeyGeneration;
    lookup = lookUpAgentKey(hash).then((found) => {
      // Kept only if no revocation or disabling came while it was being looked up
      if (found.result.valid && found.result.apiKeyId && generation === agentKeyGeneration) {
        agentKeyCache.set(hash, { result: found.result as AgentKeyEntry["result"], expiresAt: found.expiresAt, timestamp: Date.now() });
      }
      return found;
    }).finally(() => agentKeyLookups.delete(hash));
    agentKeyLookups.set(hash, lookup);
  }
  const { result } = await lookup;
  if (result.valid && result.apiKeyId) touchKeyLastUsed(hash, result.apiKeyId);
  return { ...result, ...(result.permissions && { permissions: [...result.permissions] }) };
}

/** The key and its organization from the database: whether it may connect agents. */
async function lookUpAgentKey(hash: string): Promise<{ result: AgentKeyCheck; expiresAt?: number | null }> {
  const collections = getCollections();
  const apiKey = await collections.apiKeys.findOne({
    key: hash,
    isActive: true
  });

  if (!apiKey) {
    return { result: { valid: false, reason: "Invalid or revoked API key" } };
  }

  // Check expiration
  if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) {
    return { result: { valid: false, reason: "API key has expired" } };
  }

  // The key's organization must still exist and be active. A disabled (or
  // deleted) organization's keys used to keep connecting agents, so disabling
  // an organization didn't stop its tunnels. Organizations from before the
  // isActive field count as active.
  const organization = await collections.organizations.findOne(
    { id: apiKey.organizationId },
    { projection: { isActive: 1, status: 1 } }
  ) as Pick<Organization, "isActive" | "status"> | null;
  if (!organizationIsActive(organization)) {
    return { result: { valid: false, reason: "API key's organization is disabled" } };
  }

  // Check if key has tunnel:create permission (also accept tunnels:write for backward compatibility)
  const hasTunnelPermission = apiKey.permissions.includes('tunnel:create') ||
    apiKey.permissions.includes('tunnels:write') ||
    apiKey.permissions.includes('*');
  if (!hasTunnelPermission) {
    return { result: { valid: false, reason: "API key does not have tunnel:create permission" } };
  }

  return {
    result: {
      valid: true,
      organizationId: apiKey.organizationId,
      apiKeyId: apiKey.id,
      permissions: apiKey.permissions
    },
    expiresAt: apiKey.expiresAt ?? null,
  };
}
