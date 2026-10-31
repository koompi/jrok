import type { Tunnel, TunnelConfig, CreateTunnelRequest, TunnelProtocol } from "../types/index";
import * as db from "../utils/database";
import * as agentService from "./agentService";
import * as vpsService from "./vpsService";
import * as activityService from "./activityService";
import * as tcpService from "./tcpService";
import { generateId } from "../utils/helpers";
import { setConfig as setNginxConfig } from "../utils/nginxConfig";
import { join } from "path";

let config: TunnelConfig;

export function setConfig(cfg: TunnelConfig): void {
  config = cfg;
  setNginxConfig(cfg);
}

// HTTP tunnels used to get an nginx server block each, written into
// NGINX_PATH (sites-available) with a reload of nginx, on every registration
// of a new domain. nginx.conf includes only sites-enabled, so those files never
// took effect (the base domain's wildcard server block serves every tunnel),
// and replicas registering together caused hundreds of reloads (plan 3.5).
// Files left from then are still removed with their tunnel.

async function removeNginxConfigFromVps(vpsId: string, domain: string): Promise<void> {
  const vps = await vpsService.getVpsServerById(vpsId);
  if (!vps) {
    throw new Error(`VPS server ${vpsId} not found`);
  }

  const configFileName = domain.replace(/\./g, "_") + ".conf";
  const configPath = join(vps.nginxPath, configFileName);

  try {
    const { unlink } = await import("fs/promises");
    await unlink(configPath);
    console.log(`✅ Nginx config removed: ${configPath}`);
  } catch (error) {
    console.warn(`Warning: Failed to remove nginx config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function createTunnel(request: CreateTunnelRequest, agentId: string, organizationId?: string): Promise<Tunnel> {
  // Verify agent is connected - use async version for MongoDB-based state
  const agent = await agentService.getAgentAsync(agentId);
  if (!agent || !agent.active) {
    throw new Error("Agent not connected");
  }

  // If custom domain is specified, verify it exists and is synced
  if (request.customDomain) {
    const customDomain = await db.getCustomDomainByName(request.customDomain);
    if (!customDomain) {
      throw new Error(`Custom domain "${request.customDomain}" not found`);
    }
    if (!customDomain.active) {
      throw new Error(`Custom domain "${request.customDomain}" is not active`);
    }
    if (!customDomain.synced) {
      throw new Error(`Custom domain "${request.customDomain}" is not fully synced to all VPS servers. Please try again in a moment.`);
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
      // For TCP tunnels, allocate a public port instead of creating nginx config
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
    } else {
      // For HTTP tunnels, remove nginx config from all VPS servers
      const vpsServers = await vpsService.getHealthyVpsServers();
      const errors: string[] = [];

      for (const vps of vpsServers) {
        try {
          await removeNginxConfigFromVps(vps.id, tunnel.domain);
        } catch (error) {
          errors.push(`${vps.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (errors.length > 0) {
        console.error("Errors removing tunnel from VPS servers:", errors);
      }
    }

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
