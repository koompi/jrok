import type { AuthContext, TunnelResponse, ListTunnelsResponse, CreateTunnelRequest } from "../types/index";
import * as tunnelService from "../services/tunnelService";
import * as authService from "../services/authService";
import * as agentService from "../services/agentService";
import { checkOrgAccess, isPrivileged } from "../utils/access";
import { isReservedTunnelName } from "../utils/hostRouting";

// Helper to create JSON response
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleCreateTunnel(req: Request): Promise<Response> {
  // Authenticate - require API key or user auth
  const authContext = await authService.authenticateRequest(req);
  if (!authContext) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  try {
    const body = (await req.json()) as CreateTunnelRequest & { agentId: string; organizationId?: string };

    // Validate input
    if (!body.domain || !body.agentId) {
      return jsonResponse({
        success: false,
        message: "Missing required fields: domain, agentId",
      } as TunnelResponse, 400);
    }

    if (isReservedTunnelName(body.domain)) {
      return jsonResponse({ success: false, message: `'${body.domain}' is reserved` } as TunnelResponse, 403);
    }

    // The agent must be the caller's, and the tunnel is its organization's.
    // Any signed-in account used to name any connected agent and any
    // organizationId here: a record that holds the name from everyone else,
    // or a TCP port opened to another organization's agent (a database).
    const agent = await agentService.getAgentAsync(body.agentId);
    if (!agent || !(await checkOrgAccess(authContext, agent.organizationId)).allowed) {
      return jsonResponse({ success: false, message: "Agent not connected" } as TunnelResponse, 404);
    }
    const finalOrgId = isPrivileged(authContext) ? (body.organizationId || agent.organizationId) : agent.organizationId;

    const tunnel = await tunnelService.createTunnel(body, body.agentId, finalOrgId);

    return jsonResponse({
      success: true,
      message: "Tunnel created successfully",
      tunnel,
    } as TunnelResponse, 201);
  } catch (error) {
    return jsonResponse({
      success: false,
      message: "Failed to create tunnel",
      error: error instanceof Error ? error.message : String(error),
    } as TunnelResponse, 500);
  }
}

export async function handleListTunnels(req: Request): Promise<Response> {
  // Authenticate - require API key or user auth
  const authContext = await authService.authenticateRequest(req);
  if (!authContext) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  try {
    let tunnels;
    
    // Always filter by organization if available (both API key and session auth)
    if (authContext.organization) {
      tunnels = await tunnelService.listTunnelsByOrganization(authContext.organization.id);
    } else if (authContext.user?.role === 'super_admin') {
      // Super admin can see all tunnels
      tunnels = await tunnelService.listTunnels();
    } else {
      // No organization context and not super admin - no tunnels visible
      tunnels = [];
    }

    return jsonResponse({
      success: true,
      tunnels,
    } as ListTunnelsResponse);
  } catch (error) {
    return jsonResponse({
      success: false,
      tunnels: [],
    } as ListTunnelsResponse, 500);
  }
}

export async function handleGetTunnel(id: string, req?: Request, ctx?: AuthContext): Promise<Response> {
  // The server passes its own auth context (which also knows the server key).
  const authContext = ctx ?? (req ? await authService.authenticateRequest(req) : null);

  try {
    const tunnel = await tunnelService.getTunnel(id);

    if (!tunnel) {
      return jsonResponse({ success: false, message: "Tunnel not found" } as TunnelResponse, 404);
    }

    // Ownership (utils/access.ts). This used to be checked for API keys only,
    // so any signed-in dashboard account could read any tenant's tunnel.
    if (!(await checkOrgAccess(authContext, tunnel.organizationId)).allowed) {
      return jsonResponse({ success: false, message: "Tunnel not found" } as TunnelResponse, 404);
    }

    return jsonResponse({
      success: true,
      message: "Tunnel retrieved successfully",
      tunnel,
    } as TunnelResponse);
  } catch (error) {
    return jsonResponse({
      success: false,
      message: "Failed to retrieve tunnel",
      error: error instanceof Error ? error.message : String(error),
    } as TunnelResponse, 500);
  }
}

export async function handleDeleteTunnel(id: string, req?: Request, ctx?: AuthContext): Promise<Response> {
  // Auth required for delete. The server passes its own auth context (which
  // also knows the server key).
  const authContext = ctx ?? (req ? await authService.authenticateRequest(req) : null);
  if (!authContext) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  try {
    const tunnel = await tunnelService.getTunnel(id);
    
    if (!tunnel) {
      return jsonResponse({ success: false, message: "Tunnel not found" } as TunnelResponse, 404);
    }

    // Ownership (utils/access.ts). This used to be checked for API keys only,
    // so any signed-in dashboard account could delete any tenant's tunnel
    // (dropping its nginx config or freeing its TCP port).
    if (!(await checkOrgAccess(authContext, tunnel.organizationId)).allowed) {
      return jsonResponse({ success: false, message: "Tunnel not found" } as TunnelResponse, 404);
    }

    await tunnelService.deleteTunnel(id);

    return jsonResponse({
      success: true,
      message: "Tunnel deleted successfully",
    } as TunnelResponse);
  } catch (error) {
    return jsonResponse({
      success: false,
      message: "Failed to delete tunnel",
      error: error instanceof Error ? error.message : String(error),
    } as TunnelResponse, 500);
  }
}
