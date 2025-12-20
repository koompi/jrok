import type { AgentMessage, TunnelProtocol, TunnelIpSecurity } from "../types/index";
import * as agentService from "../services/agentService";
import { validateApiKeyForAgent } from "../services/authService";
import * as monitoringService from "../services/monitoringService";
import * as planLimitService from "../services/planLimitService";
import * as securityService from "../services/securityService";

export async function handleAgentUpgrade(req: Request, server: any): Promise<Response> {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Expected websocket upgrade", { status: 400 });
  }

  const url = new URL(req.url);
  const domain = url.searchParams.get("domain");
  const localPort = url.searchParams.get("localPort");
  const localHost = url.searchParams.get("localHost") || "localhost";
  const authToken = url.searchParams.get("auth");
  const protocol = (url.searchParams.get("protocol") || "http") as TunnelProtocol;
  const forceNew = url.searchParams.get("forceNew") === "true";
  
  // IP Security parameters from CLI
  const ipSecurityMode = url.searchParams.get("ipSecurityMode") as TunnelIpSecurity['mode'] | null;
  const allowedIpsParam = url.searchParams.get("allowedIps");
  const blockedIpsParam = url.searchParams.get("blockedIps");

  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // Check connection limits before processing
  const connectionCheck = monitoringService.canAcceptAgentConnection(clientIp);
  if (!connectionCheck.allowed) {
    monitoringService.addLog('warn', 'connections', `Agent connection rejected: ${connectionCheck.reason}`, { clientIp, domain });
    return new Response(
      JSON.stringify({ error: connectionCheck.reason }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!domain || !localPort || !authToken) {
    return new Response("Missing required parameters: domain, localPort, and auth are required", { status: 400 });
  }

  // Validate protocol
  if (protocol !== 'http' && protocol !== 'tcp') {
    return new Response("Invalid protocol. Must be 'http' or 'tcp'", { status: 400 });
  }

  // Validate the auth token - must be a valid API key with tunnel:create permission
  const authResult = await validateApiKeyForAgent(authToken);
  if (!authResult.valid) {
    console.warn(`🚫 Agent auth failed for domain ${domain}: ${authResult.reason}`);
    return new Response(`Authentication failed: ${authResult.reason}`, { status: 401 });
  }

  // ====== PLAN LIMIT CHECK: Tunnel Count ======
  if (authResult.organizationId) {
    const tunnelLimit = await planLimitService.checkTunnelLimit(authResult.organizationId);
    if (!tunnelLimit.allowed) {
      console.warn(`🚫 Tunnel limit reached for org ${authResult.organizationId}: ${tunnelLimit.current}/${tunnelLimit.limit}`);
      monitoringService.addLog('warn', 'plan_limits', `Tunnel limit reached`, { 
        organizationId: authResult.organizationId, 
        current: tunnelLimit.current, 
        limit: tunnelLimit.limit,
        domain 
      });
      return new Response(
        JSON.stringify({ 
          error: tunnelLimit.reason,
          current: tunnelLimit.current,
          limit: tunnelLimit.limit,
        }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }
    
    // ====== PLAN LIMIT CHECK: Bandwidth ======
    const bandwidthLimit = await planLimitService.checkBandwidthLimit(authResult.organizationId);
    if (!bandwidthLimit.allowed || bandwidthLimit.suspended) {
      console.warn(`🚫 Bandwidth limit exceeded for org ${authResult.organizationId}`);
      monitoringService.addLog('warn', 'plan_limits', `Bandwidth limit exceeded`, { 
        organizationId: authResult.organizationId, 
        current: bandwidthLimit.current, 
        limit: bandwidthLimit.limit,
        domain 
      });
      return new Response(
        JSON.stringify({ 
          error: bandwidthLimit.reason,
          currentGb: bandwidthLimit.current,
          limitGb: bandwidthLimit.limit,
        }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }
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
      clientIp,
      organizationId: authResult.organizationId,
      apiKeyId: authResult.apiKeyId,
      protocol,
      forceNew,
      // IP Security settings from CLI
      ipSecurity: ipSecurityMode ? {
        mode: ipSecurityMode,
        allowedIps: allowedIpsParam ? allowedIpsParam.split(',').map(ip => ip.trim()) : [],
        blockedIps: blockedIpsParam ? blockedIpsParam.split(',').map(ip => ip.trim()) : [],
      } : undefined,
    },
  });

  if (!success) {
    return new Response("Failed to upgrade connection", { status: 400 });
  }

  // Track the connection after successful upgrade
  monitoringService.registerAgentConnection(clientIp);

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
