import type { Agent, AgentMessage, TunnelProtocol } from "../types/index";
import { generateId, generateShortSuffix } from "../utils/helpers";
import * as tunnelService from "./tunnelService";
import * as activityService from "./activityService";
import { getTunnelByDomain, invalidateTunnelCache } from "../utils/database";
import { getCollections } from "../utils/mongodb";

// =============================================================================
// DISTRIBUTED AGENT SERVICE
// =============================================================================
// Uses MongoDB for distributed state across multiple servers.
// Local WebSocket references are still stored in memory (unavoidable for sockets)
// but agent metadata is stored in MongoDB for cross-server visibility.
// =============================================================================

// Current server identity
const SERVER_ID = process.env.VPS_ID || process.env.HOSTNAME || `server-${generateId().substring(0, 8)}`;
const SERVER_HOST = process.env.VPS_HOST || "localhost";
const SERVER_PORT = parseInt(process.env.PORT || "3000");
const SERVER_REGION = process.env.VPS_REGION || "default";

// Local WebSocket references (in-memory, per-server)
// These MUST be local since WebSocket connections can't be shared
const localSockets = new Map<string, WebSocket>();

// Agent connection record stored in MongoDB
interface AgentConnection {
  agentId: string;
  domain: string;
  localPort: number;
  localHost: string;
  protocol: TunnelProtocol;
  serverId: string;
  serverHost: string;
  serverPort: number;
  serverRegion: string;
  organizationId?: string;
  apiKeyId?: string;
  clientIp?: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  active: boolean;
  tunnelId?: string;
}

export interface RegisterAgentOptions {
  socket: WebSocket;
  domain: string;
  localPort: number;
  localHost: string;
  clientIp?: string;
  organizationId?: string;
  apiKeyId?: string;
  protocol?: TunnelProtocol;
  forceNew?: boolean;
}

export interface RegisterAgentResult {
  agent: Agent;
  finalDomain: string;
  wasModified: boolean;
}

// =============================================================================
// DOMAIN AVAILABILITY CHECK
// =============================================================================

async function checkDomainAvailability(
  domain: string, 
  organizationId?: string,
  forceNew?: boolean
): Promise<{ available: boolean; ownedByOrg?: string }> {
  const collections = getCollections();
  
  // Check for active agent connection on any server
  const existingConnection = await collections.agentConnections.findOne({ 
    domain, 
    active: true 
  });
  
  if (existingConnection) {
    // Domain has an active agent
    if (forceNew) {
      return { available: false, ownedByOrg: existingConnection.organizationId };
    }
    
    // Same org can reuse
    if (organizationId && existingConnection.organizationId === organizationId) {
      // Check if it's on this server (can take over) or different server
      if (existingConnection.serverId === SERVER_ID) {
        return { available: true };
      }
      // Different server owns it - need to wait for disconnect or use --force-new
      return { available: false, ownedByOrg: existingConnection.organizationId };
    }
    
    return { available: false, ownedByOrg: existingConnection.organizationId };
  }
  
  // Check tunnel ownership (for inactive tunnels)
  const existingTunnel = await getTunnelByDomain(domain);
  if (existingTunnel) {
    if (forceNew) {
      return { available: false, ownedByOrg: existingTunnel.organizationId };
    }
    if (organizationId && existingTunnel.organizationId === organizationId) {
      return { available: true };
    }
    return { available: false, ownedByOrg: existingTunnel.organizationId };
  }
  
  return { available: true };
}

async function generateUniqueDomain(baseDomain: string): Promise<string> {
  const collections = getCollections();
  
  for (let i = 0; i < 10; i++) {
    const suffix = generateShortSuffix();
    const newDomain = `${baseDomain}-${suffix}`;
    
    // Check both agent connections and tunnels
    const [existingConn, existingTunnel] = await Promise.all([
      collections.agentConnections.findOne({ domain: newDomain }),
      getTunnelByDomain(newDomain),
    ]);
    
    if (!existingConn && !existingTunnel) {
      return newDomain;
    }
  }
  
  return `${baseDomain}-${Date.now().toString(36)}`;
}

// =============================================================================
// AGENT REGISTRATION (MongoDB + Local Socket)
// =============================================================================

export async function registerAgent(options: RegisterAgentOptions): Promise<RegisterAgentResult> {
  const {
    socket,
    domain: requestedDomain,
    localPort,
    localHost,
    clientIp,
    organizationId,
    apiKeyId,
    protocol = 'http',
    forceNew = false,
  } = options;

  const collections = getCollections();
  
  // Check domain availability
  const availability = await checkDomainAvailability(requestedDomain, organizationId, forceNew);
  
  let finalDomain = requestedDomain;
  let wasModified = false;
  
  if (!availability.available) {
    finalDomain = await generateUniqueDomain(requestedDomain);
    wasModified = true;
    console.log(`📛 Domain "${requestedDomain}" taken, using "${finalDomain}" instead`);
  }

  const agentId = generateId();
  const now = new Date();

  // Create agent connection record in MongoDB (distributed state)
  const connectionRecord: AgentConnection = {
    agentId,
    domain: finalDomain,
    localPort,
    localHost,
    protocol,
    serverId: SERVER_ID,
    serverHost: SERVER_HOST,
    serverPort: SERVER_PORT,
    serverRegion: SERVER_REGION,
    organizationId,
    apiKeyId,
    clientIp,
    connectedAt: now,
    lastHeartbeat: now,
    active: true,
  };

  // Use upsert to handle reconnections to same domain
  await collections.agentConnections.updateOne(
    { domain: finalDomain },
    { $set: connectionRecord },
    { upsert: true }
  );

  // Store local WebSocket reference
  localSockets.set(agentId, socket);

  // Create Agent object for return value
  const agent: Agent = {
    id: agentId,
    domain: finalDomain,
    localPort,
    localHost,
    connectedAt: now.getTime(),
    lastHeartbeat: now.getTime(),
    active: true,
    clientIp,
    organizationId,
    apiKeyId,
    protocol,
    serverId: SERVER_ID,
    serverHost: SERVER_HOST,
  };

  // Create or update tunnel
  createTunnelForAgent(agent, agentId, organizationId).catch((error) => {
    console.error(`Failed to create tunnel for agent ${agentId}:`, error);
  });

  // Log activity
  if (organizationId) {
    activityService.logAgentConnected(organizationId, agentId, finalDomain, clientIp).catch((err) => {
      console.error("Failed to log agent connected activity:", err);
    });
  }

  console.log(`✅ Agent registered: ${finalDomain} on server ${SERVER_ID}`);
  return { agent, finalDomain, wasModified };
}

// =============================================================================
// TUNNEL CREATION
// =============================================================================

async function createTunnelForAgent(agent: Agent, agentId: string, organizationId?: string): Promise<void> {
  try {
    const collections = getCollections();
    const existingTunnel = await getTunnelByDomain(agent.domain);
    
    if (existingTunnel) {
      agent.tunnelId = existingTunnel.id;
      
      await collections.tunnels.updateOne(
        { domain: agent.domain },
        { $set: {
          agentId,
          localPort: agent.localPort,
          localHost: agent.localHost,
          active: true,
          updatedAt: Date.now(),
          serverId: SERVER_ID,
          serverHost: SERVER_HOST,
        }}
      );
      
      // Update agent connection with tunnel ID
      await collections.agentConnections.updateOne(
        { agentId },
        { $set: { tunnelId: existingTunnel.id } }
      );
      
      invalidateTunnelCache(agent.domain);
      console.log(`✅ Tunnel updated: ${agent.domain} (server: ${SERVER_ID})`);
    } else {
      const newTunnel = await tunnelService.createTunnel(
        {
          domain: agent.domain,
          serviceType: "port",
          localPort: agent.localPort,
          localHost: agent.localHost,
          protocol: agent.protocol || 'http',
        },
        agentId,
        organizationId
      );
      
      if (newTunnel?.id) {
        agent.tunnelId = newTunnel.id;
        await collections.agentConnections.updateOne(
          { agentId },
          { $set: { tunnelId: newTunnel.id } }
        );
      }
      
      invalidateTunnelCache(agent.domain);
      console.log(`✅ Tunnel created: ${agent.domain} (protocol: ${agent.protocol || 'http'})`);
    }
  } catch (error) {
    console.error(`Failed to create tunnel for ${agent.domain}:`, error instanceof Error ? error.message : String(error));
  }
}

// =============================================================================
// AGENT UNREGISTRATION
// =============================================================================

export async function unregisterAgent(id: string): Promise<void> {
  const collections = getCollections();
  
  // Get agent connection from MongoDB
  const connection = await collections.agentConnections.findOne({ agentId: id });
  
  if (connection) {
    // Remove from MongoDB
    await collections.agentConnections.deleteOne({ agentId: id });
    
    // Mark tunnel as inactive
    try {
      await collections.tunnels.updateOne(
        { domain: connection.domain },
        { $set: { active: false, updatedAt: Date.now() } }
      );
      invalidateTunnelCache(connection.domain);
    } catch (error) {
      console.error(`Failed to mark tunnel inactive for ${connection.domain}:`, error);
    }

    // Log activity
    if (connection.organizationId) {
      activityService.logAgentDisconnected(
        connection.organizationId, 
        id, 
        connection.domain, 
        connection.clientIp
      ).catch((err) => {
        console.error("Failed to log agent disconnected activity:", err);
      });
    }
    
    console.log(`🔌 Agent unregistered: ${connection.domain}`);
  }
  
  // Remove local socket reference
  localSockets.delete(id);
}

// =============================================================================
// AGENT LOOKUP (Local + MongoDB)
// =============================================================================

/**
 * Get agent by ID - checks MongoDB
 */
export async function getAgentAsync(id: string): Promise<Agent | null> {
  const collections = getCollections();
  const connection = await collections.agentConnections.findOne({ agentId: id, active: true });
  
  if (!connection) return null;
  
  return connectionToAgent(connection);
}

/**
 * Synchronous get agent - only returns if agent is on THIS server
 * For backward compatibility with sync code paths
 */
export function getAgent(id: string): Agent | null {
  // Check if socket exists locally - if not, agent is not on this server
  if (!localSockets.has(id)) return null;
  
  // Return a minimal agent for local socket
  // Note: This is sync and can't query MongoDB, so it's limited
  return null;
}

/**
 * Get agent by domain from MongoDB
 */
export async function getAgentByDomainAsync(domain: string): Promise<Agent | null> {
  const collections = getCollections();
  const connection = await collections.agentConnections.findOne({ domain, active: true });
  
  if (!connection) return null;
  
  return connectionToAgent(connection);
}

/**
 * Get agent by domain - backward compatible sync version
 * Returns null - use async version instead
 */
export function getAgentByDomain(domain: string): Agent | null {
  return null;
}

/**
 * Get all agents across all servers
 */
export async function getAllAgentsAsync(): Promise<Agent[]> {
  const collections = getCollections();
  const connections = await collections.agentConnections.find({ active: true }).toArray();
  return connections.map(connectionToAgent);
}

/**
 * Get all local agents (on this server only)
 */
export async function getLocalAgentsAsync(): Promise<Agent[]> {
  const collections = getCollections();
  const connections = await collections.agentConnections.find({ 
    serverId: SERVER_ID, 
    active: true 
  }).toArray();
  return connections.map(connectionToAgent);
}

/**
 * Get all local agents - sync backward compat
 */
export function getAllAgents(): Agent[] {
  return [];
}

/**
 * Get local socket for agent (only if on this server)
 */
export function getAgentSocket(id: string): WebSocket | null {
  return localSockets.get(id) || null;
}

/**
 * Check if agent is on this server
 */
export function isLocalAgent(id: string): boolean {
  return localSockets.has(id);
}

/**
 * Get agent info including which server owns it
 */
export async function getAgentServerInfo(domain: string): Promise<{
  agentId: string;
  serverId: string;
  serverHost: string;
  serverPort: number;
  isLocal: boolean;
} | null> {
  const collections = getCollections();
  const connection = await collections.agentConnections.findOne({ domain, active: true });
  
  if (!connection) return null;
  
  return {
    agentId: connection.agentId,
    serverId: connection.serverId,
    serverHost: connection.serverHost,
    serverPort: connection.serverPort,
    isLocal: connection.serverId === SERVER_ID,
  };
}

// =============================================================================
// HEARTBEAT & HEALTH
// =============================================================================

export async function updateHeartbeat(id: string): Promise<void> {
  const collections = getCollections();
  await collections.agentConnections.updateOne(
    { agentId: id },
    { $set: { lastHeartbeat: new Date() } }
  );
}

export async function isAgentConnected(id: string): Promise<boolean> {
  const collections = getCollections();
  const connection = await collections.agentConnections.findOne({ 
    agentId: id, 
    active: true 
  });
  return !!connection;
}

/**
 * Clean up stale agent connections (run periodically)
 */
export async function cleanupStaleAgents(maxAgeMs: number = 120000): Promise<number> {
  const collections = getCollections();
  const cutoff = new Date(Date.now() - maxAgeMs);
  
  // Find and remove stale connections ON THIS SERVER ONLY
  const staleConnections = await collections.agentConnections.find({
    serverId: SERVER_ID,
    lastHeartbeat: { $lt: cutoff },
  }).toArray();
  
  for (const conn of staleConnections) {
    await unregisterAgent(conn.agentId);
  }
  
  return staleConnections.length;
}

/**
 * Disconnect stale agents - backward compat wrapper
 */
export function disconnectStaleAgents(maxAge: number = 30000): void {
  cleanupStaleAgents(maxAge).catch(err => {
    console.error("Failed to cleanup stale agents:", err);
  });
}

// =============================================================================
// MESSAGING
// =============================================================================

export function sendToAgent(id: string, message: AgentMessage): boolean {
  const socket = localSockets.get(id);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/**
 * Get agent ID by socket reference (for local socket handling)
 */
export function getAgentIdBySocket(socket: WebSocket): string | null {
  for (const [id, sock] of localSockets.entries()) {
    if (sock === socket) {
      return id;
    }
  }
  return null;
}

// =============================================================================
// SERVER HEARTBEAT
// =============================================================================

/**
 * Send server heartbeat to MongoDB (run every 10 seconds)
 */
export async function sendServerHeartbeat(): Promise<void> {
  const collections = getCollections();
  
  const localAgentCount = localSockets.size;
  
  await collections.serverHeartbeats.updateOne(
    { serverId: SERVER_ID },
    { 
      $set: {
        serverId: SERVER_ID,
        serverHost: SERVER_HOST,
        serverPort: SERVER_PORT,
        serverRegion: SERVER_REGION,
        lastHeartbeat: new Date(),
        agentCount: localAgentCount,
        healthy: true,
      }
    },
    { upsert: true }
  );
}

/**
 * Get all healthy servers
 */
export async function getHealthyServers(): Promise<Array<{
  serverId: string;
  serverHost: string;
  serverPort: number;
  serverRegion: string;
  agentCount: number;
  lastHeartbeat: Date;
}>> {
  const collections = getCollections();
  const cutoff = new Date(Date.now() - 30000); // 30 second threshold
  
  const servers = await collections.serverHeartbeats.find({
    lastHeartbeat: { $gt: cutoff },
    healthy: true,
  }).toArray();
  
  return servers.map(s => ({
    serverId: s.serverId,
    serverHost: s.serverHost,
    serverPort: s.serverPort,
    serverRegion: s.serverRegion,
    agentCount: s.agentCount,
    lastHeartbeat: s.lastHeartbeat,
  }));
}

// =============================================================================
// HELPERS
// =============================================================================

function connectionToAgent(conn: any): Agent {
  return {
    id: conn.agentId,
    domain: conn.domain,
    localPort: conn.localPort,
    localHost: conn.localHost,
    connectedAt: conn.connectedAt instanceof Date ? conn.connectedAt.getTime() : conn.connectedAt,
    lastHeartbeat: conn.lastHeartbeat instanceof Date ? conn.lastHeartbeat.getTime() : conn.lastHeartbeat,
    active: conn.active,
    clientIp: conn.clientIp,
    organizationId: conn.organizationId,
    apiKeyId: conn.apiKeyId,
    tunnelId: conn.tunnelId,
    protocol: conn.protocol,
    serverId: conn.serverId,
    serverHost: conn.serverHost,
  };
}

// Export server identity
export const currentServerId = SERVER_ID;
export const currentServerHost = SERVER_HOST;
export const currentServerPort = SERVER_PORT;
