import type { AuthContext } from "../types/index";
import * as statsService from "../services/statsService";

/**
 * GET /api/stats/dashboard - Get dashboard overview stats
 */
export async function handleDashboardStats(
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

    const stats = await statsService.getDashboardStats(authContext.organization.id);

    return new Response(
      JSON.stringify({ success: true, stats }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to fetch dashboard stats",
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * GET /api/stats/bandwidth - Get bandwidth usage
 */
export async function handleBandwidthStats(
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
    const period = (url.searchParams.get("period") || "month") as "day" | "week" | "month";

    const bandwidth = await statsService.getBandwidthUsage(
      authContext.organization.id,
      period
    );

    return new Response(
      JSON.stringify({ success: true, ...bandwidth }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to fetch bandwidth stats",
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * GET /api/tunnels/enhanced - Get enhanced tunnel list with stats
 */
export async function handleEnhancedTunnels(
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

    const tunnels = await statsService.getEnhancedTunnels(authContext.organization.id);

    return new Response(
      JSON.stringify({ success: true, tunnels }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to fetch tunnels",
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * GET /api/agents/enhanced - Get enhanced agent list with system info
 */
export async function handleEnhancedAgents(
  req: Request,
  authContext: AuthContext
): Promise<Response> {
  try {
    const agents = await statsService.getEnhancedAgents(authContext.organization?.id);

    return new Response(
      JSON.stringify({ success: true, agents }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to fetch agents",
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * GET /api/domains/enhanced - Get enhanced domain list with SSL info
 */
export async function handleEnhancedDomains(
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

    const domains = await statsService.getEnhancedDomains(authContext.organization.id);

    return new Response(
      JSON.stringify({ success: true, domains }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to fetch domains",
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
