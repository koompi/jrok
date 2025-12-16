import type { CustomDomain, RegisterCustomDomainRequest } from "../types/index";
import * as db from "../utils/database";
import * as vpsService from "./vpsService";
import * as backupUtils from "../utils/backupUtils";
import * as notificationService from "./notificationService";
import * as certSyncService from "./certificateSyncService";
import { generateId } from "../utils/helpers";

/**
 * Register a custom domain and automatically issue wildcard certificate
 * Syncs certificate across all healthy VPS servers
 */
export async function registerCustomDomain(
  request: RegisterCustomDomainRequest
): Promise<CustomDomain> {
  // Check if domain already exists
  const existing = await db.getCustomDomainByName(request.domain);
  if (existing) {
    throw new Error(`Domain ${request.domain} is already registered`);
  }

  const domain: CustomDomain = {
    id: generateId(),
    domain: request.domain,
    baseDomain: false,
    certbotEmail: request.certbotEmail,
    cloudflareToken: request.cloudflareToken,
    createdAt: Date.now(),
    active: false, // Will be true once cert is issued
    synced: false,
  };

  try {
    // Save domain to database (before issuing cert)
    await db.createCustomDomain(domain);

    // Issue wildcard certificate for this domain
    const certPath = await issueCertificate(request.domain, request.certbotEmail, request.cloudflareToken);

    // Attempt to become leader and upload certificate to MongoDB
    const serverId = process.env.SERVER_ID || process.env.HOSTNAME || "control-1";
    const isLeader = await certSyncService.attemptBecomeLeader(serverId);
    
    if (isLeader) {
      // Read certificate files and upload to MongoDB
      const certPem = await Bun.file(`${certPath}/cert.pem`).text();
      const chainPem = await Bun.file(`${certPath}/chain.pem`).text();
      const fullchainPem = await Bun.file(`${certPath}/fullchain.pem`).text();
      const privkeyPem = await Bun.file(`${certPath}/privkey.pem`).text();
      
      // Base64 encode certificates for storage
      const certB64 = Buffer.from(certPem).toString('base64');
      const chainB64 = Buffer.from(chainPem).toString('base64');
      const fullchainB64 = Buffer.from(fullchainPem).toString('base64');
      const privkeyB64 = Buffer.from(privkeyPem).toString('base64');
      
      await certSyncService.uploadCertificateToMongoDB(
        request.domain,
        certB64,
        chainB64,
        fullchainB64,
        privkeyB64,
        serverId
      );
    } else {
      console.warn(`⚠️  Not leader, skipping certificate upload to MongoDB`);
    }

    // Update domain as active and synced
    const expiry = Date.now() + 90 * 24 * 60 * 60 * 1000; // 90 days
    await db.updateCustomDomainByName(request.domain, {
      active: true,
      synced: true,
      certPath,
      certExpiry: expiry,
      lastSyncedAt: Date.now(),
    });

    const updatedDomain = await db.getCustomDomainByName(request.domain) as CustomDomain;

    // Send Telegram notification
    await notificationService.notifyCertIssued(request.domain, expiry);

    return updatedDomain;
  } catch (error) {
    // Clean up if something fails
    await db.deleteCustomDomain(domain.id);
    throw error;
  }
}

/**
 * Issue wildcard certificate using Certbot + Cloudflare DNS
 */
async function issueCertificate(
  domain: string,
  email: string,
  cloudflareToken?: string
): Promise<string> {
  const certPath = `/etc/letsencrypt/live/${domain}`;

  let command: string;

  if (cloudflareToken) {
    // Use Cloudflare DNS for validation
    command = `
      mkdir -p /etc/letsencrypt/secrets/
      echo "dns_cloudflare_api_token = ${cloudflareToken}" > /etc/letsencrypt/secrets/cloudflare_${domain}.ini
      chmod 600 /etc/letsencrypt/secrets/cloudflare_${domain}.ini
      
      certbot certonly \
        --dns-cloudflare \
        --dns-cloudflare-credentials /etc/letsencrypt/secrets/cloudflare_${domain}.ini \
        --email ${email} \
        --agree-tos \
        --non-interactive \
        -d ${domain} \
        -d '*.${domain}'
    `.trim();
  } else {
    // Fallback: Use HTTP challenge (requires domain to resolve to VPS)
    command = `
      certbot certonly \
        --standalone \
        --email ${email} \
        --agree-tos \
        --non-interactive \
        -d ${domain} \
        -d '*.${domain}'
    `.trim();
  }

  try {
    const process = Bun.spawn(["bash", "-c", command]);
    const exitCode = await process.exited;

    if (exitCode !== 0) {
      throw new Error(`Certbot failed with exit code ${exitCode}`);
    }

    console.log(`✅ Certificate issued for ${domain}`);
    return certPath;
  } catch (error) {
    console.error(`Failed to issue certificate for ${domain}:`, error);
    throw error;
  }
}

/**
 * MongoDB-based certificate sync (replaces SCP)
 * VPS servers pull certificates independently every 6 hours
 * No direct server-to-server connections needed
 */
async function triggerCertificateSyncOnVps(): Promise<void> {
  // VPS servers independently pull from MongoDB via HTTP API
  // No push mechanism needed - they're responsible for pulling
  console.log(`📤 Certificate sync triggered via MongoDB notification queue`);
  
  // Optionally send Telegram notification that sync is available
  await notificationService.notifyCertSyncAvailable();
}

/**
 * Get custom domain details
 */
export async function getCustomDomain(domainName: string): Promise<CustomDomain | null> {
  return await db.getCustomDomainByName(domainName);
}

/**
 * List all custom domains
 */
export async function listCustomDomains(): Promise<CustomDomain[]> {
  return await db.getAllCustomDomains();
}

/**
 * Resync certificate via MongoDB (VPS servers will pull on schedule)
 */
export async function resyncCertificate(domainName: string): Promise<void> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain || !domain.certPath) {
    throw new Error(`Domain ${domainName} not found or certificate not issued`);
  }

  // Attempt to become leader and re-upload to MongoDB
  const serverId = process.env.SERVER_ID || process.env.HOSTNAME || "control-1";
  const isLeader = await certSyncService.attemptBecomeLeader(serverId);
  
  if (isLeader) {
    const certPem = await Bun.file(`${domain.certPath}/cert.pem`).text();
    const chainPem = await Bun.file(`${domain.certPath}/chain.pem`).text();
    const fullchainPem = await Bun.file(`${domain.certPath}/fullchain.pem`).text();
    const privkeyPem = await Bun.file(`${domain.certPath}/privkey.pem`).text();
    
    const certB64 = Buffer.from(certPem).toString('base64');
    const chainB64 = Buffer.from(chainPem).toString('base64');
    const fullchainB64 = Buffer.from(fullchainPem).toString('base64');
    const privkeyB64 = Buffer.from(privkeyPem).toString('base64');
    
    await certSyncService.uploadCertificateToMongoDB(
      domainName,
      certB64,
      chainB64,
      fullchainB64,
      privkeyB64,
      serverId
    );
  }

  // Update last synced time
  await db.updateCustomDomainByName(domainName, {
    synced: true,
    lastSyncedAt: Date.now(),
  });
}

/**
 * Delete custom domain and cleanup
 */
export async function deleteCustomDomain(domainName: string): Promise<void> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain) {
    throw new Error(`Domain ${domainName} not found`);
  }

  // Delete tunnels for this domain
  const allTunnels = await db.getAllTunnels();
  for (const tunnel of allTunnels) {
    if (tunnel.customDomain === domainName) {
      await db.deleteTunnel(tunnel.id);
    }
  }

  // Remove domain from database
  await db.deleteCustomDomain(domain.id);

  console.log(`✅ Deleted custom domain ${domainName}`);
}

/**
 * Transfer domain to a different VPS/region
 * MongoDB-based: VPS servers will pull certificate on their sync schedule
 */
export async function transferDomain(
  domainName: string,
  targetVpsId: string,
  includeOtherServers: boolean = true
): Promise<CustomDomain> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain || !domain.certPath) {
    throw new Error(`Domain ${domainName} not found or certificate not issued`);
  }

  // Verify target VPS exists and is healthy
  const targetVps = await vpsService.getVpsServerById(targetVpsId);
  if (!targetVps) {
    throw new Error(`VPS server ${targetVpsId} not found`);
  }
  if (!targetVps.healthy) {
    throw new Error(`VPS server ${targetVpsId} is not healthy`);
  }

  try {
    // Ensure certificate is in MongoDB (target VPS will pull from there)
    const serverId = process.env.SERVER_ID || process.env.HOSTNAME || "control-1";
    const isLeader = await certSyncService.attemptBecomeLeader(serverId);
    
    if (isLeader) {
      const certPem = await Bun.file(`${domain.certPath}/cert.pem`).text();
      const chainPem = await Bun.file(`${domain.certPath}/chain.pem`).text();
      const fullchainPem = await Bun.file(`${domain.certPath}/fullchain.pem`).text();
      const privkeyPem = await Bun.file(`${domain.certPath}/privkey.pem`).text();
      
      const certB64 = Buffer.from(certPem).toString('base64');
      const chainB64 = Buffer.from(chainPem).toString('base64');
      const fullchainB64 = Buffer.from(fullchainPem).toString('base64');
      const privkeyB64 = Buffer.from(privkeyPem).toString('base64');
      
      await certSyncService.uploadCertificateToMongoDB(
        domainName,
        certB64,
        chainB64,
        fullchainB64,
        privkeyB64,
        serverId
      );
    }

    console.log(`✅ Certificate available in MongoDB for ${domainName} (target VPS will pull on next sync)`);

    // Update domain with transfer info
    await db.updateCustomDomainByName(domainName, {
      synced: true,
      lastSyncedAt: Date.now(),
    });

    const result = (await db.getCustomDomainByName(domainName)) as CustomDomain;

    // Send notification
    await notificationService.notifyDomainTransferred(domainName, targetVpsId, includeOtherServers);

    return result;
  } catch (error) {
    console.error(`Failed to transfer domain ${domainName}:`, error);
    throw error;
  }
}

/**
 * Create a backup of domain certificates
 */
export async function backupDomain(domainName: string): Promise<{
  id: string;
  domain: string;
  timestamp: number;
  size: number;
}> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain || !domain.certPath) {
    throw new Error(`Domain ${domainName} not found or certificate not issued`);
  }

  const backup = await backupUtils.backupDomainCerts(domainName, domain.certPath);
  
  const result = {
    id: backup.id,
    domain: backup.domain,
    timestamp: backup.timestamp,
    size: backup.size,
  };

  // Send notification
  await notificationService.notifyBackupCreated(domainName, backup.id, backup.size);

  return result;
}

/**
 * Restore a domain from a backup
 */
export async function restoreDomain(domainName: string, backupId: string): Promise<CustomDomain> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain || !domain.certPath) {
    throw new Error(`Domain ${domainName} not found or certificate not issued`);
  }

  // Restore from backup
  await backupUtils.restoreCertBackup(backupId, domain.certPath);

  // Sync restored certificates to all VPS servers
  await syncCertificateToAllVps(domainName, domain.certPath);

  // Update domain
  await db.updateCustomDomainByName(domainName, {
    synced: true,
    lastSyncedAt: Date.now(),
  });

  const result = (await db.getCustomDomainByName(domainName)) as CustomDomain;

  // Send notification
  await notificationService.notifyBackupRestored(domainName, backupId);

  return result;
}

/**
 * List all backups for a domain
 */
export async function listDomainBackups(
  domainName: string
): Promise<
  Array<{
    id: string;
    domain: string;
    timestamp: number;
    size: number;
  }>
> {
  const backups = await backupUtils.listDomainBackups(domainName);
  return backups.map((b) => ({
    id: b.id,
    domain: b.domain,
    timestamp: b.timestamp,
    size: b.size,
  }));
}

