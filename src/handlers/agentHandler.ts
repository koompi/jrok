import type { AgentMessage } from "../types/index";
import * as agentService from "../services/agentService";

export function handleAgentUpgrade(req: Request, server: any): Response {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Expected websocket upgrade", { status: 400 });
  }

  const url = new URL(req.url);
  const domain = url.searchParams.get("domain");
  const localPort = url.searchParams.get("localPort");
  const localHost = url.searchParams.get("localHost") || "localhost";
  const authToken = url.searchParams.get("auth");

  if (!domain || !localPort || !authToken) {
    return new Response("Missing required parameters", { status: 400 });
  }

  // TODO: Validate auth token against config.apiKey

  // Use Bun's server.upgrade() to handle the WebSocket upgrade
  const success = server.upgrade(req, {
    data: {
      domain,
      localPort: parseInt(localPort),
      localHost,
      clientIp: req.headers.get("x-forwarded-for") || "unknown",
    },
  });

  if (!success) {
    return new Response("Failed to upgrade connection", { status: 400 });
  }

  return undefined as any;
}

export function handleListAgents(): Response {
  const agents = agentService.getAllAgents();

  return new Response(
    JSON.stringify({
      success: true,
      agents,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
