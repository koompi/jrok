import * as authService from "../services/authService";
import * as organizationService from "../services/organizationService";
import * as apiKeyService from "../services/apiKeyService";
import type { ApiKeyPermission } from "../types/index";

// Helper to create JSON response
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /organizations - Create organization
export async function handleCreateOrganization(req: Request): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  try {
    const body = await req.json();
    const { name } = body;

    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return jsonResponse({ success: false, message: "Organization name is required (min 2 characters)" }, 400);
    }

    const organization = await organizationService.createOrganization(name.trim(), authContext.user);

    return jsonResponse({
      success: true,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        ownerId: organization.ownerId,
        members: organization.members,
        createdAt: organization.createdAt,
      },
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      message: error instanceof Error ? error.message : "Failed to create organization",
    }, 500);
  }
}

// GET /organizations - Get user's organizations
export async function handleGetOrganizations(req: Request): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organizations = await organizationService.getUserOrganizations(authContext.user.id);

  return jsonResponse({
    success: true,
    organizations: organizations.map(org => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      ownerId: org.ownerId,
      memberCount: org.members.length,
      role: org.members.find(m => m.userId === authContext.user!.id)?.role,
      createdAt: org.createdAt,
    })),
  });
}

// GET /organizations/:id - Get organization details
export async function handleGetOrganization(req: Request, orgId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organization = await organizationService.getOrganizationById(orgId);

  if (!organization) {
    return jsonResponse({ success: false, message: "Organization not found" }, 404);
  }

  // Check if user is a member
  if (!organizationService.isMember(organization, authContext.user.id) && authContext.user.role !== "super_admin") {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  // Get subscription info
  const subscriptionInfo = await organizationService.getOrganizationSubscription(organization.id);

  return jsonResponse({
    success: true,
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      ownerId: organization.ownerId,
      members: organization.members,
      createdAt: organization.createdAt,
      subscription: subscriptionInfo ? {
        status: subscriptionInfo.subscription.status,
        plan: {
          name: subscriptionInfo.plan.name,
          tier: subscriptionInfo.plan.tier,
          limits: subscriptionInfo.plan.limits,
        },
        currentPeriodEnd: subscriptionInfo.subscription.currentPeriodEnd,
      } : null,
    },
  });
}

// PUT /organizations/:id - Update organization
export async function handleUpdateOrganization(req: Request, orgId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organization = await organizationService.getOrganizationById(orgId);

  if (!organization) {
    return jsonResponse({ success: false, message: "Organization not found" }, 404);
  }

  // Check if user is admin or owner
  if (!organizationService.isAdminOrOwner(organization, authContext.user.id) && authContext.user.role !== "super_admin") {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  try {
    const body = await req.json();
    const { name } = body;

    const updated = await organizationService.updateOrganization(orgId, { name });

    if (!updated) {
      return jsonResponse({ success: false, message: "Failed to update organization" }, 500);
    }

    return jsonResponse({
      success: true,
      organization: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
      },
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      message: error instanceof Error ? error.message : "Failed to update organization",
    }, 500);
  }
}

// DELETE /organizations/:id - Delete organization
export async function handleDeleteOrganization(req: Request, orgId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organization = await organizationService.getOrganizationById(orgId);

  if (!organization) {
    return jsonResponse({ success: false, message: "Organization not found" }, 404);
  }

  // Only owner or super admin can delete
  if (!organizationService.isOwner(organization, authContext.user.id) && authContext.user.role !== "super_admin") {
    return jsonResponse({ success: false, message: "Only the owner can delete an organization" }, 403);
  }

  const success = await organizationService.deleteOrganization(orgId);

  return jsonResponse({
    success,
    message: success ? "Organization deleted" : "Failed to delete organization",
  });
}

// POST /organizations/:id/members - Add member
export async function handleAddMember(req: Request, orgId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organization = await organizationService.getOrganizationById(orgId);

  if (!organization) {
    return jsonResponse({ success: false, message: "Organization not found" }, 404);
  }

  if (!organizationService.isAdminOrOwner(organization, authContext.user.id)) {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  try {
    const body = await req.json();
    const { userId, role } = body;

    if (!userId || !role || !["admin", "member"].includes(role)) {
      return jsonResponse({ success: false, message: "Invalid user ID or role" }, 400);
    }

    // Check if user exists
    const userToAdd = await authService.getUserById(userId);
    if (!userToAdd) {
      return jsonResponse({ success: false, message: "User not found" }, 404);
    }

    // Check if already a member
    if (organizationService.isMember(organization, userId)) {
      return jsonResponse({ success: false, message: "User is already a member" }, 400);
    }

    const updated = await organizationService.addMember(orgId, userId, role);

    return jsonResponse({
      success: true,
      organization: updated,
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      message: error instanceof Error ? error.message : "Failed to add member",
    }, 500);
  }
}

// DELETE /organizations/:id/members/:userId - Remove member
export async function handleRemoveMember(req: Request, orgId: string, userId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organization = await organizationService.getOrganizationById(orgId);

  if (!organization) {
    return jsonResponse({ success: false, message: "Organization not found" }, 404);
  }

  // Can't remove the owner
  if (organization.ownerId === userId) {
    return jsonResponse({ success: false, message: "Cannot remove the owner" }, 400);
  }

  // User can remove themselves, or admins/owners can remove others
  if (authContext.user.id !== userId && !organizationService.isAdminOrOwner(organization, authContext.user.id)) {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  const updated = await organizationService.removeMember(orgId, userId);

  return jsonResponse({
    success: true,
    organization: updated,
  });
}

// ============ API Keys ============

// POST /organizations/:id/api-keys - Create API key
export async function handleCreateApiKey(req: Request, orgId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organization = await organizationService.getOrganizationById(orgId);

  if (!organization) {
    return jsonResponse({ success: false, message: "Organization not found" }, 404);
  }

  if (!organizationService.isAdminOrOwner(organization, authContext.user.id)) {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  // Check limits
  const subscriptionInfo = await organizationService.getOrganizationSubscription(organization.id);
  if (subscriptionInfo) {
    const canCreate = await apiKeyService.canCreateApiKey(organization, subscriptionInfo.plan);
    if (!canCreate.allowed) {
      return jsonResponse({ success: false, message: canCreate.reason }, 403);
    }
  }

  try {
    const body = await req.json();
    const { name, permissions, expiresIn } = body;

    if (!name || typeof name !== "string") {
      return jsonResponse({ success: false, message: "API key name is required" }, 400);
    }

    const validPermissions: ApiKeyPermission[] = [
      "tunnels:read", "tunnels:write", "tunnels:delete",
      "domains:read", "domains:write", "domains:delete",
      "agents:read"
    ];

    const keyPermissions: ApiKeyPermission[] = permissions && Array.isArray(permissions)
      ? permissions.filter(p => validPermissions.includes(p))
      : ["tunnels:read", "tunnels:write", "agents:read"]; // Default permissions

    const { apiKey, rawKey } = await apiKeyService.createApiKey(
      orgId,
      authContext.user.id,
      name,
      keyPermissions,
      expiresIn
    );

    return jsonResponse({
      success: true,
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        key: rawKey, // Only returned on creation!
        keyPrefix: apiKey.keyPrefix,
        permissions: apiKey.permissions,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
      },
      message: "Save this API key securely. You won't be able to see it again!",
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      message: error instanceof Error ? error.message : "Failed to create API key",
    }, 500);
  }
}

// GET /organizations/:id/api-keys - List API keys
export async function handleGetApiKeys(req: Request, orgId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organization = await organizationService.getOrganizationById(orgId);

  if (!organization) {
    return jsonResponse({ success: false, message: "Organization not found" }, 404);
  }

  if (!organizationService.isMember(organization, authContext.user.id)) {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  const apiKeys = await apiKeyService.getOrganizationApiKeys(orgId);

  return jsonResponse({
    success: true,
    apiKeys: apiKeys.map(key => ({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      permissions: key.permissions,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      isActive: key.isActive,
    })),
  });
}

// DELETE /organizations/:id/api-keys/:keyId - Revoke API key
export async function handleRevokeApiKey(req: Request, orgId: string, keyId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organization = await organizationService.getOrganizationById(orgId);

  if (!organization) {
    return jsonResponse({ success: false, message: "Organization not found" }, 404);
  }

  if (!organizationService.isAdminOrOwner(organization, authContext.user.id)) {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  // Verify key belongs to this organization
  const apiKey = await apiKeyService.getApiKeyById(keyId);
  if (!apiKey || apiKey.organizationId !== orgId) {
    return jsonResponse({ success: false, message: "API key not found" }, 404);
  }

  const success = await apiKeyService.revokeApiKey(keyId);

  return jsonResponse({
    success,
    message: success ? "API key revoked" : "Failed to revoke API key",
  });
}

// POST /organizations/:id/api-keys/:keyId/rotate - Rotate API key
export async function handleRotateApiKey(req: Request, orgId: string, keyId: string): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const organization = await organizationService.getOrganizationById(orgId);

  if (!organization) {
    return jsonResponse({ success: false, message: "Organization not found" }, 404);
  }

  if (!organizationService.isAdminOrOwner(organization, authContext.user.id)) {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  // Verify key belongs to this organization
  const existingKey = await apiKeyService.getApiKeyById(keyId);
  if (!existingKey || existingKey.organizationId !== orgId) {
    return jsonResponse({ success: false, message: "API key not found" }, 404);
  }

  const result = await apiKeyService.rotateApiKey(keyId);

  if (!result) {
    return jsonResponse({ success: false, message: "Failed to rotate API key" }, 500);
  }

  return jsonResponse({
    success: true,
    apiKey: {
      id: result.apiKey.id,
      name: result.apiKey.name,
      key: result.rawKey,
      keyPrefix: result.apiKey.keyPrefix,
      permissions: result.apiKey.permissions,
      expiresAt: result.apiKey.expiresAt,
      createdAt: result.apiKey.createdAt,
    },
    message: "API key rotated. Save the new key securely!",
  });
}

// ============ Plans ============

// GET /plans - Get all plans
export async function handleGetPlans(): Promise<Response> {
  const plans = await organizationService.getAllPlans();

  return jsonResponse({
    success: true,
    plans: plans.map(plan => ({
      id: plan.id,
      name: plan.name,
      tier: plan.tier,
      description: plan.description,
      price: plan.price,
      currency: plan.currency,
      interval: plan.interval,
      features: plan.features,
      limits: plan.limits,
    })),
  });
}

// ============ Admin ============

// GET /admin/organizations - Get all organizations (super admin only)
export async function handleGetAllOrganizations(req: Request): Promise<Response> {
  const authContext = await authService.authenticateRequest(req);

  if (!authContext?.user || authContext.user.role !== "super_admin") {
    return jsonResponse({ success: false, message: "Forbidden" }, 403);
  }

  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "100");
  const skip = parseInt(url.searchParams.get("skip") || "0");

  const organizations = await organizationService.getAllOrganizations(limit, skip);

  return jsonResponse({
    success: true,
    organizations: organizations.map(org => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      ownerId: org.ownerId,
      memberCount: org.members.length,
      createdAt: org.createdAt,
      isActive: org.isActive,
    })),
  });
}
