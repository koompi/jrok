import { createBasicAuthMiddleware } from "./utils/helpers";
import { setConfig, cleanupExpiredTunnels } from "./services/tunnelService";
import * as tunnelHandler from "./handlers/tunnelHandler";
import * as agentHandler from "./handlers/agentHandler";
import * as domainHandler from "./handlers/domainHandler";
import * as authHandler from "./handlers/authHandler";
import * as organizationHandler from "./handlers/organizationHandler";
import * as adminHandler from "./handlers/adminHandler";
import * as activityHandler from "./handlers/activityHandler";
import * as statsHandler from "./handlers/statsHandler";
import * as agentService from "./services/agentService";
import * as vpsService from "./services/vpsService";
import * as authService from "./services/authService";
import * as statsService from "./services/statsService";
import * as wsProxyService from "./services/wsProxyService";
import * as tcpService from "./services/tcpService";
import * as securityService from "./services/securityService";
import * as crossServerService from "./services/crossServerService";
import * as certSyncService from "./services/certificateSyncService";
import * as monitoringService from "./services/monitoringService";
import { connectDatabase, closeDatabase, createDistributedStateIndexes, cleanupStaleConnectionsOnStartup } from "./utils/mongodb";
import { cleanupExpiredLimits } from "./utils/rateLimiter";
import { initTelegram } from "./services/notificationService";
import { generateId } from "./utils/helpers";
import type { TunnelConfig, Agent, AuthContext, TunnelProtocol } from "./types/index";

// Store pending requests waiting for agent responses
const pendingRequests = new Map<string, {
  resolve: (response: Response) => void;
  timeout: Timer;
  bytesIn: number;
  agent: Agent;
  tunnelId?: string;
}>();

// Memory safety: Limit pending requests to prevent memory exhaustion
const MAX_PENDING_REQUESTS = 10000;

function cleanupOldestPendingRequest() {
  if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
    // Remove oldest entry
    const firstKey = pendingRequests.keys().next().value;
    if (firstKey) {
      const entry = pendingRequests.get(firstKey);
      if (entry) {
        clearTimeout(entry.timeout);
        entry.resolve(new Response(
          JSON.stringify({ success: false, message: "Server overloaded" }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        ));
      }
      pendingRequests.delete(firstKey);
    }
  }
}

// Handle WebSocket tunnel (client WebSocket -> agent -> local service WebSocket)
async function handleWebSocketTunnel(
  req: Request,
  server: any,
  agentWs: WebSocket,
  agent: Agent,
  subdomain: string
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const path = url.pathname + url.search;

  // Extract headers to forward to agent
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    // Forward relevant headers (exclude hop-by-hop headers)
    const skipHeaders = new Set(['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']);
    if (!skipHeaders.has(key.toLowerCase())) {
      headers[key] = value;
    }
  });

  console.log(`🔌 WebSocket upgrade request for ${subdomain}${path}`);

  // Upgrade the client connection to WebSocket
  const success = server.upgrade(req, {
    data: {
      agentWs,
      agent,
      subdomain,
      path,
      headers,
      type: 'client-tunnel',
    },
  });

  if (success) {
    return undefined;
  }

  return new Response("Failed to upgrade WebSocket connection", { status: 400 });
}

// Forward HTTP request to agent via WebSocket
async function forwardRequestToAgent(req: Request, agentWs: WebSocket, agent: Agent, tunnelId?: string, clientIp?: string): Promise<Response> {
  return new Promise(async (resolve) => {
    const requestId = generateId();
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(new Response(
        JSON.stringify({
          success: false,
          message: "Agent timeout - no response within 10 seconds"
        }),
        { status: 504, headers: { "Content-Type": "application/json" } }
      ));
    }, 10000); // 10 second timeout

    // Prepare request data to send to agent
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });

    try {
      // Read request body
      const body = await req.text();
      const bytesIn = new TextEncoder().encode(body).length +
        new TextEncoder().encode(JSON.stringify(headers)).length;

      // Memory safety: Cleanup oldest request if map is full
      cleanupOldestPendingRequest();

      // Store pending request with bandwidth tracking info
      pendingRequests.set(requestId, { resolve, timeout, bytesIn, agent, tunnelId });

      // Send request to agent
      agentWs.send(JSON.stringify({
        type: "http_request",
        requestId,
        method: req.method,
        path: new URL(req.url).pathname,
        query: new URL(req.url).search,
        headers,
        body,
        clientIp: clientIp || "unknown",
      }));
    } catch (error) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      resolve(new Response(`Error reading request: ${error}`, { status: 500 }));
    }
  });
}

// Configuration - adjust these to your setup
const config: TunnelConfig = {
  vpsHost: process.env.VPS_HOST || "your-vps.com",
  vpsUser: process.env.VPS_USER || "root",
  vpsPort: process.env.VPS_PORT ? parseInt(process.env.VPS_PORT) : 22,
  nginxConfPath: process.env.NGINX_PATH || "/etc/nginx/sites-available",
  baseDomain: process.env.BASE_DOMAIN || "tunnel.example.com",
  apiKey: process.env.API_KEY || "your-secret-key-change-this",
};

// Production environment validation
if (process.env.NODE_ENV === "production") {
  const requiredEnvVars = [
    'MONGODB_URI',
    'JWT_SECRET',
    'BASE_DOMAIN',
    'KOOMPI_CLIENT_ID',
    'KOOMPI_CLIENT_SECRET',
  ];

  const missing = requiredEnvVars.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error("❌ CRITICAL: Missing required environment variables in production:");
    missing.forEach(key => console.error(`   - ${key}`));
    console.error("\nPlease set all required environment variables before starting in production.");
    process.exit(1);
  }

  // Check for default/weak credentials
  if (config.apiKey === "your-secret-key-change-this") {
    console.error("❌ CRITICAL: Default API_KEY detected in production!");
    console.error("   Please set a secure API_KEY environment variable.");
    process.exit(1);
  }

  if ((process.env.JWT_SECRET || "").length < 32) {
    console.error("❌ CRITICAL: JWT_SECRET must be at least 32 characters in production!");
    console.error("   Generate a secure secret: openssl rand -base64 64");
    process.exit(1);
  }
}

// Initialize tunnel service with config
setConfig(config);

// Initialize Telegram notifications
initTelegram();

// Cache for organization plan tiers (avoid DB lookup on every request)
const orgPlanCache = new Map<string, { tier: string; timestamp: number }>();
const PLAN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_PLAN_CACHE_SIZE = 10000; // Prevent unbounded growth

// Periodic cleanup of expired plan cache entries
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [key, value] of orgPlanCache.entries()) {
    if (now - value.timestamp > PLAN_CACHE_TTL) {
      orgPlanCache.delete(key);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    console.log(`🧹 Plan cache cleanup: ${cleanedCount} expired entries removed`);
  }
}, 10 * 60 * 1000); // Run every 10 minutes

async function getPlanTierForOrg(organizationId: string): Promise<string> {
  // Check cache first
  const cached = orgPlanCache.get(organizationId);
  if (cached && Date.now() - cached.timestamp < PLAN_CACHE_TTL) {
    return cached.tier;
  }

  // Memory safety: Prevent unbounded cache growth
  if (orgPlanCache.size >= MAX_PLAN_CACHE_SIZE) {
    // Remove oldest entry
    const firstKey = orgPlanCache.keys().next().value;
    if (firstKey) {
      orgPlanCache.delete(firstKey);
    }
  }

  try {
    const { getCollections } = await import("./utils/mongodb");
    const collections = getCollections();

    const subscription = await collections.subscriptions.findOne({ organizationId });
    if (!subscription) {
      console.log(`📊 Rate limit: org=${organizationId} has NO subscription, using 'free' tier`);
      orgPlanCache.set(organizationId, { tier: 'free', timestamp: Date.now() });
      return 'free';
    }

    const plan = await collections.plans.findOne({ id: subscription.planId });
    const tier = plan?.tier || 'free';

    console.log(`📊 Rate limit: org=${organizationId} subscription=${subscription.planId} tier=${tier} (multiplier: ${tier === 'enterprise' ? 100 : tier === 'pro' ? 20 : tier === 'starter' ? 5 : 1}x)`);
    orgPlanCache.set(organizationId, { tier, timestamp: Date.now() });
    return tier;
  } catch (error) {
    console.error(`📊 Rate limit lookup error for org=${organizationId}:`, error);
    return 'free';
  }
}

// Legacy Auth middleware (for backward compatibility)
const isLegacyAuthenticated = createBasicAuthMiddleware(config.apiKey);

// New auth middleware using JWT/API keys
async function authenticateRequest(req: Request): Promise<AuthContext | null> {
  // First try new auth
  const authContext = await authService.authenticateRequest(req);
  if (authContext) return authContext;

  // Fall back to legacy API key auth
  if (isLegacyAuthenticated(req)) {
    // Legacy auth - treat as a super admin context for backward compatibility
    return {
      isApiKeyAuth: true,
    } as AuthContext;
  }

  return null;
}

// Helper to require super admin for an endpoint
async function requireSuperAdmin(req: Request): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ success: false, message: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const token = authHeader.split(" ")[1];
  const session = await authService.getSession(token);

  if (!session) {
    return new Response(
      JSON.stringify({ success: false, message: "Invalid token" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // Import adminService to check super admin status
  const { isSuperAdmin } = await import("./services/adminService");
  const isSuper = await isSuperAdmin(session.userId);

  if (!isSuper) {
    return new Response(
      JSON.stringify({ success: false, message: "Forbidden: Super Admin access required" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  return null; // Auth passed
}

// Register local VPS server on startup
async function registerLocalVpsServer(): Promise<void> {
  try {
    const vpsId = process.env.VPS_ID || `vps-${generateId().substring(0, 8)}`;
    const vpsName = process.env.VPS_NAME || "jrok-server";
    const vpsHost = process.env.VPS_HOST || "localhost";
    const sshUser = process.env.VPS_USER || "root";
    const sshPort = process.env.VPS_PORT ? parseInt(process.env.VPS_PORT) : 22;
    const nginxPath = process.env.NGINX_PATH || "/etc/nginx/sites-available";

    // Check if already registered by ID
    const existing = await vpsService.getVpsServerById(vpsId);
    if (existing) {
      console.log(`✅ VPS server already registered: ${vpsName}`);
      return;
    }

    // Check if already registered by name
    const allServers = await vpsService.getAllVpsServers();
    const existingByName = allServers.find(s => s.name === vpsName);
    if (existingByName) {
      console.log(`✅ VPS server already registered: ${vpsName}`);
      return;
    }

    // Register the VPS server
    await vpsService.registerVpsServer({
      id: vpsId,
      name: vpsName,
      host: vpsHost,
      sshUser,
      sshPort,
      nginxPath,
      healthy: true,
      lastHealthCheck: Date.now(),
    });

    console.log(`✅ VPS server registered: ${vpsName} (${vpsHost})`);
  } catch (error) {
    console.error("Warning: Could not register VPS server:", error instanceof Error ? error.message : String(error));
    console.error("    Tunnel creation will not sync Nginx configs automatically");
  }
}

// Main server function
async function startServer() {
  try {
    // Connect to MongoDB
    await connectDatabase();
    console.log("✅ Database connected");

    // Create distributed state indexes
    await createDistributedStateIndexes();
    console.log("✅ Distributed state indexes created");

    // Clean up stale connections from previous server instance
    await cleanupStaleConnectionsOnStartup();
    console.log("✅ Stale connections cleaned up");

    // Initialize security service
    securityService.initSecurityService();
    console.log("✅ Security service initialized");

    // Load IP security settings from DB
    await securityService.loadIpSecurityFromDb();
    console.log("✅ IP security settings loaded");

    // Initialize cross-server routing
    crossServerService.initCrossServerRouting();
    console.log("✅ Cross-server routing initialized");

    // Initialize certificate sync infrastructure (MongoDB collections + indexes)
    await certSyncService.initializeCertificateSync();
    console.log("✅ Certificate sync infrastructure initialized");

    // Restore TCP servers on startup (reconnect to allocated ports)
    await tcpService.restoreTcpServersOnStartup();
    console.log("✅ TCP tunnels restored");

    // Initialize monitoring service with map references for size tracking
    monitoringService.initMonitoringService(pendingRequests, orgPlanCache);

    // Register current VPS server if running on a VPS with SSH
    await registerLocalVpsServer();

    // HTTP Server
    const server = Bun.serve({
      port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
      websocket: {
        open(ws: any) {
          // Handle client-tunnel WebSocket (from browser/client to tunneled service)
          if (ws.data?.type === 'client-tunnel') {
            const { agentWs, agent, subdomain, path, headers } = ws.data;

            // Register the client WebSocket connection
            const wsId = wsProxyService.registerClientWs(ws, agentWs, agent, subdomain, path || '/');

            // Store wsId in ws.data for later use
            ws.data.wsId = wsId;

            console.log(`✅ Client WebSocket connected for ${subdomain}${path || '/'} [${wsId}]`);

            // Notify agent about the new WebSocket connection
            wsProxyService.notifyAgentConnect(wsId, path || '/', headers || {});
            return;
          }

          // Handle agent WebSocket
          const domain = ws.data?.domain;
          const localPort = ws.data?.localPort;
          const localHost = ws.data?.localHost;
          const clientIp = ws.data?.clientIp;
          const organizationId = ws.data?.organizationId;
          const apiKeyId = ws.data?.apiKeyId;
          const protocol: TunnelProtocol = ws.data?.protocol || 'http';
          const forceNew = ws.data?.forceNew || false;
          const ipSecurity = ws.data?.ipSecurity;
          const isCustomDomain = ws.data?.isCustomDomain || false;
          const groupMode = ws.data?.groupMode || false;
          const instanceId = ws.data?.instanceId;

          if (!domain || !localPort) return;

          // Register agent with organization context (async - handles domain conflicts)
          agentService.registerAgent({
            socket: ws,
            domain,
            localPort,
            localHost,
            clientIp,
            organizationId,
            apiKeyId,
            protocol,
            forceNew,
            isCustomDomain,
            groupMode,
            instanceId,
          }).then(async ({ agent, finalDomain, wasModified, groupId, groupMemberCount }) => {
            const groupInfo = groupMode ? ` [GROUP: ${groupMemberCount} members]` : '';
            console.log(
              `✅ Agent connected: ${finalDomain} (${localHost}:${localPort}) [${agent.id}] protocol: ${protocol}${wasModified ? ` (requested: ${domain})` : ''}${isCustomDomain ? ' [CUSTOM DOMAIN]' : ''}${groupInfo}`
            );

            // Apply IP security settings if provided from CLI
            if (ipSecurity && ipSecurity.mode) {
              try {
                await securityService.setTunnelIpSecurity(agent.tunnelId || finalDomain, {
                  mode: ipSecurity.mode,
                  allowedIps: ipSecurity.allowedIps || [],
                  blockedIps: ipSecurity.blockedIps || [],
                });
                console.log(`🔐 IP Security applied for ${finalDomain}: mode=${ipSecurity.mode}`);
              } catch (err) {
                console.error(`⚠️ Failed to apply IP security for ${finalDomain}:`, err);
              }
            }

            // Register agent for TCP forwarding if it's a TCP tunnel
            if (protocol === 'tcp') {
              tcpService.registerAgentConnection(agent.id, ws);
            }

            // Prepare welcome message
            const welcomeMessage: any = {
              type: "welcome",
              agentId: agent.id,
              message: "Connected to jrok",
              protocol,
              domain: finalDomain,
              requestedDomain: wasModified ? domain : undefined,
              domainModified: wasModified,
            };

            // Include group info if in group mode
            if (groupMode && groupId) {
              welcomeMessage.groupMode = true;
              welcomeMessage.groupId = groupId;
              welcomeMessage.groupMemberCount = groupMemberCount;
              welcomeMessage.instanceId = agent.instanceId;
            }

            // Include IP security status if enabled
            if (ipSecurity && ipSecurity.mode && ipSecurity.mode !== 'allow-all') {
              welcomeMessage.ipSecurity = {
                mode: ipSecurity.mode,
                allowedIps: ipSecurity.allowedIps?.length || 0,
                blockedIps: ipSecurity.blockedIps?.length || 0,
              };
            }

            ws.send(JSON.stringify(welcomeMessage));

            // For TCP tunnels, send the allocated port after tunnel is created
            if (protocol === 'tcp') {
              // Wait for tunnel creation and then send TCP port info
              setTimeout(async () => {
                const allocation = await tcpService.getPortAllocation(agent.tunnelId || '');
                if (allocation) {
                  ws.send(JSON.stringify({
                    type: "welcome",
                    agentId: agent.id,
                    message: "TCP tunnel ready",
                    protocol,
                    tcpPort: allocation.port,
                    domain: finalDomain,
                  }));
                }
              }, 1000); // Wait 1 second for tunnel creation
            }
          }).catch((error) => {
            console.error(`❌ Failed to register agent for ${domain}:`, error);
            ws.send(JSON.stringify({
              type: "error",
              message: `Failed to register agent: ${error instanceof Error ? error.message : String(error)}`,
            }));
            ws.close(1011, "Failed to register agent");
          });
        },

        message(ws: any, data: string | Buffer) {
          // Handle client-tunnel WebSocket messages (forward to agent)
          if (ws.data?.type === 'client-tunnel') {
            const wsId = ws.data.wsId;
            if (wsId) {
              const isBinary = Buffer.isBuffer(data);
              wsProxyService.forwardToAgent(wsId, data, isBinary);
            }
            return;
          }

          try {
            const message = JSON.parse(data.toString());

            if (message.type === "heartbeat") {
              const agentId = agentService.getAgentIdBySocket(ws);

              if (agentId) {
                agentService.updateHeartbeat(agentId);
                ws.send(JSON.stringify({ type: "heartbeat_ack" }));
              }
            } else if (message.type === "ws_message_response") {
              // Forward WebSocket message from agent to client
              const { wsId, data: msgData, isBinary } = message;
              if (wsId && msgData !== undefined) {
                // Decode base64 if binary, otherwise pass as string
                const payload = isBinary ? Buffer.from(msgData, 'base64') : String(msgData);
                wsProxyService.forwardToClient(wsId, payload, isBinary);
              }
            } else if (message.type === "ws_close_response") {
              // Agent requested to close client WebSocket
              const { wsId, code, reason } = message;
              if (wsId) {
                wsProxyService.closeClientConnection(wsId, code || 1000, reason || '');
              }
            } else if (message.type === "ws_error") {
              // Agent reported WebSocket error
              const { wsId, error } = message;
              console.error(`❌ WebSocket error from agent [${wsId}]: ${error}`);
              if (wsId) {
                wsProxyService.closeClientConnection(wsId, 1011, error || 'Internal error');
              }
            } else if (message.type === "http_response") {
              // Handle HTTP response from agent
              const pending = pendingRequests.get(message.requestId);
              if (pending) {
                clearTimeout(pending.timeout);
                pendingRequests.delete(message.requestId);

                // Decode body if it's base64 encoded
                let responseBody: string | ArrayBuffer = message.body || "";
                if (message.isBase64 && typeof message.body === 'string') {
                  responseBody = Buffer.from(message.body, 'base64');
                }

                // Calculate response size (bytes out)
                const bytesOut = message.isBase64 && typeof message.body === 'string'
                  ? Buffer.from(message.body, 'base64').length
                  : new TextEncoder().encode(message.body || "").length +
                  new TextEncoder().encode(JSON.stringify(message.headers || {})).length;

                // Record bandwidth usage
                if (pending.agent.organizationId) {
                  statsService.recordBandwidth({
                    organizationId: pending.agent.organizationId,
                    tunnelId: pending.tunnelId,
                    agentId: pending.agent.id,
                    bytesIn: pending.bytesIn,
                    bytesOut: bytesOut,
                    requests: 1,
                  }).catch(err => console.error("Failed to record bandwidth:", err));
                }

                // Build response headers
                const responseHeaders = new Headers(message.headers || {});

                // Add debug headers
                responseHeaders.set('X-Jrok-Agent-Id', pending.agent.id);
                if (pending.agent.instanceId) {
                  responseHeaders.set('X-Jrok-Instance-Id', pending.agent.instanceId);
                }

                // Remove Content-Encoding header when we've decoded the body
                // This prevents the browser from trying to decompress already-decoded content
                if (message.isBase64) {
                  responseHeaders.delete('Content-Encoding');
                }

                pending.resolve(new Response(responseBody, {
                  status: message.status || 200,
                  statusText: message.statusText || "OK",
                  headers: responseHeaders,
                }));
              }
            } else if (message.type === "error") {
              console.error("Agent error:", message.payload);
            }
            // ============ TCP Tunnel Message Handlers ============
            else if (message.type === "tcp_data_response") {
              // Forward TCP data from agent to client
              const { connectionId, data } = message;
              if (connectionId && data) {
                tcpService.handleAgentTcpData(connectionId, data);
              }
            } else if (message.type === "tcp_connected") {
              // Agent successfully connected to local TCP service
              const { connectionId } = message;
              if (connectionId) {
                tcpService.handleAgentTcpConnected(connectionId);
              }
            } else if (message.type === "tcp_close_response") {
              // Agent closed TCP connection
              const { connectionId } = message;
              if (connectionId) {
                tcpService.handleAgentTcpClose(connectionId);
              }
            } else if (message.type === "tcp_error") {
              // Agent reported TCP error
              const { connectionId, error } = message;
              console.error(`❌ TCP error from agent [${connectionId}]: ${error}`);
              if (connectionId) {
                tcpService.handleAgentTcpError(connectionId, error || 'Unknown error');
              }
            }
          } catch (error) {
            console.error("Failed to parse agent message:", error);
          }
        },

        close(ws: any, code: number, reason: string) {
          // Handle client-tunnel WebSocket close
          if (ws.data?.type === 'client-tunnel') {
            const wsId = ws.data.wsId;
            if (wsId) {
              // Notify agent about client disconnect
              wsProxyService.notifyAgentDisconnect(wsId, code, reason?.toString() || '');
              // Unregister the connection
              wsProxyService.unregisterClientWs(wsId);
            }
            return;
          }

          // Handle agent WebSocket close
          const agentId = agentService.getAgentIdBySocket(ws);
          const clientIp = ws.data?.clientIp || "unknown";

          // ALWAYS unregister from monitoring service to prevent connection count leak
          monitoringService.unregisterAgentConnection(clientIp);

          if (agentId) {
            const agent = agentService.getAgent(agentId);
            console.log(`🔌 Agent disconnected: ${agent?.domain} [${agentId}]`);

            // Close all client WebSocket connections for this agent
            wsProxyService.closeConnectionsByAgent(agentId);

            // Clean up TCP connections for this agent
            tcpService.unregisterAgentConnection(agentId);

            agentService.unregisterAgent(agentId);
          }
        },

        error(ws: any, error: Error) {
          console.error("WebSocket error:", error);

          // Handle client-tunnel WebSocket error
          if (ws.data?.type === 'client-tunnel') {
            const wsId = ws.data.wsId;
            if (wsId) {
              wsProxyService.closeClientConnection(wsId, 1011, 'WebSocket error');
            }
          }
        },
      },
      async fetch(req: Request) {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;
        const hostname = url.hostname;

        // CORS configuration - whitelist allowed origins
        const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173").split(",").map(o => o.trim());
        const requestOrigin = req.headers.get("Origin");

        // Check if origin is allowed
        const isAllowedOrigin = requestOrigin && (
          allowedOrigins.includes(requestOrigin) ||
          allowedOrigins.includes("*") ||
          // Allow same-origin requests (no Origin header)
          requestOrigin === `http://${hostname}` ||
          requestOrigin === `https://${hostname}`
        );

        const corsOrigin = isAllowedOrigin ? requestOrigin : allowedOrigins[0];

        const corsHeaders: Record<string, string> = {
          "Access-Control-Allow-Origin": corsOrigin || allowedOrigins[0],
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
          "Access-Control-Max-Age": "86400", // Cache preflight for 24 hours
        };

        // Only allow credentials for whitelisted origins
        if (isAllowedOrigin) {
          corsHeaders["Access-Control-Allow-Credentials"] = "true";
        }

        // Security headers
        const securityHeaders: Record<string, string> = {
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "X-XSS-Protection": "1; mode=block",
          "Referrer-Policy": "strict-origin-when-cross-origin",
        };

        // Handle preflight OPTIONS request — only for Jrok management API
        // Tunnel domain traffic should pass through so the backend app handles CORS itself
        if (method === "OPTIONS") {
          const baseDomain = config.baseDomain;
          const isTunnelSubdomain = hostname.endsWith(baseDomain) && hostname !== baseDomain;
          const isCustomDomain = !hostname.endsWith(baseDomain) && hostname !== baseDomain && hostname !== 'localhost';

          if (!isTunnelSubdomain && !isCustomDomain) {
            // Management API — Jrok handles CORS
            return new Response(null, { status: 204, headers: corsHeaders });
          }
          // Tunnel/custom domain — let it fall through to be forwarded to the agent
        }

        // Helper to add CORS and security headers to response
        const addCors = (response: Response): Response => {
          const newHeaders = new Headers(response.headers);
          Object.entries({ ...corsHeaders, ...securityHeaders }).forEach(([key, value]) => {
            newHeaders.set(key, value);
          });
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        };

        // Agent WebSocket upgrade (authenticated)
        if (path === "/ws/agent" && req.headers.get("upgrade") === "websocket") {
          return await agentHandler.handleAgentUpgrade(req, server);
        }

        // ============ Public Routes (no auth required) ============

        // Health check
        if (path === "/health" && method === "GET") {
          return addCors(new Response(
            JSON.stringify({
              success: true,
              message: "Server is running",
              serverId: crossServerService.currentServerId,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Cluster stats (for monitoring multi-server deployment)
        if (path === "/cluster/stats" && method === "GET") {
          const clusterStats = await crossServerService.getClusterStats();
          return addCors(new Response(
            JSON.stringify({ success: true, ...clusterStats }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Auth routes - must be before tunnel domain check
        // Apply rate limiting to prevent brute force attacks
        if (path === "/auth/login" && method === "GET") {
          const { checkAuthRateLimit, getClientIp } = await import("./utils/rateLimiter");
          const clientIp = getClientIp(req);
          const rateLimit = checkAuthRateLimit(clientIp);
          if (rateLimit) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Too many requests. Please try again later." }),
              { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(rateLimit.retryAfter) } }
            ));
          }
          return addCors(authHandler.handleGetLoginUrl());
        }

        // POST callback - called by dashboard after OAuth redirect
        if (path === "/auth/callback" && method === "POST") {
          const { checkAuthRateLimit, getClientIp } = await import("./utils/rateLimiter");
          const clientIp = getClientIp(req);
          const rateLimit = checkAuthRateLimit(clientIp);
          if (rateLimit) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Too many requests. Please try again later." }),
              { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(rateLimit.retryAfter) } }
            ));
          }
          return addCors(await authHandler.handleOAuthCallback(req));
        }

        // GET callback - handle direct OAuth redirect (redirect to dashboard with code)
        if (path === "/auth/callback" && method === "GET") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          // Get the dashboard URL from environment or default
          const dashboardUrl = process.env.DASHBOARD_URL || "http://localhost:5173";

          // Redirect to dashboard callback page with the code
          const redirectUrl = new URL("/callback", dashboardUrl);
          if (code) redirectUrl.searchParams.set("code", code);
          if (state) redirectUrl.searchParams.set("state", state);
          if (error) redirectUrl.searchParams.set("error", error);

          return new Response(null, {
            status: 302,
            headers: {
              "Location": redirectUrl.toString(),
            },
          });
        }

        // Plans (public)
        if (path === "/plans" && method === "GET") {
          return addCors(await organizationHandler.handleGetPlans());
        }

        // ============ Protected Routes ============

        // Auth routes that require authentication
        if (path === "/auth/me" && method === "GET") {
          return addCors(await authHandler.handleGetCurrentUser(req));
        }

        if (path === "/auth/logout" && method === "POST") {
          return addCors(await authHandler.handleLogout(req));
        }

        // Super admin user management
        if (path === "/auth/users" && method === "GET") {
          return addCors(await authHandler.handleGetAllUsers(req));
        }

        if (path.match(/^\/auth\/users\/[^/]+\/role$/) && method === "PUT") {
          const userId = path.split("/")[3];
          return addCors(await authHandler.handleUpdateUserRole(req, userId));
        }

        if (path.match(/^\/auth\/users\/[^/]+$/) && method === "DELETE") {
          const userId = path.split("/")[3];
          return addCors(await authHandler.handleDeactivateUser(req, userId));
        }

        // Organization routes
        if (path === "/organizations" && method === "POST") {
          return addCors(await organizationHandler.handleCreateOrganization(req));
        }

        if (path === "/organizations" && method === "GET") {
          return addCors(await organizationHandler.handleGetOrganizations(req));
        }

        if (path.match(/^\/organizations\/[^/]+$/) && method === "GET") {
          const orgId = path.split("/")[2];
          return addCors(await organizationHandler.handleGetOrganization(req, orgId));
        }

        if (path.match(/^\/organizations\/[^/]+$/) && method === "PUT") {
          const orgId = path.split("/")[2];
          return addCors(await organizationHandler.handleUpdateOrganization(req, orgId));
        }

        if (path.match(/^\/organizations\/[^/]+$/) && method === "DELETE") {
          const orgId = path.split("/")[2];
          return addCors(await organizationHandler.handleDeleteOrganization(req, orgId));
        }

        // Organization members
        if (path.match(/^\/organizations\/[^/]+\/members$/) && method === "POST") {
          const orgId = path.split("/")[2];
          return addCors(await organizationHandler.handleAddMember(req, orgId));
        }

        if (path.match(/^\/organizations\/[^/]+\/members\/[^/]+$/) && method === "DELETE") {
          const parts = path.split("/");
          return addCors(await organizationHandler.handleRemoveMember(req, parts[2], parts[4]));
        }

        // API Keys
        if (path.match(/^\/organizations\/[^/]+\/api-keys$/) && method === "POST") {
          const orgId = path.split("/")[2];
          return addCors(await organizationHandler.handleCreateApiKey(req, orgId));
        }

        if (path.match(/^\/organizations\/[^/]+\/api-keys$/) && method === "GET") {
          const orgId = path.split("/")[2];
          return addCors(await organizationHandler.handleGetApiKeys(req, orgId));
        }

        if (path.match(/^\/organizations\/[^/]+\/api-keys\/[^/]+$/) && method === "DELETE") {
          const parts = path.split("/");
          return addCors(await organizationHandler.handleRevokeApiKey(req, parts[2], parts[4]));
        }

        if (path.match(/^\/organizations\/[^/]+\/api-keys\/[^/]+\/rotate$/) && method === "POST") {
          const parts = path.split("/");
          return addCors(await organizationHandler.handleRotateApiKey(req, parts[2], parts[4]));
        }

        // Admin routes
        if (path === "/admin/organizations" && method === "GET") {
          return addCors(await organizationHandler.handleGetAllOrganizations(req));
        }

        if (path === "/admin/plans" && method === "GET") {
          return addCors(await adminHandler.handleListPlans(req));
        }

        if (path.match(/^\/admin\/organizations\/[^/]+\/plan$/) && method === "POST") {
          const orgId = path.split("/")[3];
          return addCors(await adminHandler.handleUpgradePlan(req, orgId));
        }

        // New Admin Routes
        if (path === "/admin/settings" && method === "GET") {
          return addCors(await adminHandler.handleGetSettings(req));
        }

        if (path === "/admin/settings" && method === "PUT") {
          return addCors(await adminHandler.handleUpdateSettings(req));
        }

        if (path === "/admin/users" && method === "GET") {
          return addCors(await adminHandler.handleListUsers(req));
        }

        if (path.match(/^\/admin\/users\/[^/]+\/status$/) && method === "PUT") {
          const userId = path.split("/")[3];
          return addCors(await adminHandler.handleUpdateUserStatus(req, userId));
        }

        if (path.match(/^\/admin\/organizations\/[^/]+\/status$/) && method === "PUT") {
          const orgId = path.split("/")[3];
          return addCors(await adminHandler.handleUpdateOrgStatus(req, orgId));
        }

        // Admin cleanup duplicates
        if (path === "/admin/cleanup-tunnels" && method === "POST") {
          return addCors(await adminHandler.handleCleanupTunnels(req));
        }

        // ============ Monitoring API Routes (Super Admin Only) ============

        // Get full monitoring dashboard data
        if (path === "/admin/monitoring" && method === "GET") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          return addCors(new Response(
            JSON.stringify({ success: true, data: monitoringService.getDashboardData() }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get system health status
        if (path === "/admin/monitoring/health" && method === "GET") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          return addCors(new Response(
            JSON.stringify({ success: true, health: monitoringService.getSystemHealth() }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get metrics history for graphs
        if (path === "/admin/monitoring/metrics" && method === "GET") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          const url = new URL(req.url);
          const minutes = parseInt(url.searchParams.get("minutes") || "60");
          return addCors(new Response(
            JSON.stringify({ success: true, history: monitoringService.getMetricsHistory(minutes) }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get recent logs
        if (path === "/admin/monitoring/logs" && method === "GET") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          const url = new URL(req.url);
          const count = parseInt(url.searchParams.get("count") || "100");
          const level = url.searchParams.get("level") as 'info' | 'warn' | 'error' | 'debug' | undefined;
          const category = url.searchParams.get("category") || undefined;
          return addCors(new Response(
            JSON.stringify({ success: true, logs: monitoringService.getRecentLogs(count, level, category) }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get rate limit statistics
        if (path === "/admin/monitoring/rate-limits" && method === "GET") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          return addCors(new Response(
            JSON.stringify({ success: true, rateLimits: monitoringService.getRateLimitStats() }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get authentication metrics
        if (path === "/admin/monitoring/auth" && method === "GET") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          return addCors(new Response(
            JSON.stringify({ success: true, auth: monitoringService.getAuthMetrics() }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get certificate metrics
        if (path === "/admin/monitoring/certificates" && method === "GET") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          return addCors(new Response(
            JSON.stringify({ success: true, certificates: monitoringService.getCertMetrics() }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get system configuration
        if (path === "/admin/monitoring/config" && method === "GET") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          const config = await monitoringService.getSystemConfig();
          return addCors(new Response(
            JSON.stringify({ success: true, config }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Update system configuration
        if (path === "/admin/monitoring/config" && method === "PUT") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          try {
            const body = await req.json() as Partial<monitoringService.SystemConfig>;
            const config = await monitoringService.updateSystemConfig(body);
            return addCors(new Response(
              JSON.stringify({ success: true, config }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ));
          } catch (error) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: String(error) }),
              { status: 500, headers: { "Content-Type": "application/json" } }
            ));
          }
        }

        // Get per-IP connection details (admin debugging)
        if (path === "/admin/monitoring/connections" && method === "GET") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          return addCors(new Response(
            JSON.stringify({
              success: true,
              connections: monitoringService.getConnectionsPerIpDetails()
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Clear stuck IP connection counter (admin emergency fix)
        if (path.match(/^\/admin\/monitoring\/connections\/clear\//) && method === "POST") {
          const authError = await requireSuperAdmin(req);
          if (authError) return addCors(authError);
          const ipToClear = decodeURIComponent(path.split("/").pop() || "");
          if (!ipToClear) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: "IP address required" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          const result = monitoringService.clearConnectionsForIp(ipToClear);
          return addCors(new Response(
            JSON.stringify({ success: true, ...result }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }


        // ============ Dashboard Stats & Activity Routes ============

        // Activity routes (require organization context)
        if (path === "/activity" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          return addCors(await activityHandler.handleListActivity(req, authContext));
        }

        if (path === "/activity/recent" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          return addCors(await activityHandler.handleRecentActivity(req, authContext));
        }

        if (path === "/activity/summary" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          return addCors(await activityHandler.handleActivitySummary(req, authContext));
        }

        // Stats routes
        if (path === "/stats/dashboard" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          return addCors(await statsHandler.handleDashboardStats(req, authContext));
        }

        if (path === "/stats/bandwidth" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          return addCors(await statsHandler.handleBandwidthStats(req, authContext));
        }

        // TCP tunnel stats (public endpoint for monitoring)
        if (path === "/stats/tcp" && method === "GET") {
          const stats = await tcpService.getTcpStatsGlobal();
          const allocations = await tcpService.getAllPortAllocationsGlobal();
          return addCors(new Response(
            JSON.stringify({
              success: true,
              stats,
              allocations: allocations.map((a: any) => ({
                port: a.port,
                tunnelId: a.tunnelId,
                localPort: a.localPort,
                localHost: a.localHost,
                createdAt: a.createdAt,
                active: a.active,
                serverId: a.serverId,
              })),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // ============ Security Management Endpoints ============

        // Get security stats (requires admin auth)
        if (path === "/security/stats" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext || authContext.user?.role !== 'super_admin') {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized - Admin access required" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          const stats = securityService.getSecurityStats();
          return addCors(new Response(
            JSON.stringify({ success: true, stats }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get blocked IPs (requires admin auth)
        if (path === "/security/blocked-ips" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext || authContext.user?.role !== 'super_admin') {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized - Admin access required" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          const blockedIps = securityService.getBlockedIps();
          return addCors(new Response(
            JSON.stringify({ success: true, blockedIps }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Block an IP (requires admin auth)
        if (path === "/security/block-ip" && method === "POST") {
          const authContext = await authenticateRequest(req);
          if (!authContext || authContext.user?.role !== 'super_admin') {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized - Admin access required" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          const body = await req.json() as { ip: string; reason: string; duration?: number };
          if (!body.ip || !body.reason) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing ip or reason" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          securityService.blockIp(body.ip, body.reason, body.duration || 3600);
          return addCors(new Response(
            JSON.stringify({ success: true, message: `IP ${body.ip} blocked` }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Unblock an IP (requires admin auth)
        if (path === "/security/unblock-ip" && method === "POST") {
          const authContext = await authenticateRequest(req);
          if (!authContext || authContext.user?.role !== 'super_admin') {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized - Admin access required" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          const body = await req.json() as { ip: string };
          if (!body.ip) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing ip" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          securityService.unblockIp(body.ip);
          return addCors(new Response(
            JSON.stringify({ success: true, message: `IP ${body.ip} unblocked` }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get IP allowlist for a tunnel
        if (path.startsWith("/security/allowlist/") && method === "GET") {
          const tunnelId = path.split("/")[3];
          if (!tunnelId) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing tunnel ID" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          const allowlist = securityService.getIpAllowlist(tunnelId);
          return addCors(new Response(
            JSON.stringify({ success: true, tunnelId, allowlist }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Set IP allowlist for a tunnel (legacy - kept for backward compatibility)
        if (path.startsWith("/security/allowlist/") && method === "POST") {
          const tunnelId = path.split("/")[3];
          if (!tunnelId) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing tunnel ID" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          const body = await req.json() as { ips: string[] };
          if (!body.ips || !Array.isArray(body.ips)) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing ips array" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          // Use new persistent security system
          await securityService.setTunnelAllowlist(tunnelId, body.ips, authContext.user?.id);
          return addCors(new Response(
            JSON.stringify({ success: true, message: `Allowlist updated for tunnel ${tunnelId}` }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // ============ New IP Security Endpoints ============

        // GET /security/ip/:tunnelId - Get comprehensive IP security settings
        if (path.startsWith("/security/ip/") && method === "GET") {
          const tunnelId = path.split("/")[3];
          if (!tunnelId) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing tunnel ID" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          const ipSecurity = securityService.getTunnelIpSecurity(tunnelId);
          return addCors(new Response(
            JSON.stringify({ success: true, tunnelId, ipSecurity }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // POST /security/ip/:tunnelId - Set IP security settings
        if (path.startsWith("/security/ip/") && method === "POST") {
          const tunnelId = path.split("/")[3];
          if (!tunnelId) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing tunnel ID" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }

          const body = await req.json() as {
            mode: 'allow-all' | 'allowlist' | 'blocklist';
            allowedIps?: string[];
            blockedIps?: string[];
          };

          if (!body.mode || !['allow-all', 'allowlist', 'blocklist'].includes(body.mode)) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Invalid mode. Use: 'allow-all', 'allowlist', or 'blocklist'" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }

          await securityService.setTunnelIpSecurity(tunnelId, {
            mode: body.mode,
            allowedIps: body.allowedIps || [],
            blockedIps: body.blockedIps || [],
          }, authContext.user?.id);

          return addCors(new Response(
            JSON.stringify({ success: true, message: `IP security updated for tunnel ${tunnelId}`, mode: body.mode }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // POST /security/ip/:tunnelId/add - Add IP to allowlist or blocklist
        if (path.match(/^\/security\/ip\/[^\/]+\/add$/) && method === "POST") {
          const tunnelId = path.split("/")[3];
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }

          const body = await req.json() as { ip: string; listType: 'allow' | 'block' };
          if (!body.ip || !body.listType) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing ip or listType ('allow' or 'block')" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }

          await securityService.addIpToTunnelSecurity(tunnelId, body.ip, body.listType, authContext.user?.id);
          return addCors(new Response(
            JSON.stringify({ success: true, message: `IP ${body.ip} added to ${body.listType} list` }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // POST /security/ip/:tunnelId/remove - Remove IP from lists
        if (path.match(/^\/security\/ip\/[^\/]+\/remove$/) && method === "POST") {
          const tunnelId = path.split("/")[3];
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }

          const body = await req.json() as { ip: string };
          if (!body.ip) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing ip" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }

          await securityService.removeIpFromTunnelSecurity(tunnelId, body.ip, authContext.user?.id);
          return addCors(new Response(
            JSON.stringify({ success: true, message: `IP ${body.ip} removed from security lists` }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get connection logs for a tunnel
        if (path.startsWith("/security/logs/tunnel/") && method === "GET") {
          const tunnelId = path.split("/")[4];
          if (!tunnelId) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing tunnel ID" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          const urlParams = new URL(req.url).searchParams;
          const limit = parseInt(urlParams.get("limit") || "100");
          const offset = parseInt(urlParams.get("offset") || "0");
          const logs = await securityService.getConnectionLogs(tunnelId, limit, offset);
          return addCors(new Response(
            JSON.stringify({ success: true, tunnelId, logs }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Get bandwidth usage for an organization
        if (path.startsWith("/security/bandwidth/") && method === "GET") {
          const organizationId = path.split("/")[3];
          if (!organizationId) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Missing organization ID" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          const planTier = await getPlanTierForOrg(organizationId);
          const bandwidth = securityService.checkMonthlyBandwidth(organizationId, planTier);
          return addCors(new Response(
            JSON.stringify({ success: true, organizationId, ...bandwidth }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Enhanced resource routes
        if (path === "/tunnels/enhanced" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          return addCors(await statsHandler.handleEnhancedTunnels(req, authContext));
        }

        if (path === "/agents/enhanced" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          return addCors(await statsHandler.handleEnhancedAgents(req, authContext));
        }

        if (path === "/domains/enhanced" && method === "GET") {
          const authContext = await authenticateRequest(req);
          if (!authContext) {
            return addCors(new Response(
              JSON.stringify({ success: false, message: "Unauthorized" }),
              { status: 401, headers: { "Content-Type": "application/json" } }
            ));
          }
          return addCors(await statsHandler.handleEnhancedDomains(req, authContext));
        }

        // ============ Tunnel Domain Routing ============
        // Check if this is a tunnel domain request (extract subdomain or custom domain)
        // MUST be before auth check to allow public tunnel access
        const baseDomain = config.baseDomain; // e.g., "tunnel.koompi.cloud"

        // First, check if this is a registered custom domain
        let tunnelDomain: string | null = null;
        let isCustomDomainRequest = false;

        // Check for custom domain (not a subdomain of baseDomain and not the baseDomain itself)
        if (!hostname.endsWith(baseDomain) && hostname !== baseDomain && hostname !== 'localhost') {
          // This might be a custom domain - check if it's registered
          const { getCustomDomainByName } = await import("./utils/database");
          const customDomain = await getCustomDomainByName(hostname);

          if (customDomain && customDomain.active) {
            // This is a valid custom domain - use the full hostname as the tunnel domain
            tunnelDomain = hostname;
            isCustomDomainRequest = true;
          }
        } else if (hostname.endsWith(baseDomain) && hostname !== baseDomain) {
          // Extract subdomain (e.g., "demo" from "demo.tunnel.koompi.cloud")
          tunnelDomain = hostname.replace(`.${baseDomain}`, '');
        }

        if (tunnelDomain) {
          const subdomain = tunnelDomain; // For backward compatibility with existing code

          // Check if agent is on this server or needs cross-server routing
          const routeResult = await crossServerService.findServerForDomain(subdomain);

          // If agent is on another server, proxy the request
          if (!routeResult.isLocal && routeResult.targetServer) {
            return crossServerService.forwardRequest(
              routeResult.targetServer,
              req,
              url.pathname + url.search
            );
          }

          // Import agentGroupService for load-balanced agent selection
          const agentGroupService = await import("./services/agentGroupService");

          // Check if this domain has a multi-agent group (load-balanced)
          const isGroupDomain = await agentGroupService.isGroupedDomain(subdomain);

          // Look up agent - use load balancer for groups, direct lookup for single agents
          let agent;
          if (isGroupDomain) {
            // Use load-balanced selection (round-robin, least-connections, etc.)
            agent = await agentGroupService.selectAgent(subdomain);
          } else {
            // Single agent mode - direct lookup
            agent = await agentService.getAgentByDomainAsync(subdomain);
          }

          if (!agent || !agent.active) {
            // Serve maintenance HTML page instead of JSON error
            const maintenanceHtmlPath = import.meta.dir + "/../index.html";
            try {
              const htmlContent = await Bun.file(maintenanceHtmlPath).text();
              return addCors(new Response(htmlContent, {
                status: 503,
                headers: { "Content-Type": "text/html; charset=utf-8" }
              }));
            } catch {
              // Fallback if index.html is not found
              return addCors(new Response(
                JSON.stringify({
                  success: false,
                  message: `No active agent found for domain: ${subdomain}. Please ensure the agent is running: jrok --port <port> --domain ${subdomain}`,
                }),
                { status: 503, headers: { "Content-Type": "application/json" } }
              ));
            }
          }

          // Get agent's WebSocket (local connections only)
          const agentWs = agentService.getAgentSocket(agent.id);
          if (!agentWs || agentWs.readyState !== 1) {  // 1 = WebSocket.OPEN
            // For group mode, try to get another agent if this one is disconnected
            if (isGroupDomain) {
              // Mark this agent as unhealthy
              await agentGroupService.updateMemberHealth(agent.id, false);
              // Try to get another agent
              const fallbackAgent = await agentGroupService.selectAgent(subdomain);
              if (fallbackAgent && fallbackAgent.id !== agent.id) {
                const fallbackWs = agentService.getAgentSocket(fallbackAgent.id);
                if (fallbackWs && fallbackWs.readyState === 1) {
                  // Use fallback agent
                  agent = fallbackAgent;
                }
              }
            }

            // Re-check after potential fallback
            const finalWs = agentService.getAgentSocket(agent.id);
            if (!finalWs || finalWs.readyState !== 1) {
              return addCors(new Response(
                JSON.stringify({
                  success: false,
                  message: `Agent for ${subdomain} is not connected (readyState: ${finalWs?.readyState || 'null'}). ${isGroupDomain ? 'All agents in the group are unavailable.' : 'Attempting reconnection...'}`,
                }),
                { status: 503, headers: { "Content-Type": "application/json" } }
              ));
            }
          }

          // Get the final WebSocket reference
          const finalAgentWs = agentService.getAgentSocket(agent.id)!;

          // Use cached tunnelId from agent (set when agent connects)
          // This avoids MongoDB query on EVERY request - massive performance improvement!
          let tunnelId = agent.tunnelId;

          // Fallback to DB lookup only if not cached (rare)
          if (!tunnelId) {
            const { getTunnelByDomain } = await import("./utils/database");
            const tunnel = await getTunnelByDomain(subdomain);
            tunnelId = tunnel?.id;
          }

          // ============ Security Check for HTTP Requests ============
          const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
            req.headers.get("x-real-ip") ||
            "unknown";

          // Get User-Agent for layered client identification (differentiates devices on same IP)
          const userAgent = req.headers.get("user-agent") || undefined;

          // Get plan tier for rate limit calculation (defaults to 'free')
          const planTier = agent.organizationId ? await getPlanTierForOrg(agent.organizationId) : 'free';

          // Check security limits (rate limits) with layered client identification
          // This uses Token Bucket algorithm to allow burst while preventing abuse
          const securityCheck = await securityService.checkHttpRequest(
            tunnelId || subdomain,
            agent.organizationId,
            clientIp,
            planTier,
            {
              userAgent,
              apiKeyId: agent.apiKeyId,
            }
          );

          if (!securityCheck.allowed) {
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (securityCheck.retryAfter) {
              headers["Retry-After"] = securityCheck.retryAfter.toString();
            }
            return addCors(new Response(
              JSON.stringify({
                success: false,
                message: securityCheck.reason || "Rate limit exceeded",
              }),
              { status: 429, headers }
            ));
          }

          // ============ Bandwidth Limit Check ============
          // Block requests if organization has exceeded monthly bandwidth
          if (agent.organizationId) {
            const bandwidthCheck = securityService.checkMonthlyBandwidth(agent.organizationId, planTier);
            if (!bandwidthCheck.allowed) {
              console.warn(`🚫 Bandwidth limit exceeded for org ${agent.organizationId}: ${(bandwidthCheck.usedBytes / 1024 / 1024 / 1024).toFixed(2)}GB / ${(bandwidthCheck.limitBytes / 1024 / 1024 / 1024).toFixed(2)}GB`);
              return addCors(new Response(
                JSON.stringify({
                  success: false,
                  message: "Monthly bandwidth limit exceeded. Please upgrade your plan.",
                  usedGb: (bandwidthCheck.usedBytes / 1024 / 1024 / 1024).toFixed(2),
                  limitGb: (bandwidthCheck.limitBytes / 1024 / 1024 / 1024).toFixed(2),
                  percentUsed: bandwidthCheck.percentUsed.toFixed(1),
                }),
                { status: 402, headers: { "Content-Type": "application/json" } }
              ));
            }
          }

          // Track HTTP connection
          securityService.trackHttpConnection(tunnelId || subdomain, true);

          // Check if this is a WebSocket upgrade request
          if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            // Handle WebSocket tunneling
            const response = await handleWebSocketTunnel(req, server, finalAgentWs, agent, subdomain);
            if (response) {
              securityService.trackHttpConnection(tunnelId || subdomain, false);
              // Decrement connection count for load balancing
              if (isGroupDomain) {
                await agentGroupService.decrementMemberConnections(agent.id);
              }
              return response;
            }
            return undefined; // Handled by upgrade
          }

          // Forward regular HTTP request to agent via WebSocket (with bandwidth tracking)
          const response = await forwardRequestToAgent(req, finalAgentWs, agent, tunnelId, clientIp);

          // Track connection close and bandwidth
          securityService.trackHttpConnection(tunnelId || subdomain, false);

          // Decrement connection count for load balancing
          if (isGroupDomain) {
            await agentGroupService.decrementMemberConnections(agent.id);
          }

          // Track bandwidth usage
          const responseSize = parseInt(response.headers.get("content-length") || "0");
          securityService.trackMonthlyBandwidth(agent.organizationId || subdomain, responseSize);

          return response;
        }

        // ============ Legacy API Routes (require auth) ============

        // Auth check for legacy routes
        const authContext = await authenticateRequest(req);
        if (!authContext) {
          return addCors(new Response(
            JSON.stringify({
              success: false,
              message: "Unauthorized",
            }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Tunnel Routes (with auth)
        if (path === "/tunnels" && method === "POST") {
          return addCors(await tunnelHandler.handleCreateTunnel(req));
        }

        if (path === "/tunnels" && method === "GET") {
          return addCors(await tunnelHandler.handleListTunnels(req));
        }

        if (path.startsWith("/tunnels/") && method === "GET") {
          const id = path.split("/")[2];
          return addCors(await tunnelHandler.handleGetTunnel(id, req));
        }

        if (path.startsWith("/tunnels/") && method === "DELETE") {
          const id = path.split("/")[2];
          return addCors(await tunnelHandler.handleDeleteTunnel(id, req));
        }

        if (path === "/agents" && method === "GET") {
          return await agentHandler.handleListAgents();
        }

        // Domain routes
        if ((path === "/domains" || path === "/domains/") && method === "POST") {
          return await domainHandler.handleRegisterDomain(req);
        }

        if (path === "/domains" && method === "GET") {
          return await domainHandler.handleListDomains();
        }

        // Check CNAME verification status - must be BEFORE generic /domains/:domain GET
        if (path.startsWith("/domains/") && path.endsWith("/verify-status") && method === "GET") {
          const domain = path.split("/")[2];
          return await domainHandler.handleCheckCnameStatus(decodeURIComponent(domain));
        }

        // Verify CNAME and issue certificate
        if (path.startsWith("/domains/") && path.endsWith("/verify") && method === "POST") {
          const domain = path.split("/")[2];
          return await domainHandler.handleVerifyAndIssueCertificate(decodeURIComponent(domain));
        }

        if (path.startsWith("/domains/") && path.endsWith("/resync") && method === "POST") {
          const domain = path.split("/")[2];
          return await domainHandler.handleResyncDomain(decodeURIComponent(domain));
        }

        if (path.startsWith("/domains/") && path.endsWith("/transfer") && method === "POST") {
          const domain = path.split("/")[2];
          return await domainHandler.handleTransferDomain(decodeURIComponent(domain), req);
        }

        if (path.startsWith("/domains/") && path.endsWith("/backup") && method === "POST") {
          const domain = path.split("/")[2];
          return await domainHandler.handleBackupDomain(decodeURIComponent(domain));
        }

        if (path.startsWith("/domains/") && path.includes("/backups/") && method === "POST") {
          const parts = path.split("/");
          const domain = parts[2];
          const backupId = parts[4];
          return await domainHandler.handleRestoreDomain(decodeURIComponent(domain), backupId);
        }

        if (path.startsWith("/domains/") && path.includes("/backup") && method === "GET") {
          const domain = path.split("/")[2];
          return await domainHandler.handleListBackups(decodeURIComponent(domain));
        }

        // Generic domain GET/DELETE - must be AFTER specific routes
        if (path.startsWith("/domains/") && method === "GET") {
          const domain = path.split("/")[2];
          return await domainHandler.handleGetDomain(decodeURIComponent(domain));
        }

        if (path.startsWith("/domains/") && method === "DELETE") {
          const domain = path.split("/")[2];
          return await domainHandler.handleDeleteDomain(decodeURIComponent(domain));
        }

        // ============ Certificate Sync API (for multi-server cert distribution) ============

        // Download certificate from MongoDB (VPS servers call this)
        if (path.startsWith("/certificates/download/") && method === "GET") {
          const domain = path.split("/")[3];
          if (!domain) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: "Domain is required" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }

          try {
            const cert = await certSyncService.downloadCertificateFromMongoDB(decodeURIComponent(domain));
            if (!cert) {
              return addCors(new Response(
                JSON.stringify({ success: false, error: "Certificate not found" }),
                { status: 404, headers: { "Content-Type": "application/json" } }
              ));
            }

            return addCors(new Response(
              JSON.stringify({
                success: true,
                domain: cert.domain,
                cert: cert.cert,
                chain: cert.chain,
                fullchain: cert.fullchain,
                privkey: cert.privkey,
                expiry: cert.expiry,
                version: cert.version,
                uploadedAt: cert.uploadedAt
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ));
          } catch (error) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: String(error) }),
              { status: 500, headers: { "Content-Type": "application/json" } }
            ));
          }
        }

        // List all certificates
        if (path === "/certificates/list" && method === "GET") {
          try {
            const certs = await certSyncService.listCertificates();
            return addCors(new Response(
              JSON.stringify({ success: true, certificates: certs }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ));
          } catch (error) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: String(error) }),
              { status: 500, headers: { "Content-Type": "application/json" } }
            ));
          }
        }

        // Get certificate status
        if (path.startsWith("/certificates/status/") && method === "GET") {
          const domain = path.split("/")[3];
          if (!domain) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: "Domain is required" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }

          try {
            const status = await certSyncService.getCertificateStatus(decodeURIComponent(domain));
            return addCors(new Response(
              JSON.stringify({ success: true, ...status }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ));
          } catch (error) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: String(error) }),
              { status: 500, headers: { "Content-Type": "application/json" } }
            ));
          }
        }

        // Check sync queue (for VPS servers to see pending syncs)
        if (path === "/certificates/sync-queue" && method === "GET") {
          try {
            const { getClient } = await import("./utils/mongodb");
            const queue = getClient()?.db("jrok").collection("cert_sync_queue");
            const pending = await queue?.find({ processed: false }).toArray() || [];

            return addCors(new Response(
              JSON.stringify({ success: true, pending }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ));
          } catch (error) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: String(error) }),
              { status: 500, headers: { "Content-Type": "application/json" } }
            ));
          }
        }

        // Mark sync as processed (VPS server confirms it pulled the cert)
        if (path.startsWith("/certificates/sync-queue/") && method === "POST") {
          const syncId = path.split("/")[3];
          if (!syncId) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: "Sync ID is required" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            ));
          }

          try {
            const { getClient } = await import("./utils/mongodb");
            const queue = getClient()?.db("jrok").collection("cert_sync_queue");
            await queue?.updateOne(
              { _id: decodeURIComponent(syncId) as any },
              { $set: { processed: true, processedAt: new Date() } }
            );

            return addCors(new Response(
              JSON.stringify({ success: true, message: "Sync marked as processed" }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ));
          } catch (error) {
            return addCors(new Response(
              JSON.stringify({ success: false, error: String(error) }),
              { status: 500, headers: { "Content-Type": "application/json" } }
            ));
          }
        }

        // 404
        return addCors(new Response(
          JSON.stringify({
            success: false,
            message: "Not Found",
            path: path,
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        ));
      },
    });

    console.log(`🚀 Server running at http://localhost:${server.port}`);
    console.log(`📝 Base domain: ${config.baseDomain}`);
    console.log(`🔐 Auth enabled with API key`);
    console.log(`🔌 WebSocket agent endpoint: ws://localhost:${server.port}/ws/agent`);

    // Cleanup stale agents every 30 seconds
    // Disconnect if no heartbeat for 150 seconds (allows 10 missed 15s heartbeats)
    // This provides better resilience for long-running idle tunnels
    setInterval(() => {
      agentService.disconnectStaleAgents(150000);
    }, 30000);

    // Cleanup expired tunnels every 5 minutes
    setInterval(async () => {
      try {
        await cleanupExpiredTunnels();
      } catch (error) {
        console.error("Cleanup error:", error);
      }
    }, 5 * 60 * 1000);

    // Cleanup expired rate limit entries every 10 minutes
    setInterval(() => {
      cleanupExpiredLimits();
    }, 10 * 60 * 1000);

    // Aggregate daily stats at midnight (run every hour, only processes yesterday)
    setInterval(async () => {
      try {
        const now = new Date();
        if (now.getHours() === 0) { // Only run at midnight
          await statsService.aggregateDailyStats();
        }
      } catch (error) {
        console.error("Stats aggregation error:", error);
      }
    }, 60 * 60 * 1000);

    console.log("✅ Auto-cleanup enabled (agents: 30s, tunnels: 5m, rate limits: 10m, stats: 1h)");

    // Cleanup orphaned and stale TCP allocations every hour
    setInterval(async () => {
      try {
        await tcpService.cleanupOrphanedAllocations();
        await tcpService.cleanupStaleAllocations(7); // Clean allocations inactive for 7+ days
      } catch (error) {
        console.error("TCP allocation cleanup error:", error);
      }
    }, 60 * 60 * 1000);

    // Check certificate sync queue every 5 minutes (pull new certs to local storage)
    setInterval(async () => {
      try {
        const { getClient } = await import("./utils/mongodb");
        const queue = getClient()?.db("jrok").collection("cert_sync_queue");
        if (!queue) return;

        const serverId = process.env.VPS_ID || process.env.SERVER_ID || "server-1";
        const pendingCerts = await queue.find({ processed: false }).toArray();

        for (const item of pendingCerts) {
          try {
            const cert = await certSyncService.downloadCertificateFromMongoDB(item.domain);
            if (cert) {
              // Write certificates to local filesystem
              const certDir = `/etc/letsencrypt/live/${item.domain}`;
              await Bun.spawn(["mkdir", "-p", certDir]).exited;

              // Decode base64 and write files
              await Bun.write(`${certDir}/cert.pem`, Buffer.from(cert.cert, 'base64'));
              await Bun.write(`${certDir}/chain.pem`, Buffer.from(cert.chain, 'base64'));
              await Bun.write(`${certDir}/fullchain.pem`, Buffer.from(cert.fullchain, 'base64'));
              await Bun.write(`${certDir}/privkey.pem`, Buffer.from(cert.privkey, 'base64'));

              // Set proper permissions
              await Bun.spawn(["chmod", "600", `${certDir}/privkey.pem`]).exited;

              console.log(`🔐 Synced certificate for ${item.domain} (v${cert.version})`);
            }
          } catch (syncError) {
            console.error(`Failed to sync certificate for ${item.domain}:`, syncError);
          }
        }
      } catch (error) {
        console.error("Certificate sync error:", error);
      }
    }, 5 * 60 * 1000);

    console.log("✅ Certificate sync enabled (check every 5 minutes)");

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\n🛑 Shutting down...");

      // Shutdown services
      await crossServerService.shutdownCrossServerRouting();
      securityService.shutdownSecurityService();
      monitoringService.shutdownMonitoringService();

      // Cleanup TCP tunnels for this server
      await tcpService.cleanupServerPorts();

      await closeDatabase();
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();