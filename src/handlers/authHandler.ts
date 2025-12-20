import * as authService from "../services/authService";
import * as organizationService from "../services/organizationService";
import * as monitoringService from "../services/monitoringService";
import type { User } from "../types/index";

// Helper to create JSON response
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /auth/login - Get OAuth login URL
export function handleGetLoginUrl(): Response {
  const state = crypto.randomUUID();
  const loginUrl = authService.getOAuthLoginUrl(state);

  return jsonResponse({
    success: true,
    loginUrl,
    state,
  });
}

// POST /auth/callback - Handle OAuth callback
export async function handleOAuthCallback(req: Request): Promise<Response> {
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  
  try {
    const body = await req.json();
    const { code, state, codeVerifier } = body;

    if (!code) {
      monitoringService.trackAuthAttempt(false, clientIp);
      return jsonResponse({ success: false, message: "Authorization code is required" }, 400);
    }

    // Exchange code for tokens
    const tokens = await authService.exchangeCodeForTokens(code, state, codeVerifier);

    // Fetch user info from KOOMPI
    const koompUser = await authService.fetchKoompiUserInfo(tokens.access_token);

    // Find or create user in our database
    const user = await authService.findOrCreateUser(koompUser.user);

    // Create session
    const userAgent = req.headers.get("user-agent") || undefined;
    const ipAddress = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || undefined;
    const session = await authService.createSession(user.id, userAgent, ipAddress);

    // Get user's organizations
    const organizations = await organizationService.getUserOrganizations(user.id);

    // Track successful auth
    monitoringService.trackAuthAttempt(true, user.email || clientIp);

    return jsonResponse({
      success: true,
      token: session.token,
      user: sanitizeUser(user),
      organizations: organizations.map(org => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        role: org.members.find(m => m.userId === user.id)?.role,
      })),
    });
  } catch (error) {
    console.error("OAuth callback error:", error);
    // Track failed auth
    monitoringService.trackAuthAttempt(false, clientIp);
    
    return jsonResponse({
      success: false,
      message: error instanceof Error ? error.message : "Authentication failed",
    }, 500);
  }
}

// GET /auth/me - Get current user info
export async function handleGetCurrentUser(req: Request): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext || !authContext.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organizations = await organizationService.getUserOrganizations(authContext.user.id);

  return jsonResponse({
    success: true,
    user: sanitizeUser(authContext.user),
    organizations: organizations.map(org => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: org.members.find(m => m.userId === authContext.user!.id)?.role,
    })),
  });
}

// POST /auth/logout - Logout current session
export async function handleLogout(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ success: true, message: "Logged out" });
  }

  // Note: We can't easily revoke a specific session without decoding the JWT
  // For now, just return success - client should clear the token
  return jsonResponse({ success: true, message: "Logged out" });
}

// GET /auth/users - Get all users (super admin only)
export async function handleGetAllUsers(req: Request): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user || authContext.user.role !== "super_admin") {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "100");
  const skip = parseInt(url.searchParams.get("skip") || "0");

  const users = await authService.getAllUsers(limit, skip);

  return jsonResponse({
    success: true,
    users: users.map(sanitizeUser),
  });
}

// PUT /auth/users/:id/role - Update user role (super admin only)
export async function handleUpdateUserRole(req: Request, userId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user || authContext.user.role !== "super_admin") {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  try {
    const body = await req.json();
    const { role } = body;

    if (!role || !["super_admin", "admin", "member"].includes(role)) {
      return jsonResponse({ success: false, message: "Invalid role" }, 400);
    }

    const user = await authService.updateUserRole(userId, role);

    if (!user) {
      return jsonResponse({ success: false, message: "User not found" }, 404);
    }

    return jsonResponse({
      success: true,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      message: error instanceof Error ? error.message : "Failed to update user role",
    }, 500);
  }
}

// DELETE /auth/users/:id - Deactivate user (super admin only)
export async function handleDeactivateUser(req: Request, userId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user || authContext.user.role !== "super_admin") {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  // Prevent self-deactivation
  if (authContext.user.id === userId) {
    return jsonResponse({ success: false, message: "Cannot deactivate yourself" }, 400);
  }

  const success = await authService.deactivateUser(userId);

  if (!success) {
    return jsonResponse({ success: false, message: "User not found" }, 404);
  }

  return jsonResponse({ success: true, message: "User deactivated" });
}

// Remove sensitive fields from user object
function sanitizeUser(user: User): Partial<User> {
  return {
    id: user.id,
    email: user.email,
    fullname: user.fullname,
    username: user.username,
    profile: user.profile,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    isActive: user.isActive,
    status: user.status,
  };
}
