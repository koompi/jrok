import * as adminService from "../services/adminService";
import { getSession } from "../services/authService";

// Helper to create JSON response
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Middleware to check if user is super admin
async function requireSuperAdmin(req: Request): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  const token = authHeader.split(" ")[1];
  const session = await getSession(token);

  if (!session) {
    return jsonResponse({ success: false, message: "Invalid token" }, 401);
  }

  const isSuper = await adminService.isSuperAdmin(session.userId);
  if (!isSuper) {
    return jsonResponse({ success: false, message: "Forbidden: Super Admin access required" }, 403);
  }

  return null;
}

// GET /admin/organizations
export async function handleListOrganizations(req: Request): Promise<Response> {
  const authError = await requireSuperAdmin(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = parseInt(url.searchParams.get("limit") || "20");
  const search = url.searchParams.get("search") || undefined;

  try {
    const result = await adminService.getAllOrganizations(page, limit, search);
    return jsonResponse({ success: true, ...result });
  } catch (error) {
    console.error("List organizations error:", error);
    return jsonResponse({ success: false, message: "Failed to list organizations" }, 500);
  }
}

// GET /admin/plans
export async function handleListPlans(req: Request): Promise<Response> {
  const authError = await requireSuperAdmin(req);
  if (authError) return authError;

  try {
    const plans = await adminService.getAllPlans();
    return jsonResponse({ success: true, plans });
  } catch (error) {
    console.error("List plans error:", error);
    return jsonResponse({ success: false, message: "Failed to list plans" }, 500);
  }
}

// POST /admin/organizations/:orgId/plan
export async function handleUpgradePlan(req: Request, orgId: string): Promise<Response> {
  const authError = await requireSuperAdmin(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { planId } = body;

    if (!planId) {
      return jsonResponse({ success: false, message: "Plan ID is required" }, 400);
    }

    const subscription = await adminService.upgradeOrganizationPlan(orgId, planId);
    return jsonResponse({ success: true, subscription });
  } catch (error) {
    console.error("Upgrade plan error:", error);
    return jsonResponse({ 
      success: false, 
      message: error instanceof Error ? error.message : "Failed to upgrade plan" 
    }, 500);
  }
}

// GET /admin/settings
export async function handleGetSettings(req: Request): Promise<Response> {
  const authError = await requireSuperAdmin(req);
  if (authError) return authError;

  try {
    const settings = await adminService.getSystemSettings();
    return jsonResponse({ success: true, settings });
  } catch (error) {
    return jsonResponse({ success: false, message: "Failed to get settings" }, 500);
  }
}

// PUT /admin/settings
export async function handleUpdateSettings(req: Request): Promise<Response> {
  const authError = await requireSuperAdmin(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const settings = await adminService.updateSystemSettings(body);
    return jsonResponse({ success: true, settings });
  } catch (error) {
    return jsonResponse({ success: false, message: "Failed to update settings" }, 500);
  }
}

// GET /admin/users
export async function handleListUsers(req: Request): Promise<Response> {
  const authError = await requireSuperAdmin(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = parseInt(url.searchParams.get("limit") || "20");
  const search = url.searchParams.get("search") || undefined;

  try {
    const result = await adminService.getAllUsers(page, limit, search);
    return jsonResponse({ success: true, ...result });
  } catch (error) {
    return jsonResponse({ success: false, message: "Failed to list users" }, 500);
  }
}

// PUT /admin/users/:userId/status
export async function handleUpdateUserStatus(req: Request, userId: string): Promise<Response> {
  const authError = await requireSuperAdmin(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { status } = body;
    
    if (!['active', 'pending', 'disabled'].includes(status)) {
      return jsonResponse({ success: false, message: "Invalid status" }, 400);
    }

    await adminService.updateUserStatus(userId, status);
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ success: false, message: "Failed to update user status" }, 500);
  }
}

// PUT /admin/organizations/:orgId/status
export async function handleUpdateOrgStatus(req: Request, orgId: string): Promise<Response> {
  const authError = await requireSuperAdmin(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { status } = body;
    
    if (!['active', 'disabled'].includes(status)) {
      return jsonResponse({ success: false, message: "Invalid status" }, 400);
    }

    await adminService.updateOrganizationStatus(orgId, status);
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ success: false, message: "Failed to update organization status" }, 500);
  }
}
