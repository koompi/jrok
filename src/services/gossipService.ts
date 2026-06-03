/**
 * Gossip-based Distributed Routing Table
 * =============================================================================
 * Replaces the per-request MongoDB lookup (findServerForDomain) with an
 * in-memory map that is replicated across kproxy nodes via a full-mesh gossip
 * protocol. MongoDB (agentConnections) remains the COLD / durable fallback;
 * gossip is the HOT path so a request never touches the DB to find an agent.
 *
 * Design — "gossip the placement map" (no external store, no SPOF):
 *   - Each node holds an in-memory map:  domain -> RouteEntry
 *   - On agent connect/disconnect the holding node broadcasts a delta
 *   - Receivers merge by (ts, serverId): newest ts wins; deletes are tombstones
 *   - Relay-on-change spreads deltas epidemically (resilient if not full-mesh)
 *   - Periodic anti-entropy: nodes push their full state to peers to heal drops
 *   - whoHas(domain): one-shot broadcast query that covers the sub-second
 *     window between an agent connecting and its delta propagating
 *   - Peers are discovered from serverHeartbeats and dialed over DIRECT
 *     host:port (NOT through Cloudflare). Exactly one connection per pair via
 *     the "lower serverId dials" rule.
 *
 * Routing availability == cluster availability: if enough nodes are up to
 * serve traffic, the routing brain is up too. Nothing separate to keep alive.
 * =============================================================================
 */

import { generateId } from "../utils/helpers";
import {
  currentServerId as SERVER_ID,
  currentServerHost as SERVER_HOST,
  currentServerPort as SERVER_PORT,
  getHealthyServers,
} from "./agentService";

// =============================================================================
// TYPES
// =============================================================================

export interface RouteEntry {
  domain: string;
  agentId: string;
  serverId: string;
  serverHost: string;
  serverPort: number;
  active: boolean; // false = tombstone (agent disconnected)
  ts: number;      // last-write time (ms) — primary ordering for conflict resolution
}

interface PeerState {
  ws: WebSocket;
  peerId?: string;   // known immediately for outbound dials, after "hello" for inbound
  host?: string;
  port?: number;
  outbound: boolean; // true = we dialed them, false = they dialed us
}

type GossipMessage =
  | { t: "hello"; id: string; host: string; port: number }
  | { t: "delta"; entries: RouteEntry[] }
  | { t: "sync"; entries: RouteEntry[] }
  | { t: "whohas"; domain: string; rid: string; from: string }
  | { t: "ihave"; domain: string; rid: string; entry: RouteEntry | null };

// =============================================================================
// STATE
// =============================================================================

// The replicated routing table. Includes recent tombstones (GC'd periodically).
const routes = new Map<string, RouteEntry>();

// All live peer connections (inbound + outbound), keyed by the socket.
const peerState = new Map<WebSocket, PeerState>();

// Connected peers keyed by serverId, for directed sends (whoHas replies).
const peerById = new Map<string, WebSocket>();

// Outstanding whoHas queries awaiting a reply, keyed by request id.
const whoHasWaiters = new Map<string, { resolve: (e: RouteEntry | null) => void; timeout: any }>();

// Shared secret guarding the gossip mesh. Without it, any host that can reach a
// node's port could connect to /_gossip and inject fake routing entries to
// hijack traffic for any domain. Set GOSSIP_SECRET to the same value on every node.
const SECRET = process.env.GOSSIP_SECRET || "";

// Tunables
const DISCOVERY_INTERVAL_MS = 10_000;   // re-scan heartbeats & (re)dial peers
const ANTI_ENTROPY_INTERVAL_MS = 30_000; // push full state to peers
const TOMBSTONE_TTL_MS = 5 * 60_000;     // keep tombstones this long before GC
const STALE_ROUTE_TTL_MS = 90_000;       // evict remote routes whose node is gone & older than this
const WHOHAS_TIMEOUT_MS = 300;           // how long to wait for a whoHas reply

let started = false;
let discoveryTimer: any = null;
let antiEntropyTimer: any = null;
let gcTimer: any = null;

// =============================================================================
// CONFLICT RESOLUTION
// =============================================================================

/** Merge an incoming entry. Returns true if it changed our local state. */
function mergeEntry(incoming: RouteEntry): boolean {
  const cur = routes.get(incoming.domain);
  if (
    !cur ||
    incoming.ts > cur.ts ||
    (incoming.ts === cur.ts && incoming.serverId > cur.serverId)
  ) {
    routes.set(incoming.domain, incoming);
    return true;
  }
  return false;
}

// =============================================================================
// TRANSPORT HELPERS
// =============================================================================

function safeSend(ws: WebSocket, msg: GossipMessage): void {
  try {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(msg));
    }
  } catch {
    // Peer went away mid-send; the close handler will clean it up.
  }
}

/** Send to every connected peer, optionally excluding one socket. */
function broadcast(msg: GossipMessage, except?: WebSocket): void {
  for (const ws of peerState.keys()) {
    if (ws === except) continue;
    safeSend(ws, msg);
  }
}

function activeEntries(): RouteEntry[] {
  return Array.from(routes.values());
}

// =============================================================================
// PUBLIC API — used by agentService (writes) and crossServerService (reads)
// =============================================================================

/** Record (or refresh) that `domain` is served by `serverId` and gossip it. */
export function register(entry: {
  domain: string;
  agentId: string;
  serverId: string;
  serverHost: string;
  serverPort: number;
}): void {
  const e: RouteEntry = { ...entry, active: true, ts: Date.now() };
  mergeEntry(e);
  broadcast({ t: "delta", entries: [e] });
}

/** Mark `domain` as gone (tombstone) and gossip the removal. */
export function unregister(domain: string): void {
  const cur = routes.get(domain);
  const e: RouteEntry = {
    domain,
    agentId: cur?.agentId ?? "",
    serverId: cur?.serverId ?? SERVER_ID,
    serverHost: cur?.serverHost ?? SERVER_HOST,
    serverPort: cur?.serverPort ?? SERVER_PORT,
    active: false,
    ts: Date.now(),
  };
  mergeEntry(e);
  broadcast({ t: "delta", entries: [e] });
}

/** Hot-path lookup: in-memory, zero network. Returns null if unknown/tombstoned. */
export function resolve(domain: string): RouteEntry | null {
  const e = routes.get(domain);
  return e && e.active ? e : null;
}

/**
 * Validate the shared secret presented on an inbound /_gossip connection.
 * If no GOSSIP_SECRET is configured we allow the connection (dev mode) but
 * initGossip() warns loudly that the mesh is unauthenticated.
 */
export function verifyToken(token: string | null): boolean {
  if (!SECRET) return true;
  return token === SECRET;
}

/**
 * Fallback for the propagation gap: ask all peers "who has this domain?".
 * Resolves with the first positive answer, or null after a short timeout.
 */
export function whoHas(domain: string, timeoutMs = WHOHAS_TIMEOUT_MS): Promise<RouteEntry | null> {
  const local = resolve(domain);
  if (local) return Promise.resolve(local);
  if (peerState.size === 0) return Promise.resolve(null);

  const rid = generateId();
  return new Promise((resolveP) => {
    const timeout = setTimeout(() => {
      whoHasWaiters.delete(rid);
      resolveP(null);
    }, timeoutMs);
    whoHasWaiters.set(rid, { resolve: resolveP, timeout });
    broadcast({ t: "whohas", domain, rid, from: SERVER_ID });
  });
}

export function getSnapshot(): {
  routes: number;
  activeRoutes: number;
  peers: number;
  peerIds: string[];
} {
  let active = 0;
  for (const e of routes.values()) if (e.active) active++;
  return {
    routes: routes.size,
    activeRoutes: active,
    peers: peerState.size,
    peerIds: Array.from(peerById.keys()),
  };
}

// =============================================================================
// PEER CONNECTION HANDLERS (shared by inbound & outbound sockets)
// =============================================================================

function attachPeer(ws: WebSocket, outbound: boolean, knownPeerId?: string): void {
  peerState.set(ws, { ws, outbound, peerId: knownPeerId });
  if (knownPeerId) peerById.set(knownPeerId, ws);
}

function detachPeer(ws: WebSocket): void {
  const st = peerState.get(ws);
  if (st?.peerId && peerById.get(st.peerId) === ws) {
    peerById.delete(st.peerId);
  }
  peerState.delete(ws);
}

function handleMessage(ws: WebSocket, raw: string | Buffer): void {
  let msg: GossipMessage;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return;
  }

  switch (msg.t) {
    case "hello": {
      const st = peerState.get(ws);
      if (st) {
        st.peerId = msg.id;
        st.host = msg.host;
        st.port = msg.port;
        peerById.set(msg.id, ws);
      }
      // Greet back + seed them with our full state.
      safeSend(ws, { t: "hello", id: SERVER_ID, host: SERVER_HOST, port: SERVER_PORT });
      safeSend(ws, { t: "sync", entries: activeEntries() });
      break;
    }

    case "delta": {
      const changed: RouteEntry[] = [];
      for (const e of msg.entries) {
        if (mergeEntry(e)) changed.push(e);
      }
      // Relay only what actually changed, to dampen storms (epidemic spread).
      if (changed.length) broadcast({ t: "delta", entries: changed }, ws);
      break;
    }

    case "sync": {
      for (const e of msg.entries) mergeEntry(e);
      break;
    }

    case "whohas": {
      const e = routes.get(msg.domain);
      const entry = e && e.active ? e : null;
      // Only answer if we actually know it (reduces noise; askers tolerate silence).
      if (entry) {
        const target = peerById.get(msg.from);
        const reply: GossipMessage = { t: "ihave", domain: msg.domain, rid: msg.rid, entry };
        if (target) safeSend(target, reply);
        else safeSend(ws, reply);
      }
      break;
    }

    case "ihave": {
      const waiter = whoHasWaiters.get(msg.rid);
      if (waiter) {
        if (msg.entry) mergeEntry(msg.entry);
        clearTimeout(waiter.timeout);
        whoHasWaiters.delete(msg.rid);
        waiter.resolve(msg.entry && msg.entry.active ? msg.entry : null);
      }
      break;
    }
  }
}

// ---- Inbound (peer dialed us; index.ts routes ws.data.type === 'gossip-peer') ----

export function onPeerOpen(ws: WebSocket): void {
  attachPeer(ws, /* outbound */ false);
  // We don't know their id until "hello"; we send ours so either side can start.
  safeSend(ws, { t: "hello", id: SERVER_ID, host: SERVER_HOST, port: SERVER_PORT });
}

export function onPeerMessage(ws: WebSocket, data: string | Buffer): void {
  handleMessage(ws, data);
}

export function onPeerClose(ws: WebSocket): void {
  detachPeer(ws);
}

// ---- Outbound (we dial peers discovered via heartbeats) ----

function dialPeer(peerId: string, host: string, port: number): void {
  const url = SECRET
    ? `ws://${host}:${port}/_gossip?token=${encodeURIComponent(SECRET)}`
    : `ws://${host}:${port}/_gossip`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error(`🕸️  gossip: failed to dial ${peerId} (${url}):`, err);
    return;
  }

  attachPeer(ws, /* outbound */ true, peerId);

  ws.onopen = () => {
    safeSend(ws, { t: "hello", id: SERVER_ID, host: SERVER_HOST, port: SERVER_PORT });
    safeSend(ws, { t: "sync", entries: activeEntries() });
    console.log(`🕸️  gossip: connected to peer ${peerId} (${host}:${port})`);
  };
  ws.onmessage = (ev: MessageEvent) => handleMessage(ws, ev.data as any);
  ws.onclose = () => {
    detachPeer(ws);
  };
  ws.onerror = () => {
    detachPeer(ws);
    try { ws.close(); } catch {}
  };
}

// =============================================================================
// BACKGROUND LOOPS
// =============================================================================

/** Discover peers from heartbeats, dial the ones we should, evict dead routes. */
async function discoveryTick(): Promise<void> {
  let servers: Awaited<ReturnType<typeof getHealthyServers>> = [];
  try {
    servers = await getHealthyServers();
  } catch (err) {
    return; // Mongo blip — keep serving from the in-memory map.
  }

  const healthyIds = new Set(servers.map((s) => s.serverId));

  for (const s of servers) {
    if (s.serverId === SERVER_ID) continue;
    // "Lower serverId dials" => exactly one connection per pair, no duplicates.
    if (SERVER_ID >= s.serverId) continue;
    if (peerById.has(s.serverId)) continue; // already connected
    dialPeer(s.serverId, s.serverHost, s.serverPort);
  }

  // Evict routes whose owning node is gone (absent from heartbeats) and stale
  // enough that a missing heartbeat can't just be propagation lag. Fresh routes
  // and our own routes are always spared (covers the new-node race).
  const now = Date.now();
  for (const [domain, e] of routes) {
    if (e.serverId === SERVER_ID) continue;
    if (healthyIds.has(e.serverId)) continue;
    if (now - e.ts > STALE_ROUTE_TTL_MS) routes.delete(domain);
  }
}

function antiEntropyTick(): void {
  if (peerState.size === 0) return;
  broadcast({ t: "sync", entries: activeEntries() });
}

function gcTick(): void {
  const now = Date.now();
  for (const [domain, e] of routes) {
    if (!e.active && now - e.ts > TOMBSTONE_TTL_MS) routes.delete(domain);
  }
}

// =============================================================================
// LIFECYCLE
// =============================================================================

export function initGossip(): void {
  if (started) return;
  started = true;

  discoveryTick().catch(() => {});
  discoveryTimer = setInterval(() => discoveryTick().catch(() => {}), DISCOVERY_INTERVAL_MS);
  antiEntropyTimer = setInterval(antiEntropyTick, ANTI_ENTROPY_INTERVAL_MS);
  gcTimer = setInterval(gcTick, TOMBSTONE_TTL_MS);

  if (!SECRET) {
    console.warn(
      "⚠️  GOSSIP_SECRET is not set — the /_gossip mesh is UNAUTHENTICATED. Any host that can reach this node's port can poison routing. Set GOSSIP_SECRET (same value on every node) in production."
    );
  }
  console.log(`🕸️  Gossip routing initialized (node: ${SERVER_ID})`);
}

export function shutdownGossip(): void {
  if (discoveryTimer) clearInterval(discoveryTimer);
  if (antiEntropyTimer) clearInterval(antiEntropyTimer);
  if (gcTimer) clearInterval(gcTimer);
  for (const ws of peerState.keys()) {
    try { ws.close(); } catch {}
  }
  peerState.clear();
  peerById.clear();
  started = false;
}
