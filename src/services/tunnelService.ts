import type { Tunnel, TunnelConfig, CreateTunnelRequest, TunnelProtocol } from "../types/index";
import * as db from "../utils/database";
import * as agentService from "./agentService";
import * as activityService from "./activityService";
import * as tcpService from "./tcpService";
import { generateId } from "../utils/helpers";

// =============================================================================
// TUNNELS
// =============================================================================
// HTTP routing no longer writes per-tunnel nginx vhosts. Requests arrive via
// Cloudflare → kproxy and are routed to the owning agent through the in-memory
// gossip routing table (see gossipService / crossServerService). Tunnels are
// pure database records; TCP tunnels still allocate a public port.
// =============================================================================

let config: TunnelConfig;

export function setConfig(cfg: TunnelConfig): void {
  config = cfg;
}

export async function createTunnel(request: CreateTunnelRequest, agentId: string, organizationId?: string): Promise<Tunnel> {
  // Verify agent is connected - use async version for MongoDB-based state
  const agent = await agentService.getAgentAsync(agentId);
  if (!agent || !agent.active) {
    throw new Error("Agent not connected");
  }

  // If custom domain is specified, verify it exists and its Cloudflare cert is active
  if (request.customDomain) {
    const customDomain = await db.getCustomDomainByName(request.customDomain);
    if (!customDomain) {
      throw new Error(`Custom domain "${request.customDomain}" not found`);
    }
    if (!customDomain.active) {
      throw new Error(`Custom domain "${request.customDomain}" is not active (Cloudflare certificate not issued yet)`);
    }
  }

  const protocol: TunnelProtocol = request.protocol || 'http';

  // Get current server identity for multi-server tracking
  const serverId = process.env.VPS_ID || process.env.HOSTNAME || "default";
  const serverHost = process.env.VPS_HOST || "localhost";

  const tunnel: Tunnel = {
    id: generateId(),
    domain: request.domain,
    agentId,
    customDomain: request.customDomain,
    organizationId, // Track which org created this tunnel
    localPort: request.localPort,
    localHost: request.localHost,
    createdAt: Date.now(),
    expiresAt: request.expiresIn ? Date.now() + request.expiresIn * 1000 : undefined,
    active: true,
    protocol,
    // Multi-server: track which server owns this connection
    serverId,
    serverHost,
  };

  try {
    if (protocol === 'tcp') {
      // For TCP tunnels, allocate a public port
      const allocation = await tcpService.allocatePort(
        tunnel.id,
        agentId,
        agent.localPort,
        agent.localHost,
        organizationId
      );

      if (!allocation) {
        throw new Error("Failed to allocate TCP port - no available ports");
      }

      tunnel.tcpPort = allocation.port;

      // Start the TCP server for this tunnel
      tcpService.startTcpServer(allocation);

      console.log(`✅ TCP tunnel created: ${tunnel.domain} -> port ${tunnel.tcpPort} -> ${agent.localHost}:${agent.localPort}`);
    }
    // HTTP tunnels need no per-node config — routing is handled in-process via
    // the gossip routing table once the agent registers.

    // Save to database
    await db.createTunnel(tunnel);

    // Log activity for tunnel creation
    if (organizationId) {
      activityService.logTunnelCreated(organizationId, undefined, tunnel.id, tunnel.domain).catch((err) => {
        console.error("Failed to log tunnel created activity:", err);
      });
    }

    return tunnel;
  } catch (error) {
    console.error("Failed to create tunnel:", error);
    throw error;
  }
}

export async function getTunnel(id: string): Promise<Tunnel | null> {
  return await db.getTunnel(id);
}

export async function listTunnels(): Promise<Tunnel[]> {
  return await db.getAllTunnels();
}

export async function listTunnelsByOrganization(organizationId: string): Promise<Tunnel[]> {
  const allTunnels = await db.getAllTunnels();
  return allTunnels.filter(t => t.organizationId === organizationId);
}

export async function deleteTunnel(id: string): Promise<void> {
  const tunnel = await db.getTunnel(id);
  if (!tunnel) {
    throw new Error("Tunnel not found");
  }

  try {
    if (tunnel.protocol === 'tcp') {
      // For TCP tunnels, deallocate the port
      tcpService.deallocatePortByTunnelId(id);
      console.log(`✅ TCP tunnel deleted: ${tunnel.domain} (port ${tunnel.tcpPort})`);
    }
    // HTTP tunnels: nothing to tear down at the node level.

    // Remove from database
    await db.deleteTunnel(id);
  } catch (error) {
    console.error("Failed to delete tunnel:", error);
    throw error;
  }
}

export async function cleanupExpiredTunnels(): Promise<void> {
  const now = Date.now();
  const tunnels = await db.getAllTunnels();

  for (const tunnel of tunnels) {
    if (tunnel.expiresAt && tunnel.expiresAt < now && tunnel.active) {
      await deleteTunnel(tunnel.id);
    }
  }
}
