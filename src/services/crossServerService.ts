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
  localAgentCount,
  currentServerId as SERVER_ID,
  currentServerHost as SERVER_HOST,
  currentServerPort as SERVER_PORT,
} from "./agentService";
import { getCollections } from "../utils/mongodb";
import { StaleCache } from "../utils/staleCache";
import { AGENT_WS_BUFFER_LIMIT_BYTES, frameByteLength, isBacklogged } from "../utils/wsFlowControl";
import { addressPeerRequest, ownForwardUrl, peerOrigin } from "../utils/peerLink";
import { firstSubprotocol } from "../utils/wsSubprotocol";

// =============================================================================
// SERVER HEALTH TRACKING
// =============================================================================

interface ServerHealth {
  serverId: string;
  serverHost: string;
  serverPort: number;
  /** Where other edges forward to (FORWARD_URL); unset means plain http to serverHost:serverPort. */
  forwardUrl?: string;
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
let localTunnelCount = 0;

/**
 * Update local server metrics (agents are counted from their sockets)
 */
export function updateLocalMetrics(_agentCount: number, tunnelCount: number): void {
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
        forwardUrl: ownForwardUrl(),
        region: process.env.VPS_REGION || 'default',
        lastHeartbeat: now,
        // Counted from the sockets: updateLocalMetrics is never called, so
        // this was always 0. A rolling deploy waits on it (Ansible app role).
        agentCount: localAgentCount(),
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
    forwardUrl: s.forwardUrl || undefined,
    region: s.region,
    lastHeartbeat: s.lastHeartbeat,
    agentCount: s.agentCount || 0,
    tunnelCount: s.tunnelCount || 0,
    cpuUsage: s.cpuUsage,
    memoryUsage: s.memoryUsage,
    healthy: true,
  }));
}

// Server records, read for every forwarded request (P14). Health is judged when
// a record is loaded, so a server that loses MongoDB keeps forwarding to the
// peers it last saw alive instead of watching their heartbeats age out (P8).
const serverCache = new StaleCache<string, ServerHealth | null>("server lookup", loadServer, 5_000);

/**
 * Get a specific server by ID
 */
export function getServer(serverId: string): Promise<ServerHealth | null> {
  return serverCache.get(serverId);
}

async function loadServer(serverId: string): Promise<ServerHealth | null> {
  const collections = getCollections();
  const server = await collections.serverHeartbeats.findOne({ serverId });
  
  if (!server) return null;

  const isHealthy = Date.now() - server.lastHeartbeat < SERVER_TIMEOUT_MS;

  return {
    serverId: server.serverId,
    serverHost: server.serverHost,
    serverPort: server.serverPort,
    forwardUrl: server.forwardUrl || undefined,
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

export interface PeerTarget {
  serverId?: string;
  serverHost: string;
  serverPort: number;
  forwardUrl?: string;
}

export interface RouteResult {
  isLocal: boolean;
  targetServer?: PeerTarget & { serverId: string };
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
    proxyUrl: peerOrigin(serverInfo),
  };
}

/**
 * Forward an HTTP request to another server
 */
export async function forwardRequest(
  targetServer: PeerTarget,
  originalRequest: Request,
  path: string,
  clientIp?: string
): Promise<Response> {
  // HTTPS to the peer's FORWARD_URL when it has one (P10, utils/peerLink.ts).
  const proxyUrl = `${peerOrigin(targetServer)}${path}`;

  try {
    const headers = new Headers(originalRequest.headers);
    headers.set('X-Forwarded-From', SERVER_ID);

    // The target resolves which tunnel this is from the visitor's Host, so it
    // must survive the hop verbatim — without it the target sees a request for
    // "10.0.0.2:3000" and has no idea which customer domain was asked for.
    addressPeerRequest(
      targetServer,
      originalRequest.headers.get('host'),
      (name, value) => headers.set(name, value),
      (name) => headers.delete(name),
    );

    // Preserve the real visitor IP. This is not just for logs: per-tunnel IP
    // allow/block lists are evaluated on the target, and the target sees THIS
    // server's address on the socket. Writing the literal string 'unknown' (as
    // this did before) makes an allowlist reject a legitimate visitor and a
    // blocklist let a blocked one through.
    //
    // Always the address this server verified (utils/clientIp.ts), replacing
    // what came in. The incoming X-Forwarded-For starts with whatever the
    // visitor chose to send; the target counts hops from the right, so as a
    // single entry the verified address is exactly what it picks.
    headers.delete('X-Real-IP');
    if (clientIp) {
      headers.set('X-Forwarded-For', clientIp);
      headers.set('X-Real-IP', clientIp);
    } else {
      // Nothing trustworthy to forward — say nothing rather than assert 'unknown'.
      headers.delete('X-Forwarded-For');
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
      // Pass the body on exactly as the peer sent it. fetch would otherwise
      // unzip a gzip response (the agent compresses in the tunnel, Phase 0.5)
      // while its Content-Encoding: gzip header went on to the visitor, who
      // then failed to unzip plain text.
      decompress: false,
      // An app's redirect goes back to the visitor as it is (P34). fetch
      // followed it here instead: the visitor got the next page under the
      // old URL, a Set-Cookie on the redirect was lost, and a redirect to a
      // sign-in provider was fetched by this edge.
      redirect: 'manual',
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
      headers: { 'Content-Type': 'application/json', [ROUTE_HEADER]: 'unreachable' },
    });
  }
}

// =============================================================================
// ONE HOP (P9)
// =============================================================================
// A request another server forwarded here is never forwarded again. When
// MongoDB's record of where an agent is goes stale, two servers could otherwise
// pass a request back and forth until it timed out. Instead the receiving
// server answers "miss" and the sender looks the route up again, once.

const ROUTE_HEADER = 'X-Jrok-Route';

/** True if another jrok server forwarded this request here. */
export function isForwardedRequest(req: Request): boolean {
  return req.headers.has('X-Forwarded-From');
}

/** The answer to a forwarded request for a domain whose agent isn't here. */
export function routeMissResponse(subdomain: string): Response {
  return new Response(JSON.stringify({
    success: false,
    message: `The agent for ${subdomain} is not on this server.`,
  }), {
    status: 503,
    // "reconnecting", not "down": the deploy worker restarts tunnels on "down".
    headers: { 'Content-Type': 'application/json', [ROUTE_HEADER]: 'miss', 'X-Jrok-Tunnel': 'reconnecting' },
  });
}

/**
 * Forward to the server holding the agent. If that server no longer has it
 * ("miss") or can't be reached, drop the cached route and try the server a
 * fresh lookup names, once. Requests with a body are not retried: the body was
 * spent on the first attempt, so the visitor gets the error and retries.
 */
export async function forwardToAgentServer(
  subdomain: string,
  targetServer: PeerTarget,
  req: Request,
  path: string,
  clientIp?: string
): Promise<Response> {
  const response = await forwardRequest(targetServer, req, path, clientIp);
  const route = response.headers.get(ROUTE_HEADER);
  if (route !== 'miss' && route !== 'unreachable') return response;

  forgetRoute(subdomain);
  if (req.method !== 'GET' && req.method !== 'HEAD') return response;

  let fresh: RouteResult;
  try {
    fresh = await findServerForDomain(subdomain);
  } catch {
    return response;
  }
  const next = fresh.targetServer;
  if (!next || next.serverId === targetServer.serverId) return response;

  await response.body?.cancel().catch(() => {});
  return forwardRequest(next, req, path, clientIp);
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
  targetServer: PeerTarget,
  originalRequest: Request,
  path: string,
  clientIp?: string
): { url: string; headers: Record<string, string>; subprotocol?: string } {
  // wss:// to the peer's FORWARD_URL when it has one (P10, utils/peerLink.ts).
  const url = `${peerOrigin(targetServer, true)}${path}`;

  // Carry the request's headers across, minus the ones that belong to THIS
  // hop's handshake — the outgoing WebSocket generates its own (it asks the
  // peer for the visitor's first subprotocol). Host must survive, or the target
  // cannot tell which tunnel the visitor asked for.
  const headers: Record<string, string> = {};
  originalRequest.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === 'upgrade' || k === 'connection' || k.startsWith('sec-websocket-')) return;
    // Replaced below with the address this server verified.
    if (k === 'x-forwarded-for' || k === 'x-real-ip') return;
    headers[key] = value;
  });

  addressPeerRequest(
    targetServer,
    originalRequest.headers.get('host'),
    (name, value) => { headers[name] = value; },
    (name) => {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    },
  );

  headers['X-Forwarded-From'] = SERVER_ID;
  // Same rule as forwardRequest: the verified address, never the incoming chain.
  if (clientIp) {
    headers['X-Forwarded-For'] = clientIp;
    headers['X-Real-IP'] = clientIp;
  }

  return { url, headers, subprotocol: firstSubprotocol(originalRequest.headers.get('sec-websocket-protocol')) };
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
  const { targetUrl, targetHeaders, subprotocol, subdomain } = ws.data;
  ws.data.pending = [];
  ws.data.peerReady = false;

  let peer: WebSocket;
  try {
    peer = new WebSocket(targetUrl, { headers: targetHeaders, ...(subprotocol ? { protocols: [subprotocol] } : {}) } as any);
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
    ws.data.pendingBytes = 0;
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

/**
 * Pass a visitor frame to the peer, queueing until the peer link is open.
 * False when the peer link is backed up (or the pre-open queue is full): the
 * caller closes the visitor instead of buffering without limit.
 */
export function relayVisitorFrame(ws: RelaySocket, data: string | Buffer): boolean {
  const peer: WebSocket | undefined = ws.data?.peer;
  if (!peer) return true;
  if (ws.data.peerReady && peer.readyState === 1) {
    if (isBacklogged(peer)) return false;
    try { peer.send(data); } catch { /* peer died; close handler cleans up */ }
  } else {
    const pendingBytes = (ws.data.pendingBytes ?? 0) + frameByteLength(data);
    if (AGENT_WS_BUFFER_LIMIT_BYTES > 0 && pendingBytes > AGENT_WS_BUFFER_LIMIT_BYTES) return false;
    ws.data.pendingBytes = pendingBytes;
    ws.data.pending.push(data);
  }
  return true;
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

  return routeCache.get(subdomain);
}

// Where MongoDB last said a domain's agent is, for agents on other servers.
// Without it every forwarded request made two queries (P14). Short TTL, since
// agents move between servers when they reconnect; a route that turns out to
// be stale is dropped and looked up again (forwardToAgentServer). Kept if
// MongoDB fails, so forwarding that worked keeps working (P8).
const ROUTE_CACHE_TTL_MS = 3_000;
const routeCache = new StaleCache<string, RouteResult>("route lookup", lookupRoute, ROUTE_CACHE_TTL_MS);

/** Drop a domain's cached route, so the next request looks it up again. */
export function forgetRoute(subdomain: string): void {
  routeCache.delete(subdomain);
}

async function lookupRoute(subdomain: string): Promise<RouteResult> {
  const collections = getCollections();

  // First check agentConnections (most reliable for active connections).
  // Never a record claiming THIS server: had this server the agent, the fast
  // path in findServerForDomain would have found its socket, so such a record
  // is stale (e.g. left from before a restart) and other servers' records are
  // the ones that can actually serve.
  const agentConn = await collections.agentConnections.findOne({
    domain: subdomain,
    active: true,
    serverId: { $ne: SERVER_ID },
  });
  
  if (agentConn) {
    // Get server info for cross-server routing
    const server = await getServer(agentConn.serverId);
    if (server && server.healthy) {
      return {
        isLocal: false,
        targetServer: {
          serverId: server.serverId,
          serverHost: server.serverHost,
          serverPort: server.serverPort,
          forwardUrl: server.forwardUrl,
        },
        proxyUrl: peerOrigin(server),
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
          forwardUrl: server.forwardUrl,
        },
        proxyUrl: peerOrigin(server),
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
