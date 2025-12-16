import type { TunnelResponse, ListTunnelsResponse, CreateTunnelRequest } from "../types/index";
import * as tunnelService from "../services/tunnelService";

export async function handleCreateTunnel(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as CreateTunnelRequest & { agentId: string };

    // Validate input
    if (!body.domain || !body.agentId) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Missing required fields: domain, agentId",
        } as TunnelResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const tunnel = await tunnelService.createTunnel(body, body.agentId);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Tunnel created successfully",
        tunnel,
      } as TunnelResponse),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to create tunnel",
        error: error instanceof Error ? error.message : String(error),
      } as TunnelResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleListTunnels(): Promise<Response> {
  try {
    const tunnels = await tunnelService.listTunnels();

    return new Response(
      JSON.stringify({
        success: true,
        tunnels,
      } as ListTunnelsResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        tunnels: [],
      } as ListTunnelsResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleGetTunnel(id: string): Promise<Response> {
  try {
    const tunnel = await tunnelService.getTunnel(id);

    if (!tunnel) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Tunnel not found",
        } as TunnelResponse),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Tunnel retrieved successfully",
        tunnel,
      } as TunnelResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to retrieve tunnel",
        error: error instanceof Error ? error.message : String(error),
      } as TunnelResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleDeleteTunnel(id: string): Promise<Response> {
  try {
    await tunnelService.deleteTunnel(id);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Tunnel deleted successfully",
      } as TunnelResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to delete tunnel",
        error: error instanceof Error ? error.message : String(error),
      } as TunnelResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
