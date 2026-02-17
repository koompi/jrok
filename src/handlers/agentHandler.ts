import type { AgentMessage, TunnelProtocol, TunnelIpSecurity } from "../types/index";
import * as agentService from "../services/agentService";
import { validateApiKeyForAgent } from "../services/authService";
import * as monitoringService from "../services/monitoringService";
import * as planLimitService from "../services/planLimitService";
import * as securityService from "../services/securityService";
import * as db from "../utils/database";

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

  // Multi-agent group parameters
  const groupMode = url.searchParams.get("groupMode") === "true";
  const instanceId = url.searchParams.get("instanceId");
  const requestedOrgId = url.searchParams.get("organizationId");

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

  // TCP protocol doesn't support group mode (load balancing)
  if (protocol === 'tcp' && groupMode) {
    return new Response("TCP protocol does not support group mode. Use HTTP protocol for load-balanced multi-agent deployments.", { status: 400 });
  }

  // Validate the auth token - must be a valid API key with tunnel:create permission
  const authResult = await validateApiKeyForAgent(authToken);
  if (!authResult.valid) {
    console.warn(`🚫 Agent auth failed for domain ${domain}: ${authResult.reason}`);
    return new Response(`Authentication failed: ${authResult.reason}`, { status: 401 });
  }

  // Handle organization impersonation (for admin/system keys to act on behalf of users)
  let effectiveOrgId = authResult.organizationId;

  if (requestedOrgId && requestedOrgId !== authResult.organizationId) {
    const hasSudo = authResult.permissions?.includes('*') ||
      authResult.permissions?.includes('sudo') ||
      authResult.organizationId === 'af9ef06c-d009-4ed4-8d13-017622ac2014'; // Allow KOOMPI Cloud org to impersonate

    if (hasSudo) {
      effectiveOrgId = requestedOrgId;
      console.log(`🔐 Admin impersonating org ${requestedOrgId} for domain ${domain}`);
    } else {
      console.warn(`🚫 Unauthorized impersonation attempt for org ${requestedOrgId} by key ${authResult.apiKeyId}`);
      return new Response("Unauthorized to impersonate organization", { status: 403 });
    }
  }

  // For plan limits, use the API key's org (not impersonated org)
  // because impersonated orgs (from external systems like kconsole) may not have subscriptions in jrok
  const planLimitOrgId = authResult.organizationId;

  // ====== PLAN LIMIT CHECK: Tunnel Count ======
  if (planLimitOrgId) {
    console.log(`[AgentHandler] Checking tunnel limit for org: ${planLimitOrgId}, domain: ${domain}, effectiveOrg: ${effectiveOrgId}`);
    const tunnelLimit = await planLimitService.checkTunnelLimit(planLimitOrgId, domain, instanceId || undefined);
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
    const bandwidthLimit = await planLimitService.checkBandwidthLimit(planLimitOrgId);
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

  // Check if this is a custom domain (contains dots) or a subdomain
  let isCustomDomain = false;
  let customDomainRecord = null;

  if (domain.includes('.')) {
    // This looks like a custom domain (e.g., jrok.jersen.app)
    // Validate it's a registered and active custom domain
    customDomainRecord = await db.getCustomDomainByName(domain);

    if (!customDomainRecord) {
      return new Response(`Custom domain '${domain}' is not registered. Use 'jrok domain register' first.`, { status: 400 });
    }

    if (!customDomainRecord.active) {
      return new Response(`Custom domain '${domain}' is not verified. Use 'jrok domain verify' to issue SSL certificate.`, { status: 400 });
    }

    // SECURITY: Verify the user has permission to use this custom domain
    // The custom domain MUST have an organizationId (set when registered)
    // AND the user's organization MUST match
    if (!customDomainRecord.organizationId) {
      // Domain was registered without an organization - this is a legacy domain
      // For security, we should require ownership
      console.warn(`⚠️ Custom domain ${domain} has no organizationId set - blocking access`);
      return new Response(`Custom domain '${domain}' has no owner configured. Please contact support.`, { status: 403 });
    }

    if (!effectiveOrgId) {
      // User is not associated with any organization
      return new Response(`You must be part of an organization to use custom domains.`, { status: 403 });
    }

    if (customDomainRecord.organizationId !== effectiveOrgId) {
      // Domain belongs to a different organization
      console.warn(`🚫 User from org ${effectiveOrgId} tried to use domain ${domain} owned by org ${customDomainRecord.organizationId}`);
      return new Response(`Custom domain '${domain}' belongs to another organization.`, { status: 403 });
    }

    isCustomDomain = true;
    console.log(`✅ Custom domain validated: ${domain} (org: ${effectiveOrgId})`);
  } else {
    // Simple subdomain - validate format
    const subdomainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    if (!subdomainRegex.test(domain)) {
      return new Response("Invalid subdomain format", { status: 400 });
    }
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
      organizationId: effectiveOrgId,
      apiKeyOrgId: authResult.organizationId, // API key's org for plan limits (Enterprise)
      apiKeyId: authResult.apiKeyId,
      protocol,
      forceNew,
      isCustomDomain, // Flag to indicate this is a custom domain tunnel
      // Multi-agent group settings
      groupMode,
      instanceId,
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

export async function handleListAgents(): Promise<Response> {
  const agents = await agentService.getAllAgentsAsync();

  return new Response(
    JSON.stringify({
      success: true,
      agents,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
