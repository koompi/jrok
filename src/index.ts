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
import { connectDatabase, closeDatabase } from "./utils/mongodb";
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
async function forwardRequestToAgent(req: Request, agentWs: WebSocket, agent: Agent, tunnelId?: string): Promise<Response> {
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

// Initialize tunnel service with config
setConfig(config);

// Initialize Telegram notifications
initTelegram();

// Cache for organization plan tiers (avoid DB lookup on every request)
const orgPlanCache = new Map<string, { tier: string; timestamp: number }>();
const PLAN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getPlanTierForOrg(organizationId: string): Promise<string> {
  // Check cache first
  const cached = orgPlanCache.get(organizationId);
  if (cached && Date.now() - cached.timestamp < PLAN_CACHE_TTL) {
    return cached.tier;
  }
  
  try {
    const { getCollections } = await import("./utils/mongodb");
    const collections = getCollections();
    
    const subscription = await collections.subscriptions.findOne({ organizationId });
    if (!subscription) {
      orgPlanCache.set(organizationId, { tier: 'free', timestamp: Date.now() });
      return 'free';
    }
    
    const plan = await collections.plans.findOne({ id: subscription.planId });
    const tier = plan?.tier || 'free';
    
    orgPlanCache.set(organizationId, { tier, timestamp: Date.now() });
    return tier;
  } catch {
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

    // Initialize security service
    securityService.initSecurityService();
    console.log("✅ Security service initialized");

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

          if (!domain || !localPort) return;

          // Register agent with organization context
          const agent = agentService.registerAgent(ws, domain, localPort, localHost, clientIp, organizationId, apiKeyId, protocol);
          console.log(
            `✅ Agent connected: ${domain} (${localHost}:${localPort}) [${agent.id}] protocol: ${protocol}`
          );

          // Register agent for TCP forwarding if it's a TCP tunnel
          if (protocol === 'tcp') {
            tcpService.registerAgentConnection(agent.id, ws);
          }

          // Send welcome message
          ws.send(
            JSON.stringify({
              type: "welcome",
              agentId: agent.id,
              message: "Connected to jrok",
              protocol,
            })
          );

          // For TCP tunnels, send the allocated port after tunnel is created
          if (protocol === 'tcp') {
            // Wait for tunnel creation and then send TCP port info
            setTimeout(async () => {
              const allocation = tcpService.getPortAllocation(agent.tunnelId || '');
              if (allocation) {
                ws.send(JSON.stringify({
                  type: "welcome",
                  agentId: agent.id,
                  message: "TCP tunnel ready",
                  protocol,
                  tcpPort: allocation.port,
                }));
              }
            }, 1000); // Wait 1 second for tunnel creation
          }
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

        // Handle preflight OPTIONS request
        if (method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
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
            JSON.stringify({ success: true, message: "Server is running" }),
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
          const stats = tcpService.getTcpStats();
          const allocations = tcpService.getAllPortAllocations();
          return addCors(new Response(
            JSON.stringify({
              success: true,
              stats,
              allocations: allocations.map(a => ({
                port: a.port,
                tunnelId: a.tunnelId,
                localPort: a.localPort,
                localHost: a.localHost,
                createdAt: a.createdAt,
                active: a.active,
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

        // Set IP allowlist for a tunnel
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
          securityService.setIpAllowlist(tunnelId, body.ips);
          return addCors(new Response(
            JSON.stringify({ success: true, message: `Allowlist updated for tunnel ${tunnelId}` }),
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
        // Check if this is a tunnel domain request (extract subdomain)
        // MUST be before auth check to allow public tunnel access
        const baseDomain = config.baseDomain; // e.g., "tunnel.koompi.cloud"
        if (hostname.endsWith(baseDomain) && hostname !== baseDomain) {
          // Extract subdomain (e.g., "demo" from "demo.tunnel.koompi.cloud")
          const subdomain = hostname.replace(`.${baseDomain}`, '');
          
          // Look up agent for this domain
          const agent = agentService.getAgentByDomain(subdomain);
          
          if (!agent || !agent.active) {
            return addCors(new Response(
              JSON.stringify({
                success: false,
                message: `No active agent found for domain: ${subdomain}. Please ensure the agent is running: bun src/index.ts connect --domain ${subdomain}`,
              }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            ));
          }

          // Get agent's WebSocket
          const agentWs = agentService.getAgentSocket(agent.id);
          if (!agentWs || agentWs.readyState !== 1) {  // 1 = WebSocket.OPEN
            return addCors(new Response(
              JSON.stringify({
                success: false,
                message: `Agent for ${subdomain} is not connected (readyState: ${agentWs?.readyState || 'null'}). Attempting reconnection...`,
              }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            ));
          }

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
          
          // Get plan tier for rate limit calculation (defaults to 'free')
          const planTier = agent.organizationId ? await getPlanTierForOrg(agent.organizationId) : 'free';
          
          // Check security limits
          const securityCheck = await securityService.checkHttpRequest(
            tunnelId || subdomain,
            agent.organizationId,
            clientIp,
            planTier
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

          // Track HTTP connection
          securityService.trackHttpConnection(tunnelId || subdomain, true);

          // Check if this is a WebSocket upgrade request
          if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            // Handle WebSocket tunneling
            const response = await handleWebSocketTunnel(req, server, agentWs, agent, subdomain);
            if (response) {
              securityService.trackHttpConnection(tunnelId || subdomain, false);
              return response;
            }
            return undefined; // Handled by upgrade
          }

          // Forward regular HTTP request to agent via WebSocket (with bandwidth tracking)
          const response = await forwardRequestToAgent(req, agentWs, agent, tunnelId);
          
          // Track connection close and bandwidth
          securityService.trackHttpConnection(tunnelId || subdomain, false);
          
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
      return agentHandler.handleListAgents();
    }

    // Domain routes
    if (path === "/domains" && method === "POST") {
      return await domainHandler.handleRegisterDomain(req);
    }

    if (path === "/domains" && method === "GET") {
      return await domainHandler.handleListDomains();
    }

    if (path.startsWith("/domains/") && method === "GET") {
      const domain = path.split("/")[2];
      return await domainHandler.handleGetDomain(decodeURIComponent(domain));
    }

    if (path.startsWith("/domains/") && method === "DELETE") {
      const domain = path.split("/")[2];
      return await domainHandler.handleDeleteDomain(decodeURIComponent(domain));
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

    if (path.startsWith("/domains/") && path.includes("/backup") && method === "GET") {
      const domain = path.split("/")[2];
      return await domainHandler.handleListBackups(decodeURIComponent(domain));
    }

    if (path.startsWith("/domains/") && path.includes("/backups/") && method === "POST") {
      const parts = path.split("/");
      const domain = parts[2];
      const backupId = parts[4];
      return await domainHandler.handleRestoreDomain(decodeURIComponent(domain), backupId);
    }

    if (path.startsWith("/domains/") && method === "GET") {
      const domain = path.split("/")[2];
      return await domainHandler.handleGetDomain(decodeURIComponent(domain));
    }

    if (path.startsWith("/domains/") && method === "DELETE") {
      const domain = path.split("/")[2];
      return await domainHandler.handleDeleteDomain(decodeURIComponent(domain));
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

    // Cleanup stale agents every 30 seconds (disconnect if no heartbeat for 90 seconds)
    setInterval(() => {
      agentService.disconnectStaleAgents(90000);
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

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\n🛑 Shutting down...");
      await closeDatabase();
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();