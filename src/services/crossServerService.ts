/**
 * Cross-Server Request Routing Service
 * 
 * When agents are distributed across multiple servers, this service handles
 * routing HTTP requests to the correct server where the agent WebSocket is connected.
 */

import { 
  getAgentServerInfo, 
  getAllAgentsAsync,
  currentServerId as SERVER_ID,
  currentServerHost as SERVER_HOST,
  currentServerPort as SERVER_PORT,
} from "./agentService";
import { getCollections } from "../utils/mongodb";

// =============================================================================
// SERVER HEALTH TRACKING
// =============================================================================

interface ServerHealth {
  serverId: string;
  serverHost: string;
  serverPort: number;
  region?: string;
  lastHeartbeat: number;
  agentCount: number;
  tunnelCount: number;
  cpuUsage?: number;
  memoryUsage?: number;
  healthy: boolean;
}

const HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds
const SERVER_TIMEOUT_MS = 30000; // 30 seconds without heartbeat = unhealthy

// Local server health
let localAgentCount = 0;
let localTunnelCount = 0;

/**
 * Update local server metrics
 */
export function updateLocalMetrics(agentCount: number, tunnelCount: number): void {
  localAgentCount = agentCount;
  localTunnelCount = tunnelCount;
}

/**
 * Send heartbeat to MongoDB for server health tracking
 */
export async function sendServerHeartbeat(): Promise<void> {
  const collections = getCollections();
  const now = Date.now();

  // Get memory usage (Bun has this available)
  const memUsage = process.memoryUsage?.() || { heapUsed: 0, heapTotal: 1 };
  const memoryUsage = (memUsage.heapUsed / memUsage.heapTotal) * 100;

  await collections.serverHeartbeats.updateOne(
    { serverId: SERVER_ID },
    {
      $set: {
        serverId: SERVER_ID,
        serverHost: SERVER_HOST,
        serverPort: SERVER_PORT,
        region: process.env.VPS_REGION || 'default',
        lastHeartbeat: now,
        agentCount: localAgentCount,
        tunnelCount: localTunnelCount,
        memoryUsage,
        healthy: true,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

/**
 * Get all healthy servers
 */
export async function getHealthyServers(): Promise<ServerHealth[]> {
  const collections = getCollections();
  const cutoffTime = Date.now() - SERVER_TIMEOUT_MS;

  const servers = await collections.serverHeartbeats
    .find({ lastHeartbeat: { $gte: cutoffTime } })
    .toArray();

  return servers.map(s => ({
    serverId: s.serverId,
    serverHost: s.serverHost,
    serverPort: s.serverPort,
    region: s.region,
    lastHeartbeat: s.lastHeartbeat,
    agentCount: s.agentCount || 0,
    tunnelCount: s.tunnelCount || 0,
    cpuUsage: s.cpuUsage,
    memoryUsage: s.memoryUsage,
    healthy: true,
  }));
}

/**
 * Get a specific server by ID
 */
export async function getServer(serverId: string): Promise<ServerHealth | null> {
  const collections = getCollections();
  const server = await collections.serverHeartbeats.findOne({ serverId });
  
  if (!server) return null;

  const isHealthy = Date.now() - server.lastHeartbeat < SERVER_TIMEOUT_MS;

  return {
    serverId: server.serverId,
    serverHost: server.serverHost,
    serverPort: server.serverPort,
    region: server.region,
    lastHeartbeat: server.lastHeartbeat,
    agentCount: server.agentCount || 0,
    tunnelCount: server.tunnelCount || 0,
    cpuUsage: server.cpuUsage,
    memoryUsage: server.memoryUsage,
    healthy: isHealthy,
  };
}

// =============================================================================
// CROSS-SERVER REQUEST ROUTING
// =============================================================================

export interface RouteResult {
  isLocal: boolean;
  targetServer?: {
    serverId: string;
    serverHost: string;
    serverPort: number;
  };
  proxyUrl?: string;
}

/**
 * Determine where to route a request for a specific agent
 */
export async function getAgentRoute(agentId: string): Promise<RouteResult> {
  const serverInfo = await getAgentServerInfo(agentId);

  if (!serverInfo) {
    // Agent not found in any server
    return { isLocal: false };
  }

  // Check if agent is on this server
  if (serverInfo.serverId === SERVER_ID) {
    return { isLocal: true };
  }

  // Agent is on different server - return proxy info
  return {
    isLocal: false,
    targetServer: serverInfo,
    proxyUrl: `http://${serverInfo.serverHost}:${serverInfo.serverPort}`,
  };
}

/**
 * Forward an HTTP request to another server
 */
export async function forwardRequest(
  targetServer: { serverHost: string; serverPort: number },
  originalRequest: Request,
  path: string
): Promise<Response> {
  const proxyUrl = `http://${targetServer.serverHost}:${targetServer.serverPort}${path}`;
  
  try {
    // Clone the request with new URL
    const headers = new Headers(originalRequest.headers);
    headers.set('X-Forwarded-From', SERVER_ID);
    headers.set('X-Forwarded-For', originalRequest.headers.get('x-forwarded-for') || 'unknown');
    
    const response = await fetch(proxyUrl, {
      method: originalRequest.method,
      headers,
      body: originalRequest.method !== 'GET' && originalRequest.method !== 'HEAD'
        ? await originalRequest.clone().text()
        : undefined,
    });

    // Return the proxied response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    console.error(`❌ Failed to forward request to ${proxyUrl}:`, error);
    return new Response(JSON.stringify({ 
      error: 'Server unavailable',
      message: 'Failed to route request to target server',
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Forward a WebSocket upgrade request to another server
 */
export async function forwardWebSocketUpgrade(
  targetServer: { serverHost: string; serverPort: number },
  originalRequest: Request,
  path: string
): Promise<{ ws: WebSocket; response: Response } | null> {
  const wsUrl = `ws://${targetServer.serverHost}:${targetServer.serverPort}${path}`;
  
  try {
    // Create WebSocket connection to target server
    const ws = new WebSocket(wsUrl);
    
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        resolve({
          ws,
          response: new Response(null, { status: 101 }),
        });
      };
      
      ws.onerror = (error) => {
        console.error(`❌ Failed to forward WebSocket to ${wsUrl}:`, error);
        reject(error);
      };
    });
  } catch (error) {
    console.error(`❌ WebSocket forward failed:`, error);
    return null;
  }
}

// =============================================================================
// LOAD BALANCER UTILITIES
// =============================================================================

/**
 * Get best server for new agent connection (for load balancing)
 */
export async function getBestServerForNewConnection(): Promise<ServerHealth | null> {
  const servers = await getHealthyServers();
  
  if (servers.length === 0) {
    return null;
  }

  // Sort by agent count (ascending) - prefer servers with fewer connections
  servers.sort((a, b) => a.agentCount - b.agentCount);

  return servers[0];
}

/**
 * Get cluster statistics
 */
export async function getClusterStats(): Promise<{
  totalServers: number;
  healthyServers: number;
  totalAgents: number;
  totalTunnels: number;
  serverDetails: ServerHealth[];
}> {
  const servers = await getHealthyServers();
  const collections = getCollections();

  // Get total counts from heartbeats
  const totalAgents = servers.reduce((sum, s) => sum + s.agentCount, 0);
  const totalTunnels = servers.reduce((sum, s) => sum + s.tunnelCount, 0);

  // Get total servers (including unhealthy)
  const allServersCount = await collections.serverHeartbeats.countDocuments();

  return {
    totalServers: allServersCount,
    healthyServers: servers.length,
    totalAgents,
    totalTunnels,
    serverDetails: servers,
  };
}

// =============================================================================
// SERVER DISCOVERY FOR DOMAIN ROUTING
// =============================================================================

/**
 * Find server hosting a specific domain's tunnel
 */
export async function findServerForDomain(subdomain: string): Promise<RouteResult> {
  const collections = getCollections();
  
  // Find tunnel for this domain
  const tunnel = await collections.tunnels.findOne({ subdomain, connected: true });
  
  if (!tunnel) {
    return { isLocal: false };
  }

  // Check if tunnel is on this server
  if (tunnel.serverId === SERVER_ID) {
    return { isLocal: true };
  }

  // Get server info
  if (tunnel.serverId) {
    const server = await getServer(tunnel.serverId);
    if (server && server.healthy) {
      return {
        isLocal: false,
        targetServer: {
          serverId: server.serverId,
          serverHost: server.serverHost,
          serverPort: server.serverPort,
        },
        proxyUrl: `http://${server.serverHost}:${server.serverPort}`,
      };
    }
  }

  return { isLocal: false };
}

// =============================================================================
// INITIALIZATION
// =============================================================================

let heartbeatInterval: Timer | null = null;

/**
 * Initialize cross-server routing service
 */
export function initCrossServerRouting(): void {
  // Send initial heartbeat
  sendServerHeartbeat().catch(console.error);

  // Send heartbeat periodically
  heartbeatInterval = setInterval(() => {
    sendServerHeartbeat().catch(console.error);
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`🌐 Cross-server routing initialized (Server: ${SERVER_ID})`);
}

/**
 * Shutdown cross-server routing
 */
export async function shutdownCrossServerRouting(): Promise<void> {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Mark server as unhealthy
  const collections = getCollections();
  await collections.serverHeartbeats.updateOne(
    { serverId: SERVER_ID },
    { $set: { healthy: false, lastHeartbeat: 0 } }
  );

  console.log(`🌐 Cross-server routing shutdown`);
}

// Export current server identity
export const currentServerId = SERVER_ID;
export const currentServerHost = SERVER_HOST;
export const currentServerPort = SERVER_PORT;
