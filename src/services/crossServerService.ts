/**
 * Cross-Server Request Routing Service
 * 
 * When agents are distributed across multiple servers, this service handles
 * routing HTTP requests to the correct server where the agent WebSocket is connected.
 */

import {
  getAgentServerInfo,
  getAllAgentsAsync,
  getAgentByDomainLocal,
  getAgentSocket,
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
  path: string,
  clientIp?: string
): Promise<Response> {
  const proxyUrl = `http://${targetServer.serverHost}:${targetServer.serverPort}${path}`;

  try {
    const headers = new Headers(originalRequest.headers);
    headers.set('X-Forwarded-From', SERVER_ID);

    // The target resolves which tunnel this is from the Host header, so it must
    // survive the hop verbatim — without it the target sees a request for
    // "10.0.0.2:3000" and has no idea which customer domain was asked for.
    const originalHost = originalRequest.headers.get('host');
    if (originalHost) headers.set('host', originalHost);

    // Preserve the real visitor IP. This is not just for logs: per-tunnel IP
    // allow/block lists are evaluated on the target, and the target sees THIS
    // server's address on the socket. Writing the literal string 'unknown' (as
    // this did before) makes an allowlist reject a legitimate visitor and a
    // blocklist let a blocked one through.
    //
    // An X-Forwarded-For set by the edge nginx already leads with the visitor's
    // address, so it crosses unchanged; only when there is none do we supply
    // what we worked out ourselves.
    if (!originalRequest.headers.get('x-forwarded-for')) {
      if (clientIp) {
        headers.set('X-Forwarded-For', clientIp);
      } else {
        // Nothing trustworthy to forward — say nothing rather than assert 'unknown'.
        headers.delete('X-Forwarded-For');
      }
    }

    const hasBody = originalRequest.method !== 'GET' && originalRequest.method !== 'HEAD';

    const response = await fetch(proxyUrl, {
      method: originalRequest.method,
      headers,
      // Stream the body through as RAW BYTES.
      //
      // This used to be `await originalRequest.clone().text()`, which decodes
      // the body as UTF-8: every byte that isn't valid UTF-8 became U+FFFD, so
      // any image, PDF, protobuf, gzip or multipart upload arrived corrupted
      // AND larger than it started, with a 200 OK. It is the same bug the agent
      // hop fixed with the b64body capability, one hop further along.
      //
      // Streaming also keeps a large upload from being buffered a second time
      // on this server, on top of the buffering the target already does.
      body: hasBody ? originalRequest.body : undefined,
      // Required by fetch whenever body is a stream.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);

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
 * Build the target URL and headers for relaying a WebSocket to another server.
 *
 * This replaces a `forwardWebSocketUpgrade` that could not work and which
 * nothing ever called: it opened a socket to the target and returned a bare
 * `Response(null, {status: 101})`, but Bun only establishes a WebSocket via
 * `server.upgrade()`, and nothing joined the visitor's socket to the forwarded
 * one. The upgrade therefore fell through to the plain HTTP forwarder, where
 * `fetch()` cannot carry an upgrade — so every WebSocket whose agent lived on
 * another server simply failed.
 *
 * Relaying the frames is the caller's job (see the 'cross-server' branch in the
 * websocket handlers in index.ts); this function only decides where to dial and
 * what to say on the way in.
 */
export function buildCrossServerWsTarget(
  targetServer: { serverHost: string; serverPort: number },
  originalRequest: Request,
  path: string,
  clientIp?: string
): { url: string; headers: Record<string, string> } {
  const url = `ws://${targetServer.serverHost}:${targetServer.serverPort}${path}`;

  // Carry the request's headers across, minus the ones that belong to THIS
  // hop's handshake — the outgoing WebSocket generates its own. Host must
  // survive, or the target cannot tell which tunnel the visitor asked for.
  const headers: Record<string, string> = {};
  originalRequest.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === 'upgrade' || k === 'connection' || k.startsWith('sec-websocket-')) return;
    headers[key] = value;
  });

  const originalHost = originalRequest.headers.get('host');
  if (originalHost) headers['host'] = originalHost;

  headers['X-Forwarded-From'] = SERVER_ID;
  if (!originalRequest.headers.get('x-forwarded-for') && clientIp) {
    headers['X-Forwarded-For'] = clientIp;
  }

  return { url, headers };
}


// =============================================================================
// CROSS-SERVER WEBSOCKET RELAY
// =============================================================================
// When a visitor's WebSocket lands on a server that does not hold the agent,
// this server accepts the socket and relays frames to the peer that does. The
// logic lives here rather than inline in the request handler so it can be
// tested against two real sockets.
//
// The relay is deliberately dumb: it does not parse or transform frames, it
// only moves bytes and makes sure both halves die together.

/** The subset of a Bun ServerWebSocket the relay needs. */
export interface RelaySocket {
  send(data: any): unknown;
  close(code?: number, reason?: string): unknown;
  data: any;
}

/** Only 1000 and 3000-4999 may be sent on the wire; map anything else to 1000. */
function safeCloseCode(code?: number): number {
  return code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000;
}

/**
 * Dial the peer server and start relaying. Called when the visitor's socket opens.
 *
 * Frames the visitor sends before the peer link finishes opening are queued
 * rather than dropped: browsers routinely send immediately after onopen, and
 * that first frame is often the subscribe or auth message the session depends on.
 */
export function openCrossServerRelay(ws: RelaySocket): void {
  const { targetUrl, targetHeaders, subdomain } = ws.data;
  ws.data.pending = [];
  ws.data.peerReady = false;

  let peer: WebSocket;
  try {
    peer = new WebSocket(targetUrl, { headers: targetHeaders } as any);
  } catch (error) {
    console.error(`❌ Cross-server WS dial failed for ${subdomain}:`, error);
    ws.close(1011, "Cross-server routing failed");
    return;
  }

  peer.binaryType = "arraybuffer";
  ws.data.peer = peer;

  peer.onopen = () => {
    for (const frame of ws.data.pending) {
      try { peer.send(frame); } catch { /* peer died mid-drain */ }
    }
    ws.data.pending = [];
    ws.data.peerReady = true;
    console.log(`🔀 Cross-server WebSocket relay open for ${subdomain}`);
  };

  peer.onmessage = (event: any) => {
    try {
      ws.send(event.data instanceof ArrayBuffer ? Buffer.from(event.data) : event.data);
    } catch { /* visitor gone; the close handler tears down */ }
  };

  peer.onclose = (event: any) => {
    ws.data.peerReady = false;
    try { ws.close(safeCloseCode(event?.code), event?.reason || ""); } catch { /* already closed */ }
  };

  peer.onerror = () => {
    console.error(`❌ Cross-server WebSocket relay error for ${subdomain}`);
    try { ws.close(1011, "Cross-server relay error"); } catch { /* already closed */ }
  };
}

/** Pass a visitor frame to the peer, queueing until the peer link is open. */
export function relayVisitorFrame(ws: RelaySocket, data: string | Buffer): void {
  const peer: WebSocket | undefined = ws.data?.peer;
  if (!peer) return;
  if (ws.data.peerReady && peer.readyState === 1) {
    try { peer.send(data); } catch { /* peer died; close handler cleans up */ }
  } else {
    ws.data.pending.push(data);
  }
}

/**
 * The visitor hung up — drop the peer link too. Without this the peer socket
 * leaks, and with it the agent-side connection it opened on the other server.
 */
export function closeCrossServerRelay(ws: RelaySocket, code?: number, reason?: string): void {
  const peer: WebSocket | undefined = ws.data?.peer;
  if (ws.data) ws.data.pending = [];
  if (peer && (peer.readyState === 0 || peer.readyState === 1)) {
    try { peer.close(safeCloseCode(code), reason || ""); } catch { /* already gone */ }
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

  return servers[0] || null;
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

  // FAST PATH: if we already hold a live WebSocket for this domain, the agent is
  // on THIS server by definition — no database round trip can tell us anything
  // we don't already know from the socket in our own hand.
  //
  // This is an exact check, not a cached guess: `localDomainCache` is populated
  // when an agent registers here and cleared when it disconnects, and we further
  // require the socket to be OPEN. A stale entry therefore falls through to the
  // MongoDB path below rather than routing wrongly.
  //
  // This matters because findServerForDomain runs on EVERY tunneled request. On
  // a single-node deployment it was a guaranteed Mongo query per request; on a
  // multi-node one it's still the common case, since traffic usually reaches the
  // node holding the agent. Those queries competed with agent heartbeat writes —
  // and a starved heartbeat is what expires an agentConnections record and gets
  // a healthy tunnel killed (see Fix-065). Cutting this query protects tunnel
  // liveness as much as it protects throughput.
  const localAgent = getAgentByDomainLocal(subdomain);
  if (localAgent) {
    const ws = getAgentSocket(localAgent.id);
    if (ws && ws.readyState === 1) {
      return { isLocal: true };
    }
  }

  // First check agentConnections (most reliable for active connections)
  const agentConn = await collections.agentConnections.findOne({
    domain: subdomain,
    active: true
  });
  
  if (agentConn) {
    // Check if agent is on this server
    if (agentConn.serverId === SERVER_ID) {
      return { isLocal: true };
    }
    
    // Get server info for cross-server routing
    const server = await getServer(agentConn.serverId);
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
  
  // Fallback: check tunnels collection (for cases where agent just connected)
  const tunnel = await collections.tunnels.findOne({ 
    domain: subdomain, 
    active: true 
  });
  
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
