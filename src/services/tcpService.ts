/**
 * TCP Tunnel Service
 * 
 * Manages TCP port allocation and raw TCP connections for tunneling
 * protocols like SSH, MongoDB, Redis, MySQL, etc.
 */

import type { TcpPortAllocation, Agent } from "../types/index";
import { generateId } from "../utils/helpers";
import * as net from "net";
import * as securityService from "./securityService";

// TCP Port Configuration
const TCP_PORT_MIN = parseInt(process.env.TCP_PORT_MIN || "10000");
const TCP_PORT_MAX = parseInt(process.env.TCP_PORT_MAX || "20000");

// Store TCP port allocations (in-memory for fast lookup)
const portAllocations = new Map<number, TcpPortAllocation>();
const tunnelToPort = new Map<string, number>(); // tunnelId -> port
const agentToPort = new Map<string, number>(); // agentId -> port

// Store active TCP servers
const tcpServers = new Map<number, net.Server>();

// Store agent WebSocket connections for TCP forwarding
const agentConnections = new Map<string, WebSocket>();

/**
 * Register agent WebSocket for TCP forwarding
 */
export function registerAgentConnection(agentId: string, ws: WebSocket): void {
  agentConnections.set(agentId, ws);
}

/**
 * Unregister agent WebSocket
 */
export function unregisterAgentConnection(agentId: string): void {
  agentConnections.delete(agentId);
  
  // Clean up any TCP allocations for this agent
  const port = agentToPort.get(agentId);
  if (port) {
    deallocatePort(port);
  }
}

/**
 * Get agent WebSocket connection
 */
export function getAgentConnection(agentId: string): WebSocket | undefined {
  return agentConnections.get(agentId);
}

/**
 * Find an available port in the configured range
 */
function findAvailablePort(): number | null {
  for (let port = TCP_PORT_MIN; port <= TCP_PORT_MAX; port++) {
    if (!portAllocations.has(port)) {
      return port;
    }
  }
  return null;
}

/**
 * Check if a port is actually available on the system
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
 * Allocate a TCP port for a tunnel
 */
export async function allocatePort(
  tunnelId: string,
  agentId: string,
  localPort: number,
  localHost: string,
  organizationId?: string
): Promise<TcpPortAllocation | null> {
  // Check if tunnel already has a port
  const existingPort = tunnelToPort.get(tunnelId);
  if (existingPort) {
    return portAllocations.get(existingPort) || null;
  }

  // Find an available port
  let port = findAvailablePort();
  if (!port) {
    console.error("❌ No available TCP ports in range");
    return null;
  }

  // Verify port is actually available on the system
  let attempts = 0;
  while (!(await isPortAvailable(port)) && attempts < 100) {
    port = findAvailablePort();
    if (!port) return null;
    attempts++;
  }

  if (attempts >= 100) {
    console.error("❌ Could not find available TCP port after 100 attempts");
    return null;
  }

  const allocation: TcpPortAllocation = {
    id: generateId(),
    port,
    tunnelId,
    agentId,
    organizationId,
    localPort,
    localHost,
    createdAt: Date.now(),
    active: true,
  };

  // Store allocation
  portAllocations.set(port, allocation);
  tunnelToPort.set(tunnelId, port);
  agentToPort.set(agentId, port);

  console.log(`✅ TCP port ${port} allocated for tunnel ${tunnelId} (agent: ${agentId})`);

  return allocation;
}

/**
 * Deallocate a TCP port
 */
export function deallocatePort(port: number): void {
  const allocation = portAllocations.get(port);
  if (!allocation) return;

  // Stop the TCP server if running
  const server = tcpServers.get(port);
  if (server) {
    server.close();
    tcpServers.delete(port);
  }

  // Remove from maps
  portAllocations.delete(port);
  tunnelToPort.delete(allocation.tunnelId);
  agentToPort.delete(allocation.agentId);

  console.log(`🗑️ TCP port ${port} deallocated`);
}

/**
 * Deallocate port by tunnel ID
 */
export function deallocatePortByTunnelId(tunnelId: string): void {
  const port = tunnelToPort.get(tunnelId);
  if (port) {
    deallocatePort(port);
  }
}

/**
 * Get port allocation by tunnel ID
 */
export function getPortAllocation(tunnelId: string): TcpPortAllocation | null {
  const port = tunnelToPort.get(tunnelId);
  if (!port) return null;
  return portAllocations.get(port) || null;
}

/**
 * Get port allocation by port number
 */
export function getPortAllocationByPort(port: number): TcpPortAllocation | null {
  return portAllocations.get(port) || null;
}

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

    // Security check: verify connection is allowed
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

    // Track connection for limits
    securityService.trackTcpConnection(allocation.tunnelId, allocation.organizationId, true);

    const agentWs = agentConnections.get(allocation.agentId);
    if (!agentWs || agentWs.readyState !== 1) {
      console.error(`❌ Agent ${allocation.agentId} not connected for TCP tunnel`);
      securityService.trackTcpConnection(allocation.tunnelId, allocation.organizationId, false);
      clientSocket.end();
      return;
    }

    // Buffer for incoming data while waiting for agent connection
    let dataBuffer: Buffer[] = [];
    let isAgentConnected = false;
    let totalBytesIn = 0;
    let totalBytesOut = 0;

    // Notify agent about new TCP connection
    agentWs.send(JSON.stringify({
      type: "tcp_connect",
      connectionId,
      localPort: allocation.localPort,
      localHost: allocation.localHost,
      remoteAddress: clientSocket.remoteAddress,
      remotePort: clientSocket.remotePort,
    }));

    // Handle data from client
    clientSocket.on('data', (data: Buffer) => {
      // Track incoming bytes
      totalBytesIn += data.length;
      securityService.trackTcpBandwidth(allocation.tunnelId, allocation.organizationId, data.length);

      // Check bandwidth limits
      const bandwidthCheck = securityService.checkTcpBandwidth(allocation.tunnelId, data.length, planTier);
      if (!bandwidthCheck.allowed) {
        console.log(`🚫 TCP bandwidth limit exceeded [${connectionId}]: ${bandwidthCheck.reason}`);
        clientSocket.end();
        return;
      }

      if (!isAgentConnected) {
        dataBuffer.push(data);
        return;
      }

      const agentWs = agentConnections.get(allocation.agentId);
      if (agentWs && agentWs.readyState === 1) {
        agentWs.send(JSON.stringify({
          type: "tcp_data",
          connectionId,
          data: data.toString('base64'),
        }));
      } else {
        clientSocket.end();
      }
    });

    // Handle client disconnect
    clientSocket.on('close', () => {
      console.log(`🔌 TCP connection [${connectionId}] closed (in: ${totalBytesIn}, out: ${totalBytesOut})`);
      
      // Track connection close
      securityService.trackTcpConnection(allocation.tunnelId, allocation.organizationId, false);
      
      const agentWs = agentConnections.get(allocation.agentId);
      if (agentWs && agentWs.readyState === 1) {
        agentWs.send(JSON.stringify({
          type: "tcp_close",
          connectionId,
        }));
      }
      // Clean up connection
      tcpConnections.delete(connectionId);
    });

    clientSocket.on('error', (error) => {
      console.error(`❌ TCP connection [${connectionId}] error:`, error);
      const agentWs = agentConnections.get(allocation.agentId);
      if (agentWs && agentWs.readyState === 1) {
        agentWs.send(JSON.stringify({
          type: "tcp_error",
          connectionId,
          error: error.message,
        }));
      }
    });

    // Store the connection
    tcpConnections.set(connectionId, {
      socket: clientSocket,
      allocation,
      onAgentConnected: () => {
        isAgentConnected = true;
        // Flush buffered data
        for (const data of dataBuffer) {
          const agentWs = agentConnections.get(allocation.agentId);
          if (agentWs && agentWs.readyState === 1) {
            agentWs.send(JSON.stringify({
              type: "tcp_data",
              connectionId,
              data: data.toString('base64'),
            }));
          }
        }
        dataBuffer = [];
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

// Store active TCP connections (connectionId -> socket)
interface TcpConnection {
  socket: net.Socket;
  allocation: TcpPortAllocation;
  onAgentConnected: () => void;
}
const tcpConnections = new Map<string, TcpConnection>();

/**
 * Handle TCP data from agent (forward to client)
 */
export function handleAgentTcpData(connectionId: string, data: string): void {
  const conn = tcpConnections.get(connectionId);
  if (!conn) {
    console.warn(`⚠️ No TCP connection found for [${connectionId}]`);
    return;
  }

  try {
    const buffer = Buffer.from(data, 'base64');
    conn.socket.write(buffer);
  } catch (error) {
    console.error(`❌ Failed to write TCP data [${connectionId}]:`, error);
  }
}

/**
 * Handle TCP connection ready from agent
 */
export function handleAgentTcpConnected(connectionId: string): void {
  const conn = tcpConnections.get(connectionId);
  if (!conn) {
    console.warn(`⚠️ No TCP connection found for [${connectionId}]`);
    return;
  }
  conn.onAgentConnected();
}

/**
 * Handle TCP close from agent
 */
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

/**
 * Handle TCP error from agent
 */
export function handleAgentTcpError(connectionId: string, error: string): void {
  console.error(`❌ Agent TCP error [${connectionId}]: ${error}`);
  handleAgentTcpClose(connectionId);
}

/**
 * Get all port allocations
 */
export function getAllPortAllocations(): TcpPortAllocation[] {
  return Array.from(portAllocations.values());
}

/**
 * Get TCP stats
 */
export function getTcpStats(): {
  allocatedPorts: number;
  activeServers: number;
  activeConnections: number;
  portRange: { min: number; max: number };
} {
  return {
    allocatedPorts: portAllocations.size,
    activeServers: tcpServers.size,
    activeConnections: tcpConnections.size,
    portRange: { min: TCP_PORT_MIN, max: TCP_PORT_MAX },
  };
}

/**
 * Cleanup inactive allocations (called periodically)
 */
export function cleanupInactiveAllocations(): void {
  const entries = Array.from(portAllocations.entries());
  for (const [port, allocation] of entries) {
    const agentWs = agentConnections.get(allocation.agentId);
    if (!agentWs || agentWs.readyState !== 1) {
      console.log(`🧹 Cleaning up TCP allocation for disconnected agent: port ${port}`);
      deallocatePort(port);
    }
  }
}
