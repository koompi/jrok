import type { AgentMessage } from "../types/index";
import * as agentService from "../services/agentService";
import { validateApiKeyForAgent } from "../services/authService";

export async function handleAgentUpgrade(req: Request, server: any): Promise<Response> {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Expected websocket upgrade", { status: 400 });
  }

  const url = new URL(req.url);
  const domain = url.searchParams.get("domain");
  const localPort = url.searchParams.get("localPort");
  const localHost = url.searchParams.get("localHost") || "localhost";
  const authToken = url.searchParams.get("auth");

  if (!domain || !localPort || !authToken) {
    return new Response("Missing required parameters: domain, localPort, and auth are required", { status: 400 });
  }

  // Validate the auth token - must be a valid API key with tunnel:create permission
  const authResult = await validateApiKeyForAgent(authToken);
  if (!authResult.valid) {
    console.warn(`🚫 Agent auth failed for domain ${domain}: ${authResult.reason}`);
    return new Response(`Authentication failed: ${authResult.reason}`, { status: 401 });
  }

  // Domain name validation to prevent injection
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  if (!domainRegex.test(domain)) {
    return new Response("Invalid domain format", { status: 400 });
  }

  // Port validation
  const port = parseInt(localPort);
  if (isNaN(port) || port < 1 || port > 65535) {
    return new Response("Invalid port number", { status: 400 });
  }

  // Use Bun's server.upgrade() to handle the WebSocket upgrade
  const success = server.upgrade(req, {
    data: {
      domain,
      localPort: port,
      localHost,
      clientIp: req.headers.get("x-forwarded-for") || "unknown",
      organizationId: authResult.organizationId,
      apiKeyId: authResult.apiKeyId,
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
