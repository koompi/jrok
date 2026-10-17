import type { Agent, AgentMessage, AuthContext, TunnelProtocol, TunnelIpSecurity } from "../types/index";
import * as agentService from "../services/agentService";
import { validateApiKeyForAgent } from "../services/authService";
import * as monitoringService from "../services/monitoringService";
import * as planLimitService from "../services/planLimitService";
import { PROXY_MODE } from "../config/proxyMode";
import * as securityService from "../services/securityService";
import * as db from "../utils/database";
import { getClientIp } from "../utils/clientIp";
import { resolveAgentOrg } from "../config/impersonation";
import { isPrivileged, filterOwned } from "../utils/access";

/**
 * The agent's API key, from `Authorization: Bearer <key>` or — for older CLIs,
 * which deploy workers still run — the `?auth=` query parameter.
 *
 * The query form put the key in the URL, and nginx's `combined` access log
 * writes every URL to disk. For kconsole that key is the platform key that may
 * act for other organizations, so it was sitting in plain text in a log file on
 * every edge server.
 *
 * A jrok key in the header wins. Anything else in the header (something a proxy
 * added, say) doesn't shadow a query key an old CLI sent.
 */
export function extractAgentToken(req: Request, url: URL = new URL(req.url)): { token: string | null; fromQuery: boolean } {
  const match = /^Bearer\s+(\S+)\s*$/i.exec((req.headers.get("authorization") || "").trim());
  const headerToken = match?.[1] || null;
  if (headerToken?.startsWith("jrok_")) return { token: headerToken, fromQuery: false };

  const query = url.searchParams.get("auth");
  if (query) return { token: query, fromQuery: true };
  return { token: headerToken, fromQuery: false };
}

// One deprecation warning per agent (key + domain), not one per reconnect. Bounded,
// because it is keyed on values clients choose.
const warnedQueryAuth = new Set<string>();
const MAX_WARNED_QUERY_AUTH = 10_000;

function warnQueryAuthOnce(apiKeyId: string | undefined, domain: string): void {
  const key = `${apiKeyId || "?"}:${domain}`;
  if (warnedQueryAuth.has(key)) return;
  if (warnedQueryAuth.size >= MAX_WARNED_QUERY_AUTH) warnedQueryAuth.clear();
  warnedQueryAuth.add(key);
  console.warn(
    `⚠️ Agent for ${domain} (API key ${apiKeyId || "unknown"}) sent its key in the URL (?auth=). ` +
    `Deprecated: the key ends up in proxy access logs. Upgrade the jrok CLI; current versions send it as Authorization: Bearer.`
  );
}

export async function handleAgentUpgrade(req: Request, server: any): Promise<Response> {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Expected websocket upgrade", { status: 400 });
  }

  const url = new URL(req.url);
  const domain = url.searchParams.get("domain");
  const localPort = url.searchParams.get("localPort");
  const localHost = url.searchParams.get("localHost") || "localhost";
  const { token: authToken, fromQuery: authFromQuery } = extractAgentToken(req, url);
  const protocol = (url.searchParams.get("protocol") || "http") as TunnelProtocol;
  const forceNew = url.searchParams.get("forceNew") === "true";

  // Multi-agent group parameters
  const groupMode = url.searchParams.get("groupMode") === "true";
  const instanceId = url.searchParams.get("instanceId");
  const requestedOrgId = url.searchParams.get("organizationId");

  // CLI capabilities (e.g. "stream,b64body") — absent for older CLIs, which
  // then get the legacy buffered/text-body protocol
  const caps = url.searchParams.get("caps")?.split(",").map(c => c.trim()).filter(Boolean);

  // IP Security parameters from CLI
  const ipSecurityMode = url.searchParams.get("ipSecurityMode") as TunnelIpSecurity['mode'] | null;
  const allowedIpsParam = url.searchParams.get("allowedIps");
  const blockedIpsParam = url.searchParams.get("blockedIps");

  // Per-IP agent connection limits key on this, so it must be the real peer:
  // a spoofable value let anyone dodge the limit or exhaust someone else's.
  const clientIp = getClientIp(req, server?.requestIP?.(req)?.address);

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
    return new Response("Missing required parameters: domain, localPort, and auth (Authorization: Bearer <key>) are required", { status: 400 });
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

  if (authFromQuery) {
    warnQueryAuthOnce(authResult.apiKeyId, domain);
  }

  // Organization impersonation: kconsole's platform key acting for a customer
  // org on that customer's custom domain. See config/impersonation.ts.
  const orgDecision = resolveAgentOrg(authResult, requestedOrgId, domain.includes('.'));
  if (orgDecision.action === "deny") {
    console.warn(`🚫 Unauthorized impersonation attempt for org ${requestedOrgId} by key ${authResult.apiKeyId}`);
    return new Response("Unauthorized to impersonate organization", { status: 403 });
  }
  if (orgDecision.action === "impersonate") {
    console.log(`🔐 Key ${authResult.apiKeyId} acting for org ${requestedOrgId} on custom domain ${domain}`);
  } else if (orgDecision.action === "ignore") {
    console.warn(`⚠️ Ignoring organizationId ${requestedOrgId} from key ${authResult.apiKeyId} for ${domain}: only honoured for custom domains`);
  }
  const effectiveOrgId = orgDecision.organizationId;

  // For plan limits, use the API key's org (not impersonated org)
  // because impersonated orgs (from external systems like kconsole) may not have subscriptions in jrok
  const planLimitOrgId = authResult.organizationId;

  // ====== PLAN LIMIT CHECK: Tunnel Count ======
  // Proxy mode skips these entirely — kconsole decides who may run how many
  // tunnels; jrok just carries the traffic. checkTunnelLimit alone cost three
  // MongoDB queries per agent connect.
  if (!PROXY_MODE && planLimitOrgId) {
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
      // CLI capabilities
      caps,
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

/**
 * GET /agents. Privileged callers (server key, super-admin, kconsole's platform
 * key) get every agent, unchanged. Anyone else used to get them too — every
 * organization's agents with their client IPs and internal hosts. Now they get
 * their own orgs' agents, without the network details: nothing in the
 * dashboard or CLI reads this endpoint (the dashboard uses /agents/enhanced).
 */
export async function handleListAgents(authContext: AuthContext): Promise<Response> {
  const all = await agentService.getAllAgentsAsync();
  const agents = isPrivileged(authContext)
    ? all
    : (await filterOwned(authContext, all, (a) => a.organizationId)).map(withoutNetworkDetails);

  return new Response(
    JSON.stringify({
      success: true,
      agents,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** An agent without where it connects from or to. */
export function withoutNetworkDetails<T extends Partial<Agent>>(agent: T): Omit<T, "clientIp" | "localHost" | "localPort" | "serverHost" | "serverId"> {
  const { clientIp, localHost, localPort, serverHost, serverId, ...rest } = agent;
  return rest;
}
