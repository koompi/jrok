import type { TunnelResponse, ListTunnelsResponse, CreateTunnelRequest } from "../types/index";
import * as tunnelService from "../services/tunnelService";
import * as authService from "../services/authService";

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

  // Get organization ID from auth context
  const organizationId = authContext.isApiKeyAuth 
    ? authContext.organization?.id 
    : null; // For user auth, org should be passed in body

  try {
    const body = (await req.json()) as CreateTunnelRequest & { agentId: string; organizationId?: string };

    // Validate input
    if (!body.domain || !body.agentId) {
      return jsonResponse({
        success: false,
        message: "Missing required fields: domain, agentId",
      } as TunnelResponse, 400);
    }

    // Use org from API key or from body
    const finalOrgId = organizationId || body.organizationId;

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
    
    if (authContext.isApiKeyAuth && authContext.organization) {
      // API key auth - only show tunnels for this organization
      tunnels = await tunnelService.listTunnelsByOrganization(authContext.organization.id);
    } else if (authContext.user) {
      // User auth - show all tunnels (or filter by user's orgs)
      tunnels = await tunnelService.listTunnels();
    } else {
      return jsonResponse({ success: false, message: "Unauthorized" }, 401);
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

export async function handleGetTunnel(id: string, req?: Request): Promise<Response> {
  // Auth is optional for get - but if provided, verify ownership
  const authContext = req ? await authService.authenticateRequest(req) : null;

  try {
    const tunnel = await tunnelService.getTunnel(id);

    if (!tunnel) {
      return jsonResponse({ success: false, message: "Tunnel not found" } as TunnelResponse, 404);
    }

    // If using API key auth, verify tunnel belongs to their org
    if (authContext?.isApiKeyAuth && authContext.organization) {
      if (tunnel.organizationId && tunnel.organizationId !== authContext.organization.id) {
        return jsonResponse({ success: false, message: "Forbidden" }, 403);
      }
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

export async function handleDeleteTunnel(id: string, req?: Request): Promise<Response> {
  // Auth required for delete
  const authContext = req ? await authService.authenticateRequest(req) : null;
  if (!authContext) {
    return jsonResponse({ success: false, message: "Unauthorized" }, 401);
  }

  try {
    const tunnel = await tunnelService.getTunnel(id);
    
    if (!tunnel) {
      return jsonResponse({ success: false, message: "Tunnel not found" } as TunnelResponse, 404);
    }

    // If using API key auth, verify tunnel belongs to their org
    if (authContext.isApiKeyAuth && authContext.organization) {
      if (tunnel.organizationId && tunnel.organizationId !== authContext.organization.id) {
        return jsonResponse({ success: false, message: "Forbidden" }, 403);
      }
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
