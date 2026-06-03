/**
 * WebSocket Proxy Service
 * 
 * Manages WebSocket connections between clients and agents for WebSocket tunneling.
 * This allows clients to establish WebSocket connections to local services through kproxy tunnels.
 */

import type { Agent } from "../types/index";
import { generateId } from "../utils/helpers";

// Client WebSocket connection info
interface ClientWsConnection {
  wsId: string;
  clientWs: WebSocket;
  agentWs: WebSocket;
  agent: Agent;
  subdomain: string;
  path: string;
  createdAt: number;
}

// Store client WebSocket connections by wsId
const clientConnections = new Map<string, ClientWsConnection>();

// Store wsId by client WebSocket for reverse lookup
const wsToId = new Map<WebSocket, string>();

/**
 * Register a new client WebSocket connection
 */
export function registerClientWs(
  clientWs: WebSocket,
  agentWs: WebSocket,
  agent: Agent,
  subdomain: string,
  path: string
): string {
  const wsId = generateId();
  
  const connection: ClientWsConnection = {
    wsId,
    clientWs,
    agentWs,
    agent,
    subdomain,
    path,
    createdAt: Date.now(),
  };
  
  clientConnections.set(wsId, connection);
  wsToId.set(clientWs, wsId);
  
  console.log(`🔌 WebSocket registered: ${subdomain}${path} [${wsId}]`);
  
  return wsId;
}

/**
 * Unregister a client WebSocket connection
 */
export function unregisterClientWs(wsId: string): void {
  const connection = clientConnections.get(wsId);
  if (connection) {
    wsToId.delete(connection.clientWs);
    clientConnections.delete(wsId);
    console.log(`🔌 WebSocket unregistered: ${connection.subdomain}${connection.path} [${wsId}]`);
  }
}

/**
 * Get wsId from client WebSocket
 */
export function getWsIdBySocket(ws: WebSocket): string | undefined {
  return wsToId.get(ws);
}

/**
 * Get client connection by wsId
 */
export function getClientConnection(wsId: string): ClientWsConnection | undefined {
  return clientConnections.get(wsId);
}

/**
 * Get all connections for a specific agent
 */
export function getConnectionsByAgent(agentId: string): ClientWsConnection[] {
  const connections: ClientWsConnection[] = [];
  for (const conn of clientConnections.values()) {
    if (conn.agent.id === agentId) {
      connections.push(conn);
    }
  }
  return connections;
}

/**
 * Close all WebSocket connections for an agent (when agent disconnects)
 */
export function closeConnectionsByAgent(agentId: string): void {
  const connections = getConnectionsByAgent(agentId);
  for (const conn of connections) {
    try {
      conn.clientWs.close(1001, "Agent disconnected");
    } catch (e) {
      // Ignore close errors
    }
    unregisterClientWs(conn.wsId);
  }
  console.log(`🔌 Closed ${connections.length} client WebSocket(s) for agent ${agentId}`);
}

/**
 * Forward a message from agent to client
 */
export function forwardToClient(wsId: string, data: Buffer | string, isBinary: boolean): boolean {
  const connection = clientConnections.get(wsId);
  if (!connection) {
    console.warn(`⚠️ No client connection found for wsId: ${wsId}`);
    return false;
  }
  
  try {
    if (connection.clientWs.readyState === 1) { // WebSocket.OPEN
      // Ensure we send the correct data type
      if (isBinary && Buffer.isBuffer(data)) {
        // Send binary data as ArrayBuffer
        connection.clientWs.send(data);
      } else {
        // Send text data as string
        connection.clientWs.send(typeof data === 'string' ? data : data.toString());
      }
      return true;
    }
    return false;
  } catch (error) {
    console.error(`❌ Error forwarding to client [${wsId}]:`, error);
    return false;
  }
}

/**
 * Forward a message from client to agent
 */
export function forwardToAgent(wsId: string, data: Buffer | string, isBinary: boolean): boolean {
  const connection = clientConnections.get(wsId);
  if (!connection) {
    console.warn(`⚠️ No connection found for wsId: ${wsId}`);
    return false;
  }
  
  try {
    if (connection.agentWs.readyState === 1) { // WebSocket.OPEN
      // Encode data as base64 if binary
      const encodedData = isBinary && Buffer.isBuffer(data) 
        ? data.toString('base64') 
        : data.toString();
      
      connection.agentWs.send(JSON.stringify({
        type: "ws_message",
        wsId,
        data: encodedData,
        isBinary,
      }));
      return true;
    }
    return false;
  } catch (error) {
    console.error(`❌ Error forwarding to agent [${wsId}]:`, error);
    return false;
  }
}

/**
 * Notify agent about a new WebSocket connection
 */
export function notifyAgentConnect(wsId: string, path: string, headers: Record<string, string>): boolean {
  const connection = clientConnections.get(wsId);
  if (!connection) {
    return false;
  }
  
  try {
    if (connection.agentWs.readyState === 1) {
      connection.agentWs.send(JSON.stringify({
        type: "ws_connect",
        wsId,
        path,
        headers,
      }));
      return true;
    }
    return false;
  } catch (error) {
    console.error(`❌ Error notifying agent of connection [${wsId}]:`, error);
    return false;
  }
}

/**
 * Notify agent about WebSocket disconnection
 */
export function notifyAgentDisconnect(wsId: string, code: number, reason: string): boolean {
  const connection = clientConnections.get(wsId);
  if (!connection) {
    return false;
  }
  
  try {
    if (connection.agentWs.readyState === 1) {
      connection.agentWs.send(JSON.stringify({
        type: "ws_close",
        wsId,
        code,
        reason,
      }));
      return true;
    }
    return false;
  } catch (error) {
    console.error(`❌ Error notifying agent of disconnect [${wsId}]:`, error);
    return false;
  }
}

/**
 * Close a client connection (called when agent requests close)
 */
export function closeClientConnection(wsId: string, code: number, reason: string): void {
  const connection = clientConnections.get(wsId);
  if (!connection) {
    return;
  }
  
  try {
    connection.clientWs.close(code, reason);
  } catch (e) {
    // Ignore close errors
  }
  unregisterClientWs(wsId);
}

/**
 * Get stats about WebSocket connections
 */
export function getStats(): { totalConnections: number; connectionsBySubdomain: Record<string, number> } {
  const connectionsBySubdomain: Record<string, number> = {};
  
  for (const conn of clientConnections.values()) {
    connectionsBySubdomain[conn.subdomain] = (connectionsBySubdomain[conn.subdomain] || 0) + 1;
  }
  
  return {
    totalConnections: clientConnections.size,
    connectionsBySubdomain,
  };
}
