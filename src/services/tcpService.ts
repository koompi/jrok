/**
 * DISTRIBUTED TCP Tunnel Service
 * 
 * Manages TCP port allocation using MongoDB for distributed state.
 * Each server manages its own port range to prevent conflicts.
 * Port allocations are stored in MongoDB for cross-server visibility.
 */

import type { TcpPortAllocation, Agent } from "../types/index";
import { generateId } from "../utils/helpers";
import { getCollections } from "../utils/mongodb";
import * as net from "net";
import * as securityService from "./securityService";

// =============================================================================
// CONFIGURATION
// =============================================================================

// Server identity
const SERVER_ID = process.env.VPS_ID || process.env.HOSTNAME || "default";

// TCP Port Configuration - each server should have unique range
const TCP_PORT_MIN = parseInt(process.env.TCP_PORT_MIN || "10000");
const TCP_PORT_MAX = parseInt(process.env.TCP_PORT_MAX || "20000");

// =============================================================================
// FLOW CONTROL
// =============================================================================
// A TCP tunnel bridges two links with independent speeds. Without flow control
// the faster side's data piles up in this process's heap until the box runs out
// of memory — and because this is a shared multi-tenant server, one customer
// with a slow client could take down every other customer's tunnel.
//
// Note this is memory pressure, not throughput: a single large transfer to one
// slow reader is enough. Volume of tunnels is not what triggers it.

// Public client -> agent. When the agent's WebSocket has this much queued, we
// pause reading from the public socket; the kernel then shrinks its receive
// window and the remote sender slows down on its own. Resumed on drain.
const WS_HIGH_WATER_MARK = 8 * 1024 * 1024; // 8MB
const WS_DRAIN_POLL_MS = 20;

// Agent -> public client. socket.write() returns false once Node is buffering,
// but the agent has no flow-control message to obey, so we cap how much may
// accumulate. A connection past this cap is genuinely pathological (a reader
// that has effectively stopped) and is dropped rather than allowed to consume
// the server's heap.
const CLIENT_WRITE_LIMIT = 16 * 1024 * 1024; // 16MB

// Bytes may arrive before the agent confirms the connection. That window is
// short, so this bound is generous — but it must exist, or a client that
// blasts data at a tunnel whose agent never answers grows the heap unchecked.
const PRECONNECT_BUFFER_LIMIT = 4 * 1024 * 1024; // 4MB

// =============================================================================
// LOCAL STATE (must be per-server for socket management)
// =============================================================================

// Active TCP servers on THIS server
const tcpServers = new Map<number, net.Server>();

// Active TCP connections on THIS server
interface TcpConnection {
  socket: net.Socket;
  allocation: TcpPortAllocation;
  onAgentConnected: () => void;
}
const tcpConnections = new Map<string, TcpConnection>();

// Agent WebSocket connections (local to this server)
const agentConnections = new Map<string, WebSocket>();

// =============================================================================
// AGENT CONNECTION MANAGEMENT
// =============================================================================

export function registerAgentConnection(agentId: string, ws: WebSocket): void {
  agentConnections.set(agentId, ws);
}

export async function unregisterAgentConnection(agentId: string): Promise<void> {
  agentConnections.delete(agentId);
  
  // Don't deallocate TCP ports on disconnect - keep them for reconnection
  // Just stop the local TCP server but keep the allocation in DB
  await stopTcpServersForAgent(agentId);
}

/**
 * Stop TCP servers for an agent without deallocating the port
 * This allows the same port to be reused on reconnection
 */
async function stopTcpServersForAgent(agentId: string): Promise<void> {
  const collections = getCollections();
  
  const allocations = await collections.tcpPortAllocations.find({
    agentId,
    serverId: SERVER_ID,
    active: true,
  }).toArray();
  
  for (const allocation of allocations) {
    // Stop local TCP server but DON'T remove from MongoDB
    const server = tcpServers.get(allocation.port);
    if (server) {
      server.close();
      tcpServers.delete(allocation.port);
      console.log(`⏸️ TCP server stopped for port ${allocation.port} (allocation preserved for reconnection)`);
    }
  }
}

export function getAgentConnection(agentId: string): WebSocket | undefined {
  return agentConnections.get(agentId);
}

// =============================================================================
// DISTRIBUTED PORT ALLOCATION (MongoDB)
// =============================================================================

/**
 * Find an available port in this server's range
 * Uses MongoDB to check for conflicts across all servers
 */
async function findAvailablePort(): Promise<number | null> {
  const collections = getCollections();
  
  // Get all allocated ports for this server
  const allocatedPorts = await collections.tcpPortAllocations.find({
    serverId: SERVER_ID,
    active: true,
  }).project({ port: 1 }).toArray();
  
  const usedPorts = new Set(allocatedPorts.map(a => a.port));
  
  // Find first available port in our range
  for (let port = TCP_PORT_MIN; port <= TCP_PORT_MAX; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  
  return null;
}

/**
 * Check if a port is available on the system
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '0.0.0.0');
  });
}

/**
 * Allocate a TCP port for a tunnel (distributed via MongoDB)
 * Supports persistent allocation - if the tunnel already has a port, it will be reused
 */
export async function allocatePort(
  tunnelId: string,
  agentId: string,
  localPort: number,
  localHost: string,
  organizationId?: string
): Promise<TcpPortAllocation | null> {
  const collections = getCollections();
  
  // Check if tunnel already has a port allocated (active or inactive)
  // This enables persistent port allocation across reconnections
  const existingAllocation = await collections.tcpPortAllocations.findOne({
    tunnelId,
  });
  
  if (existingAllocation) {
    // If it's on this server, reactivate and return it
    if (existingAllocation.serverId === SERVER_ID) {
      // Update with new agent info and mark as active
      await collections.tcpPortAllocations.updateOne(
        { tunnelId },
        { 
          $set: { 
            agentId, 
            localPort, 
            localHost, 
            active: true,
            updatedAt: new Date()
          } 
        }
      );
      console.log(`♻️ Reusing persistent TCP port ${existingAllocation.port} for tunnel ${tunnelId}`);
      return {
        ...existingAllocation,
        agentId,
        localPort,
        localHost,
        active: true,
      } as TcpPortAllocation;
    }
    // If on another server, we need to deallocate there first or return error
    console.warn(`⚠️ Tunnel ${tunnelId} already has port ${existingAllocation.port} on server ${existingAllocation.serverId}`);
    return null;
  }

  // Find and validate available port
  let port = await findAvailablePort();
  if (!port) {
    console.error(`❌ No available TCP ports in range ${TCP_PORT_MIN}-${TCP_PORT_MAX}`);
    return null;
  }

  // Verify port is actually available on system
  let attempts = 0;
  while (!(await isPortAvailable(port)) && attempts < 100) {
    // Mark this port as temporarily unavailable and try next
    const nextPort = await findAvailablePort();
    if (!nextPort || nextPort === port) {
      attempts++;
      continue;
    }
    port = nextPort;
    attempts++;
  }

  if (attempts >= 100) {
    console.error("❌ Could not find available TCP port after 100 attempts");
    return null;
  }

  const allocation: TcpPortAllocation & { serverId: string; serverHost: string } = {
    id: generateId(),
    port,
    tunnelId,
    agentId,
    organizationId,
    localPort,
    localHost,
    createdAt: Date.now(),
    active: true,
    serverId: SERVER_ID,
    serverHost: process.env.VPS_HOST || "localhost",
  };

  // Atomic insert with duplicate key handling
  try {
    await collections.tcpPortAllocations.insertOne(allocation);
    console.log(`✅ TCP port ${port} allocated for tunnel ${tunnelId} on server ${SERVER_ID}`);
    return allocation;
  } catch (error: any) {
    if (error.code === 11000) {
      // Duplicate key - port was taken by another request
      console.warn(`⚠️ Port ${port} was taken by concurrent request, retrying...`);
      return allocatePort(tunnelId, agentId, localPort, localHost, organizationId);
    }
    throw error;
  }
}

/**
 * Deallocate a TCP port (distributed)
 */
export async function deallocatePort(port: number): Promise<void> {
  const collections = getCollections();
  
  // Stop local TCP server if running
  const server = tcpServers.get(port);
  if (server) {
    server.close();
    tcpServers.delete(port);
  }

  // Remove from MongoDB
  await collections.tcpPortAllocations.deleteOne({
    port,
    serverId: SERVER_ID,
  });

  console.log(`🗑️ TCP port ${port} deallocated`);
}

/**
 * Deallocate port by tunnel ID (permanent deletion)
 * Use this when a tunnel is being deleted, not just disconnected
 */
export async function deallocatePortByTunnelId(tunnelId: string): Promise<void> {
  const collections = getCollections();
  
  // Look for any allocation (active or inactive) for this tunnel
  const allocation = await collections.tcpPortAllocations.findOne({
    tunnelId,
    serverId: SERVER_ID,
  });
  
  if (allocation) {
    await deallocatePort(allocation.port);
    console.log(`🗑️ Permanently deallocated TCP port ${allocation.port} for tunnel ${tunnelId}`);
  }
}

/**
 * Deallocate port by agent ID
 */
export async function deallocatePortByAgentId(agentId: string): Promise<void> {
  const collections = getCollections();
  
  const allocations = await collections.tcpPortAllocations.find({
    agentId,
    serverId: SERVER_ID,
    active: true,
  }).toArray();
  
  for (const allocation of allocations) {
    await deallocatePort(allocation.port);
  }
}

/**
 * Get port allocation by tunnel ID
 */
export async function getPortAllocation(tunnelId: string): Promise<TcpPortAllocation | null> {
  const collections = getCollections();
  const allocation = await collections.tcpPortAllocations.findOne({
    tunnelId,
    active: true,
  });
  return allocation as TcpPortAllocation | null;
}

/**
 * Update port allocation with new agent info (for reconnections)
 */
export async function updatePortAllocation(
  tunnelId: string,
  agentId: string,
  localPort: number,
  localHost: string
): Promise<void> {
  const collections = getCollections();
  await collections.tcpPortAllocations.updateOne(
    { tunnelId, active: true },
    { $set: { agentId, localPort, localHost, updatedAt: new Date() } }
  );
}

/**
 * Get port allocation by port number
 */
export async function getPortAllocationByPort(port: number): Promise<TcpPortAllocation | null> {
  const collections = getCollections();
  const allocation = await collections.tcpPortAllocations.findOne({
    port,
    serverId: SERVER_ID,
    active: true,
  });
  return allocation as TcpPortAllocation | null;
}

/**
 * Get all port allocations for this server
 */
export async function getAllPortAllocations(): Promise<TcpPortAllocation[]> {
  const collections = getCollections();
  const allocations = await collections.tcpPortAllocations.find({
    serverId: SERVER_ID,
    active: true,
  }).toArray();
  return allocations as TcpPortAllocation[];
}

/**
 * Get all port allocations across all servers
 */
export async function getAllPortAllocationsGlobal(): Promise<(TcpPortAllocation & { serverId: string })[]> {
  const collections = getCollections();
  const allocations = await collections.tcpPortAllocations.find({
    active: true,
  }).toArray();
  return allocations as (TcpPortAllocation & { serverId: string })[];
}

// =============================================================================
// TCP SERVER MANAGEMENT
// =============================================================================

/**
 * Start TCP server for a port allocation
 */
export function startTcpServer(allocation: TcpPortAllocation, planTier?: string): boolean {
  if (tcpServers.has(allocation.port)) {
    console.warn(`⚠️ TCP server already running on port ${allocation.port}`);
    return true;
  }

  const server = net.createServer(async (clientSocket) => {
    const connectionId = generateId();
    const remoteIp = clientSocket.remoteAddress || 'unknown';
    console.log(`🔌 TCP connection [${connectionId}] on port ${allocation.port} from ${remoteIp}`);

    // Security check
    const securityCheck = await securityService.checkTcpConnection(
      allocation.tunnelId,
      allocation.organizationId,
      remoteIp,
      planTier
    );

    if (!securityCheck.allowed) {
      console.log(`🚫 TCP connection blocked [${connectionId}]: ${securityCheck.reason}`);
      clientSocket.end();
      return;
    }

    // Track connection
    securityService.trackTcpConnection(allocation.tunnelId, allocation.organizationId, true);

    // Enable TCP keepalive so idle connections (SSH, Mongo Compass) are not silently
    // dropped by NAT/firewalls. 60s probe interval is well within typical 2-5 min timeouts.
    clientSocket.setKeepAlive(true, 60000);

    const agentWs = agentConnections.get(allocation.agentId);
    if (!agentWs || agentWs.readyState !== 1) {
      console.error(`❌ Agent ${allocation.agentId} not connected for TCP tunnel`);
      securityService.trackTcpConnection(allocation.tunnelId, allocation.organizationId, false);
      clientSocket.end();
      return;
    }

    let dataBuffer: Buffer[] = [];
    let isAgentConnected = false;
    let totalBytesIn = 0;
    let totalBytesOut = 0;

    // Notify agent
    agentWs.send(JSON.stringify({
      type: "tcp_connect",
      connectionId,
      localPort: allocation.localPort,
      localHost: allocation.localHost,
      remoteAddress: clientSocket.remoteAddress,
      remotePort: clientSocket.remotePort,
    }));

    // Tracks how many bytes are sitting in dataBuffer, so the pre-connect
    // window is bounded without walking the array on every packet.
    let bufferedBytes = 0;
    let paused = false;

    // Pause reading from the public socket while the agent's WebSocket is
    // backed up. The kernel shrinks the receive window and the remote sender
    // throttles itself — real backpressure, rather than us buffering for it.
    const resumeWhenDrained = () => {
      const ws = agentConnections.get(allocation.agentId);
      if (!ws || ws.readyState !== 1) {
        // Agent went away while we were paused; nothing left to drain into.
        clientSocket.destroy();
        return;
      }
      if (ws.bufferedAmount < WS_HIGH_WATER_MARK) {
        paused = false;
        clientSocket.resume();
        return;
      }
      setTimeout(resumeWhenDrained, WS_DRAIN_POLL_MS);
    };

    clientSocket.on('data', (data: Buffer) => {
      totalBytesIn += data.length;
      securityService.trackTcpBandwidth(allocation.tunnelId, allocation.organizationId, data.length);

      const bandwidthCheck = securityService.checkTcpBandwidth(allocation.tunnelId, data.length, planTier);
      if (!bandwidthCheck.allowed) {
        console.log(`🚫 TCP bandwidth limit exceeded [${connectionId}]: ${bandwidthCheck.reason}`);
        clientSocket.end();
        return;
      }

      if (!isAgentConnected) {
        // Bounded: a client that floods a tunnel whose agent never confirms
        // must not be able to grow this process's heap without limit.
        if (bufferedBytes + data.length > PRECONNECT_BUFFER_LIMIT) {
          console.warn(
            `🚫 TCP [${connectionId}] exceeded ${PRECONNECT_BUFFER_LIMIT} bytes buffered before the agent connected — dropping connection`
          );
          dataBuffer = [];
          bufferedBytes = 0;
          clientSocket.destroy();
          return;
        }
        dataBuffer.push(data);
        bufferedBytes += data.length;
        return;
      }

      const ws = agentConnections.get(allocation.agentId);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: "tcp_data",
          connectionId,
          data: data.toString('base64'),
        }));

        if (!paused && ws.bufferedAmount >= WS_HIGH_WATER_MARK) {
          paused = true;
          clientSocket.pause();
          setTimeout(resumeWhenDrained, WS_DRAIN_POLL_MS);
        }
      } else {
        clientSocket.end();
      }
    });

    clientSocket.on('close', () => {
      console.log(`🔌 TCP connection [${connectionId}] closed (in: ${totalBytesIn}, out: ${totalBytesOut})`);
      securityService.trackTcpConnection(allocation.tunnelId, allocation.organizationId, false);
      
      const ws = agentConnections.get(allocation.agentId);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "tcp_close", connectionId }));
      }
      tcpConnections.delete(connectionId);
    });

    clientSocket.on('error', (error) => {
      console.error(`❌ TCP connection [${connectionId}] error:`, error);
      const ws = agentConnections.get(allocation.agentId);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "tcp_error", connectionId, error: error.message }));
      }
    });

    tcpConnections.set(connectionId, {
      socket: clientSocket,
      allocation,
      onAgentConnected: () => {
        isAgentConnected = true;
        for (const data of dataBuffer) {
          const ws = agentConnections.get(allocation.agentId);
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "tcp_data", connectionId, data: data.toString('base64') }));
          }
        }
        dataBuffer = [];
        bufferedBytes = 0;
      },
    });
  });

  server.on('error', (error) => {
    console.error(`❌ TCP server error on port ${allocation.port}:`, error);
  });

  server.listen(allocation.port, '0.0.0.0', () => {
    console.log(`🚀 TCP server started on port ${allocation.port} for ${allocation.localHost}:${allocation.localPort}`);
  });

  tcpServers.set(allocation.port, server);
  return true;
}

/**
 * Stop TCP server for a port
 */
export function stopTcpServer(port: number): void {
  const server = tcpServers.get(port);
  if (server) {
    server.close();
    tcpServers.delete(port);
    console.log(`🛑 TCP server stopped on port ${port}`);
  }
}

/**
 * Restart TCP server with new allocation (for agent reconnections)
 */
export function restartTcpServer(allocation: TcpPortAllocation, planTier?: string): boolean {
  // Stop existing server if running
  stopTcpServer(allocation.port);
  // Start new server with updated allocation (includes new agentId)
  return startTcpServer(allocation, planTier);
}

// =============================================================================
// TCP MESSAGE HANDLERS
// =============================================================================

export function handleAgentTcpData(connectionId: string, data: string): void {
  const conn = tcpConnections.get(connectionId);
  if (!conn) {
    console.warn(`⚠️ No TCP connection found for [${connectionId}]`);
    return;
  }

  try {
    const buffer = Buffer.from(data, 'base64');
    conn.socket.write(buffer);

    // The agent has no flow-control message to obey, so we can't ask it to slow
    // down. What we can do is refuse to hoard bytes on its behalf: once Node is
    // buffering more than the cap for a client that has effectively stopped
    // reading, drop that one connection instead of letting it consume the heap
    // shared by every other tenant on this server.
    if (conn.socket.writableLength > CLIENT_WRITE_LIMIT) {
      console.warn(
        `🚫 TCP [${connectionId}] client is not draining (${conn.socket.writableLength} bytes queued > ${CLIENT_WRITE_LIMIT}) — dropping connection`
      );
      conn.socket.destroy();
      tcpConnections.delete(connectionId);

      const ws = agentConnections.get(conn.allocation.agentId);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "tcp_close", connectionId }));
      }
    }
  } catch (error) {
    console.error(`❌ Failed to write TCP data [${connectionId}]:`, error);
  }
}

export function handleAgentTcpConnected(connectionId: string): void {
  const conn = tcpConnections.get(connectionId);
  if (!conn) {
    console.warn(`⚠️ No TCP connection found for [${connectionId}]`);
    return;
  }
  conn.onAgentConnected();
}

export function handleAgentTcpClose(connectionId: string): void {
  const conn = tcpConnections.get(connectionId);
  if (!conn) return;

  try {
    conn.socket.end();
  } catch (e) {
    // Ignore
  }
  tcpConnections.delete(connectionId);
}

export function handleAgentTcpError(connectionId: string, error: string): void {
  console.error(`❌ Agent TCP error [${connectionId}]: ${error}`);
  handleAgentTcpClose(connectionId);
}

// =============================================================================
// STATS & CLEANUP
// =============================================================================

/**
 * Get TCP stats for this server
 */
export function getTcpStats(): {
  allocatedPorts: number;
  activeServers: number;
  activeConnections: number;
  portRange: { min: number; max: number };
  serverId: string;
} {
  return {
    allocatedPorts: tcpServers.size,
    activeServers: tcpServers.size,
    activeConnections: tcpConnections.size,
    portRange: { min: TCP_PORT_MIN, max: TCP_PORT_MAX },
    serverId: SERVER_ID,
  };
}

/**
 * Get global TCP stats across all servers
 */
export async function getTcpStatsGlobal(): Promise<{
  totalAllocatedPorts: number;
  serverStats: Array<{ serverId: string; allocatedPorts: number }>;
}> {
  const collections = getCollections();
  
  const pipeline = [
    { $match: { active: true } },
    { $group: { _id: "$serverId", allocatedPorts: { $sum: 1 } } },
  ];
  
  const results = await collections.tcpPortAllocations.aggregate(pipeline).toArray();
  
  return {
    totalAllocatedPorts: results.reduce((sum, r) => sum + r.allocatedPorts, 0),
    serverStats: results.map(r => ({
      serverId: r._id,
      allocatedPorts: r.allocatedPorts,
    })),
  };
}

/**
 * Cleanup orphaned allocations - only those where the tunnel has been deleted
 * This is called periodically but preserves allocations for disconnected agents
 */
export async function cleanupOrphanedAllocations(): Promise<void> {
  const collections = getCollections();
  
  // Get all allocations for this server
  const allocations = await collections.tcpPortAllocations.find({
    serverId: SERVER_ID,
  }).toArray();
  
  for (const allocation of allocations) {
    // Check if the tunnel still exists
    const tunnel = await collections.tunnels.findOne({ id: allocation.tunnelId });
    if (!tunnel) {
      console.log(`🧹 Cleaning up orphaned TCP allocation (tunnel deleted): port ${allocation.port}`);
      await deallocatePort(allocation.port);
    }
  }
}

/**
 * Cleanup inactive allocations that are older than a threshold
 * Used to reclaim ports from tunnels that haven't reconnected in a long time
 */
export async function cleanupStaleAllocations(maxAgeDays: number = 7): Promise<void> {
  const collections = getCollections();
  
  const staleThreshold = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  
  // Find allocations that are inactive and older than threshold
  const staleAllocations = await collections.tcpPortAllocations.find({
    serverId: SERVER_ID,
    active: false,
    createdAt: { $lt: staleThreshold },
  }).toArray();
  
  for (const allocation of staleAllocations) {
    console.log(`🧹 Cleaning up stale TCP allocation (${maxAgeDays}+ days inactive): port ${allocation.port}`);
    await deallocatePort(allocation.port);
  }
}

/**
 * Restore TCP servers on startup (from MongoDB state)
 * Allocations are preserved but TCP servers need to be restarted when agents reconnect
 */
export async function restoreTcpServersOnStartup(): Promise<void> {
  const collections = getCollections();
  
  // Count allocations for this server (they'll be reactivated when agents reconnect)
  const count = await collections.tcpPortAllocations.countDocuments({ serverId: SERVER_ID });
  
  console.log(`🔄 Found ${count} TCP port allocations for server ${SERVER_ID} - will reactivate on agent reconnection`);
}

/**
 * Cleanup all TCP ports for this server (used during shutdown)
 */
export async function cleanupServerPorts(): Promise<void> {
  const collections = getCollections();
  
  // Close all TCP servers
  for (const [port, server] of tcpServers.entries()) {
    try {
      server.close();
      console.log(`🔌 Closed TCP server on port ${port}`);
    } catch (error) {
      console.error(`Failed to close TCP server on port ${port}:`, error);
    }
  }
  tcpServers.clear();
  
  // Close all TCP connections
  for (const [connectionId, connection] of tcpConnections.entries()) {
    try {
      connection.socket.destroy();
    } catch (error) {
      console.error(`Failed to close TCP connection ${connectionId}:`, error);
    }
  }
  tcpConnections.clear();
  
  // Mark all allocations for this server as inactive
  await collections.tcpPortAllocations.updateMany(
    { serverId: SERVER_ID },
    { $set: { active: false } }
  );
  
  console.log(`🧹 Cleaned up all TCP resources for server ${SERVER_ID}`);
}

// Export server identity
export const currentServerId = SERVER_ID;
