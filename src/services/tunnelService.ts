import type { Tunnel, TunnelConfig, CreateTunnelRequest } from "../types/index";
import * as db from "../utils/database";
import * as agentService from "./agentService";
import * as vpsService from "./vpsService";
import * as activityService from "./activityService";
import { generateId } from "../utils/helpers";
import { generateNginxConfig, setConfig as setNginxConfig } from "../utils/nginxConfig";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

let config: TunnelConfig;

export function setConfig(cfg: TunnelConfig): void {
  config = cfg;
  setNginxConfig(cfg);
}

async function uploadNginxConfigToVps(
  vpsId: string,
  domain: string,
  localPort: number,
  localHost: string,
  customDomain?: string
): Promise<void> {
  const vps = await vpsService.getVpsServerById(vpsId);
  if (!vps) {
    throw new Error(`VPS server ${vpsId} not found`);
  }

  const nginxConfig = generateNginxConfig(domain, localPort, localHost, true, customDomain);
  const configFileName = `${domain}${customDomain ? "_" + customDomain.replace(/\./g, "_") : "_" + config.baseDomain.replace(/\./g, "_")}.conf`;
  const configPath = join(vps.nginxPath, configFileName);

  try {
    // Write directly to filesystem (app runs on VPS, no SSH needed)
    await mkdir(vps.nginxPath, { recursive: true });
    await writeFile(configPath, nginxConfig);
    console.log(`✅ Nginx config written: ${configPath}`);
  } catch (error) {
    throw new Error(`Failed to write nginx config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function reloadNginxOnVps(vpsId: string): Promise<void> {
  const vps = await vpsService.getVpsServerById(vpsId);
  if (!vps) {
    throw new Error(`VPS server ${vpsId} not found`);
  }

  try {
    // Test nginx config first
    const testProcess = Bun.spawn(["bash", "-c", "nginx -t"]);
    const testResult = await testProcess.exited;
    
    if (testResult !== 0) {
      throw new Error("Nginx config test failed");
    }

    // Reload nginx (app runs directly on VPS)
    const reloadProcess = Bun.spawn(["bash", "-c", "systemctl reload nginx"]);
    const reloadResult = await reloadProcess.exited;
    
    if (reloadResult === 0) {
      console.log(`✅ Nginx reloaded`);
      return;
    }
    
    // Fallback to nginx -s reload
    const fallbackProcess = Bun.spawn(["bash", "-c", "nginx -s reload"]);
    const fallbackResult = await fallbackProcess.exited;
    
    if (fallbackResult === 0) {
      console.log(`✅ Nginx reloaded (fallback)`);
      return;
    }
    
    console.warn(`⚠️  Could not reload Nginx - verify manually`);
  } catch (error) {
    console.warn(`⚠️  Nginx reload warning: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
    
    // Reload nginx after removal
    await reloadNginxOnVps(vpsId);
  } catch (error) {
    console.warn(`Warning: Failed to remove nginx config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sync nginx config to all healthy VPS servers
 * CRITICAL: Must sync to ALL servers for consistency
 */
async function syncConfigToAllVps(domain: string, localPort: number, localHost: string, customDomain?: string): Promise<void> {
  const vpsServers = await vpsService.getHealthyVpsServers();

  // Fallback: if no VPS servers registered, try using environment or config
  if (vpsServers.length === 0) {
    console.warn("⚠️  No VPS servers registered in database, skipping Nginx config sync");
    console.warn("    Tunnel will be created in database but Nginx config won't be applied");
    console.warn("    To fix: Register VPS servers via /domains/register-vps endpoint");
    return;
  }

  const errors: string[] = [];
  const successCount = { count: 0 };

  for (const vps of vpsServers) {
    try {
      await uploadNginxConfigToVps(vps.id, domain, localPort, localHost, customDomain);
      await reloadNginxOnVps(vps.id);
      successCount.count++;
    } catch (error) {
      errors.push(`${vps.name}: ${error instanceof Error ? error.message : String(error)}`);
      // Mark VPS as unhealthy on failure
      await vpsService.updateVpsServerHealth(vps.id, false);
    }
  }

  if (errors.length > 0) {
    console.error("Errors syncing to VPS servers:", errors);
    // Require at least one success
    if (successCount.count === 0) {
      throw new Error(`Failed to sync config to all VPS servers: ${errors.join("; ")}`);
    }
    // Warn if not all synced
    console.warn(`⚠️  Config synced to ${successCount.count}/${vpsServers.length} servers`);
  }
}

export async function createTunnel(request: CreateTunnelRequest, agentId: string, organizationId?: string): Promise<Tunnel> {
  // Verify agent is connected
  const agent = agentService.getAgent(agentId);
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
  };

  try {
    // Sync nginx config to all healthy VPS servers (non-blocking)
    try {
      await syncConfigToAllVps(tunnel.domain, agent.localPort, agent.localHost, request.customDomain);
    } catch (syncError) {
      console.warn("⚠️  Nginx config sync failed, but continuing with tunnel creation:", syncError instanceof Error ? syncError.message : String(syncError));
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
    // Remove nginx config from all VPS servers
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
