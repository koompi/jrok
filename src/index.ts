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
import { connectDatabase, closeDatabase } from "./utils/mongodb";
import { cleanupExpiredLimits } from "./utils/rateLimiter";
import { initTelegram } from "./services/notificationService";
import { generateId } from "./utils/helpers";
import type { TunnelConfig, Agent, AuthContext } from "./types/index";

// Store pending requests waiting for agent responses
const pendingRequests = new Map<string, { resolve: (response: Response) => void; timeout: Timer }>();

// Forward HTTP request to agent via WebSocket
async function forwardRequestToAgent(req: Request, agentWs: WebSocket, agent: Agent): Promise<Response> {
  return new Promise(async (resolve) => {
    const requestId = generateId();
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(new Response("Gateway Timeout - Agent did not respond", { status: 504 }));
    }, 30000); // 30 second timeout

    // Store pending request
    pendingRequests.set(requestId, { resolve, timeout });

    // Prepare request data to send to agent
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });

    try {
      // Read request body
      const body = await req.text();
      
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

    // Register current VPS server if running on a VPS with SSH
    await registerLocalVpsServer();

    // HTTP Server
    const server = Bun.serve({
      port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
      websocket: {
        open(ws: any) {
          const domain = ws.data?.domain;
          const localPort = ws.data?.localPort;
          const localHost = ws.data?.localHost;
          const clientIp = ws.data?.clientIp;

          if (!domain || !localPort) return;

          // Register agent
          const agent = agentService.registerAgent(ws, domain, localPort, localHost, clientIp);
          console.log(
            `✅ Agent connected: ${domain} (${localHost}:${localPort}) [${agent.id}]`
          );

          // Send welcome message
          ws.send(
            JSON.stringify({
              type: "welcome",
              agentId: agent.id,
              message: "Connected to jrok",
            })
          );
        },

        message(ws: any, data: string | Buffer) {
          try {
            const message = JSON.parse(data.toString());

            if (message.type === "heartbeat") {
              const agentId = agentService.getAgentIdBySocket(ws);

              if (agentId) {
                agentService.updateHeartbeat(agentId);
                ws.send(JSON.stringify({ type: "heartbeat_ack" }));
              }
            } else if (message.type === "http_response") {
              // Handle HTTP response from agent
              const pending = pendingRequests.get(message.requestId);
              if (pending) {
                clearTimeout(pending.timeout);
                pendingRequests.delete(message.requestId);
                
                // Build response
                const responseHeaders = new Headers(message.headers || {});
                pending.resolve(new Response(message.body, {
                  status: message.status || 200,
                  statusText: message.statusText || "OK",
                  headers: responseHeaders,
                }));
              }
            } else if (message.type === "error") {
              console.error("Agent error:", message.payload);
            }
          } catch (error) {
            console.error("Failed to parse agent message:", error);
          }
        },

        close(ws: any) {
          const agentId = agentService.getAgentIdBySocket(ws);

          if (agentId) {
            const agent = agentService.getAgent(agentId);
            console.log(`🔌 Agent disconnected: ${agent?.domain} [${agentId}]`);
            agentService.unregisterAgent(agentId);
          }
        },

        error(ws: any, error: Error) {
          console.error("WebSocket error:", error);
        },
      },
      async fetch(req: Request) {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;
        const hostname = url.hostname;

        // CORS headers for dashboard access
        const corsHeaders = {
          "Access-Control-Allow-Origin": req.headers.get("Origin") || "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
          "Access-Control-Allow-Credentials": "true",
        };

        // Handle preflight OPTIONS request
        if (method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Helper to add CORS headers to response
        const addCors = (response: Response): Response => {
          const newHeaders = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([key, value]) => {
            newHeaders.set(key, value);
          });
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        };

        // Agent WebSocket upgrade (no auth needed for initial handshake)
        if (path === "/ws/agent" && req.headers.get("upgrade") === "websocket") {
          return agentHandler.handleAgentUpgrade(req, server);
        }

        // Check if this is a tunnel domain request (extract subdomain)
        const baseDomain = config.baseDomain; // e.g., "tunnel.matrixchat.space"
        if (hostname.endsWith(baseDomain) && hostname !== baseDomain) {
          // Extract subdomain (e.g., "demo" from "demo.tunnel.matrixchat.space")
          const subdomain = hostname.replace(`.${baseDomain}`, '');
          
          // Look up agent for this domain
          const agent = agentService.getAgentByDomain(subdomain);
          
          if (!agent || !agent.active) {
            return new Response(
              JSON.stringify({
                success: false,
                message: `No active agent found for domain: ${subdomain}`,
              }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          }

          // Get agent's WebSocket
          const agentWs = agentService.getAgentSocket(agent.id);
          if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
            return new Response(
              JSON.stringify({
                success: false,
                message: `Agent for ${subdomain} is not connected`,
              }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          }

          // Forward request to agent via WebSocket
          return await forwardRequestToAgent(req, agentWs, agent);
        }

        // ============ Public Routes (no auth required) ============

        // Health check
        if (path === "/health" && method === "GET") {
          return addCors(new Response(
            JSON.stringify({ success: true, message: "Server is running" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }

        // Auth routes
        if (path === "/auth/login" && method === "GET") {
          return addCors(authHandler.handleGetLoginUrl());
        }

        // POST callback - called by dashboard after OAuth redirect
        if (path === "/auth/callback" && method === "POST") {
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

    // Legacy Tunnel Routes
    if (path === "/tunnels" && method === "POST") {
      return await tunnelHandler.handleCreateTunnel(req);
    }

    if (path === "/tunnels" && method === "GET") {
      return await tunnelHandler.handleListTunnels();
    }

    if (path.startsWith("/tunnels/") && method === "GET") {
      const id = path.split("/")[2];
      return await tunnelHandler.handleGetTunnel(id);
    }

    if (path.startsWith("/tunnels/") && method === "DELETE") {
      const id = path.split("/")[2];
      return await tunnelHandler.handleDeleteTunnel(id);
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