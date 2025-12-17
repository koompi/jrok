import type { Agent, AgentMessage } from "../types/index";
import { generateId } from "../utils/helpers";
import * as tunnelService from "./tunnelService";
import * as activityService from "./activityService";
import { getTunnelByDomain, invalidateTunnelCache } from "../utils/database";
import { getCollections } from "../utils/mongodb";

// Store active agent connections
const agents = new Map<string, { agent: Agent; socket: WebSocket }>();
const agentsByDomain = new Map<string, string>(); // domain -> agentId

export function registerAgent(
  socket: WebSocket,
  domain: string,
  localPort: number,
  localHost: string,
  clientIp?: string,
  organizationId?: string,
  apiKeyId?: string
): Agent {
  const id = generateId();
  const agent: Agent = {
    id,
    domain,
    localPort,
    localHost,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    active: true,
    clientIp,
    organizationId,
    apiKeyId,
  };

  agents.set(id, { agent, socket });
  agentsByDomain.set(domain, id);

  // Automatically create tunnel for the agent
  createTunnelForAgent(agent, id, organizationId).catch((error) => {
    console.error(`Failed to create tunnel for agent ${id}:`, error);
  });

  // Log activity for agent connection
  if (organizationId) {
    activityService.logAgentConnected(organizationId, id, domain, clientIp).catch((err) => {
      console.error("Failed to log agent connected activity:", err);
    });
  }

  return agent;
}

async function createTunnelForAgent(agent: Agent, agentId: string, organizationId?: string): Promise<void> {
  try {
    // Check if tunnel already exists for this domain (uses cached lookup)
    const existingTunnel = await getTunnelByDomain(agent.domain);
    
    if (existingTunnel) {
      // Cache the tunnel ID on the agent for fast lookup
      agent.tunnelId = existingTunnel.id;
      
      // Tunnel already exists, just update it with new agent info
      const collections = getCollections();
      await collections.tunnels.updateOne(
        { domain: agent.domain },
        { $set: {
          agentId,
          localPort: agent.localPort,
          localHost: agent.localHost,
          active: true,
          updatedAt: Date.now(),
        }}
      );
      // Invalidate cache after update
      invalidateTunnelCache(agent.domain);
      console.log(`✅ Tunnel updated for domain: ${agent.domain}`);
    } else {
      // Create new tunnel
      const newTunnel = await tunnelService.createTunnel(
        {
          domain: agent.domain,
          serviceType: "port",
          localPort: agent.localPort,
          localHost: agent.localHost,
        },
        agentId,
        organizationId
      );
      
      // Cache the new tunnel ID on the agent
      if (newTunnel?.id) {
        agent.tunnelId = newTunnel.id;
      }
      
      // Invalidate cache after creation
      invalidateTunnelCache(agent.domain);
      console.log(`✅ Tunnel created automatically for domain: ${agent.domain}`);
    }
  } catch (error) {
    console.error(`Failed to auto-create tunnel for ${agent.domain}:`, error instanceof Error ? error.message : String(error));
  }
}

export async function unregisterAgent(id: string): Promise<void> {
  const entry = agents.get(id);
  if (entry) {
    const { agent } = entry;
    agentsByDomain.delete(agent.domain);
    agents.delete(id);

    // Mark the tunnel as inactive
    try {
      const collections = getCollections();
      await collections.tunnels.updateOne(
        { domain: agent.domain },
        { $set: { active: false, updatedAt: Date.now() } }
      );
      // Invalidate cache when agent disconnects
      invalidateTunnelCache(agent.domain);
    } catch (error) {
      console.error(`Failed to mark tunnel inactive for ${agent.domain}:`, error);
    }

    // Log activity for agent disconnection
    if (agent.organizationId) {
      activityService.logAgentDisconnected(agent.organizationId, id, agent.domain, agent.clientIp).catch((err) => {
        console.error("Failed to log agent disconnected activity:", err);
      });
    }
  }
}

export function getAgent(id: string): Agent | null {
  return agents.get(id)?.agent || null;
}

export function getAgentByDomain(domain: string): Agent | null {
  const id = agentsByDomain.get(domain);
  return id ? agents.get(id)?.agent || null : null;
}

export function getAllAgents(): Agent[] {
  return Array.from(agents.values()).map((e) => e.agent);
}

export function getAgentSocket(id: string): WebSocket | null {
  return agents.get(id)?.socket || null;
}

export function getAgentIdBySocket(socket: WebSocket): string | null {
  for (const [id, entry] of agents.entries()) {
    if (entry.socket === socket) {
      return id;
    }
  }
  return null;
}

export function updateHeartbeat(id: string): void {
  const entry = agents.get(id);
  if (entry) {
    entry.agent.lastHeartbeat = Date.now();
  }
}

export function isAgentConnected(id: string): boolean {
  const agent = getAgent(id);
  return agent ? agent.active : false;
}

export function disconnectStaleAgents(maxAge: number = 30000): void {
  const now = Date.now();
  const staleIds: string[] = [];

  agents.forEach((entry, id) => {
    if (now - entry.agent.lastHeartbeat > maxAge) {
      entry.agent.active = false;
      staleIds.push(id);
    }
  });

  staleIds.forEach((id) => unregisterAgent(id));
}

export function sendToAgent(id: string, message: AgentMessage): boolean {
  const socket = getAgentSocket(id);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}
