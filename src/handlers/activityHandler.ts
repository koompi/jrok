import type { AuthContext, ActivityCategory, ListActivityResponse } from "../types/index";
import * as activityService from "../services/activityService";

/**
 * GET /api/activity - Get activity logs with filters
 */
export async function handleListActivity(
  req: Request,
  authContext: AuthContext
): Promise<Response> {
  try {
    if (!authContext.organization) {
      return new Response(
        JSON.stringify({ success: false, message: "Organization context required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const url = new URL(req.url);
    const category = url.searchParams.get("category") as ActivityCategory | null;
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const result = await activityService.getActivityLogs({
      organizationId: authContext.organization.id,
      category: category || undefined,
      startDate: startDate ? parseInt(startDate) : undefined,
      endDate: endDate ? parseInt(endDate) : undefined,
      limit,
      offset,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to fetch activity logs",
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * GET /api/activity/recent - Get recent activity
 */
export async function handleRecentActivity(
  req: Request,
  authContext: AuthContext
): Promise<Response> {
  try {
    if (!authContext.organization) {
      return new Response(
        JSON.stringify({ success: false, message: "Organization context required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "10");

    const activities = await activityService.getRecentActivity(
      authContext.organization.id,
      limit
    );

    return new Response(
      JSON.stringify({ success: true, activities }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to fetch recent activity",
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * GET /api/activity/summary - Get activity summary
 */
export async function handleActivitySummary(
  req: Request,
  authContext: AuthContext
): Promise<Response> {
  try {
    if (!authContext.organization) {
      return new Response(
        JSON.stringify({ success: false, message: "Organization context required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const url = new URL(req.url);
    const days = parseInt(url.searchParams.get("days") || "7");

    const summary = await activityService.getActivitySummary(
      authContext.organization.id,
      days
    );

    return new Response(
      JSON.stringify({ success: true, ...summary }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to fetch activity summary",
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
