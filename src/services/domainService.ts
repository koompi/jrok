import type { CustomDomain, RegisterCustomDomainRequest } from "../types/index";
import * as db from "../utils/database";
import * as vpsService from "./vpsService";
import * as backupUtils from "../utils/backupUtils";
import * as notificationService from "./notificationService";
import * as certSyncService from "./certificateSyncService";
import * as monitoringService from "./monitoringService";
import { generateId, sanitizeDomainToSubdomain, generateShortSuffix } from "../utils/helpers";
import { getTunnelByDomain } from "../utils/database";
import dns from "dns/promises";

// Get base domain from environment
const BASE_DOMAIN = process.env.BASE_DOMAIN || "tunnel.koompi.cloud";

/**
 * Verify that a domain's CNAME record points to the expected target
 */
export async function verifyCname(domain: string, expectedTarget: string): Promise<{ verified: boolean; actualCname?: string; error?: string }> {
  try {
    const records = await dns.resolveCname(domain);
    const normalizedExpected = expectedTarget.toLowerCase().replace(/\.$/, '');
    
    for (const record of records) {
      const normalizedRecord = record.toLowerCase().replace(/\.$/, '');
      if (normalizedRecord === normalizedExpected) {
        return { verified: true, actualCname: record };
      }
    }
    
    return { 
      verified: false, 
      actualCname: records[0] || undefined,
      error: `CNAME points to "${records[0] || 'nothing'}" instead of "${expectedTarget}"` 
    };
  } catch (error: any) {
    if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') {
      return { verified: false, error: `No CNAME record found for ${domain}` };
    }
    return { verified: false, error: `DNS lookup failed: ${error.message}` };
  }
}

/**
 * Generate a unique subdomain for a custom domain
 * @param baseName - The base name to use (e.g., "jersen-app" from "jersen.app")
 * @returns A unique subdomain that doesn't conflict with existing tunnels
 */
async function generateUniqueSubdomain(baseName: string): Promise<string> {
  // First try the base name without suffix
  const existingTunnel = await getTunnelByDomain(baseName);
  if (!existingTunnel) {
    return baseName;
  }
  
  // If taken, add random suffix
  for (let i = 0; i < 10; i++) {
    const suffix = generateShortSuffix();
    const newName = `${baseName}-${suffix}`;
    const existing = await getTunnelByDomain(newName);
    if (!existing) {
      return newName;
    }
  }
  
  // Fallback: use timestamp
  return `${baseName}-${Date.now().toString(36)}`;
}

/**
 * Register a custom domain - creates pending domain awaiting CNAME verification
 * Does NOT issue certificate until CNAME is verified
 */
export async function registerCustomDomain(
  request: RegisterCustomDomainRequest
): Promise<CustomDomain> {
  // Check if domain already exists
  const existing = await db.getCustomDomainByName(request.domain);
  if (existing) {
    throw new Error(`Domain ${request.domain} is already registered`);
  }

  // Generate subdomain: use provided or auto-generate from domain
  const baseSubdomain = request.subdomain || sanitizeDomainToSubdomain(request.domain);
  const targetSubdomain = await generateUniqueSubdomain(baseSubdomain);
  const cnameTarget = `${targetSubdomain}.${BASE_DOMAIN}`;

  const domain: CustomDomain = {
    id: generateId(),
    domain: request.domain,
    baseDomain: false,
    certbotEmail: request.certbotEmail,
    cloudflareToken: request.cloudflareToken,
    createdAt: Date.now(),
    active: false, // Will be true once cert is issued
    synced: false,
    // New verification fields
    targetSubdomain,
    cnameTarget,
    cnameVerified: false,
    organizationId: request.organizationId,
  };

  // Save domain to database (pending verification)
  await db.createCustomDomain(domain);

  console.log(`📝 Custom domain registered (pending verification): ${request.domain} -> ${cnameTarget}`);
  
  return domain;
}

/**
 * Verify CNAME and issue certificate if verification passes
 */
export async function verifyAndIssueCertificate(domainName: string): Promise<CustomDomain> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain) {
    throw new Error(`Domain ${domainName} not found`);
  }

  if (domain.active && domain.synced) {
    throw new Error(`Domain ${domainName} is already active with a valid certificate`);
  }

  if (!domain.cnameTarget) {
    throw new Error(`Domain ${domainName} has no CNAME target configured`);
  }

  // Verify CNAME
  const verification = await verifyCname(domain.domain, domain.cnameTarget);
  if (!verification.verified) {
    throw new Error(`CNAME verification failed: ${verification.error}. Please add a CNAME record: ${domain.domain} -> ${domain.cnameTarget}`);
  }

  console.log(`✅ CNAME verified for ${domain.domain} -> ${verification.actualCname}`);

  // Update verification status
  await db.updateCustomDomainByName(domainName, {
    cnameVerified: true,
    cnameVerifiedAt: Date.now(),
  });

  try {
    // Issue wildcard certificate for this domain
    const certPath = await issueCertificate(domain.domain, domain.certbotEmail, domain.cloudflareToken);

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
        domain.domain,
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
    await db.updateCustomDomainByName(domainName, {
      active: true,
      synced: true,
      certPath,
      certExpiry: expiry,
      lastSyncedAt: Date.now(),
    });

    const updatedDomain = await db.getCustomDomainByName(domainName) as CustomDomain;

    // Send Telegram notification
    await notificationService.notifyCertIssued(domainName, expiry);

    return updatedDomain;
  } catch (error) {
    // Track certificate failure
    const errorMsg = error instanceof Error ? error.message : String(error);
    monitoringService.trackCertRenewal(false, errorMsg);
    monitoringService.addLog('error', 'certificates', `Certificate issuance failed for ${domainName}`, { error: errorMsg });
    
    // Don't delete domain on cert failure - user can retry
    throw new Error(`Certificate issuance failed: ${errorMsg}`);
  }
}

/**
 * Check CNAME verification status without issuing certificate
 */
export async function checkCnameStatus(domainName: string): Promise<{
  domain: string;
  cnameTarget: string;
  verified: boolean;
  actualCname?: string;
  error?: string;
}> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain) {
    throw new Error(`Domain ${domainName} not found`);
  }

  if (!domain.cnameTarget) {
    throw new Error(`Domain ${domainName} has no CNAME target configured`);
  }

  const verification = await verifyCname(domain.domain, domain.cnameTarget);
  
  return {
    domain: domain.domain,
    cnameTarget: domain.cnameTarget,
    verified: verification.verified,
    actualCname: verification.actualCname,
    error: verification.error,
  };
}

/**
 * Validate and sanitize domain name to prevent command injection
 */
function sanitizeDomain(domain: string): string {
  // Only allow alphanumeric, dots, and hyphens
  const sanitized = domain.toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(sanitized)) {
    throw new Error("Invalid domain name format");
  }
  if (sanitized.length > 253) {
    throw new Error("Domain name too long");
  }
  // Prevent directory traversal
  if (sanitized.includes('..') || sanitized.includes('/')) {
    throw new Error("Invalid characters in domain name");
  }
  return sanitized;
}

/**
 * Validate email format
 */
function sanitizeEmail(email: string): string {
  const sanitized = email.toLowerCase().trim();
  // Basic email validation - no shell special characters
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(sanitized)) {
    throw new Error("Invalid email format");
  }
  if (sanitized.length > 254) {
    throw new Error("Email too long");
  }
  return sanitized;
}

/**
 * Validate Cloudflare token format
 */
function sanitizeCloudflareToken(token: string): string {
  // Cloudflare API tokens are alphanumeric with underscores and hyphens
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    throw new Error("Invalid Cloudflare token format");
  }
  if (token.length > 100) {
    throw new Error("Cloudflare token too long");
  }
  return token;
}

/**
 * Issue wildcard certificate using Certbot + Cloudflare DNS
 * Uses argument arrays instead of shell string interpolation to prevent injection
 */
async function issueCertificate(
  domain: string,
  email: string,
  cloudflareToken?: string
): Promise<string> {
  // Sanitize all inputs
  const safeDomain = sanitizeDomain(domain);
  const safeEmail = sanitizeEmail(email);
  const certPath = `/etc/letsencrypt/live/${safeDomain}`;

  if (cloudflareToken) {
    const safeToken = sanitizeCloudflareToken(cloudflareToken);
    
    // Create credentials file securely
    const credentialsPath = `/etc/letsencrypt/secrets/cloudflare_${safeDomain}.ini`;
    const credentialsContent = `dns_cloudflare_api_token = ${safeToken}`;
    
    // Create directory with secure permissions
    await Bun.spawn(["mkdir", "-p", "/etc/letsencrypt/secrets/"]).exited;
    await Bun.spawn(["chmod", "700", "/etc/letsencrypt/secrets/"]).exited;
    
    // Write credentials file
    await Bun.write(credentialsPath, credentialsContent);
    
    // Set restrictive permissions
    await Bun.spawn(["chmod", "600", credentialsPath]).exited;
    
    try {
      // Run certbot with separate arguments (no shell interpolation)
      const certbotProcess = Bun.spawn([
        "certbot", "certonly",
        "--dns-cloudflare",
        "--dns-cloudflare-credentials", credentialsPath,
        "--email", safeEmail,
        "--agree-tos",
        "--non-interactive",
        "-d", safeDomain,
        "-d", `*.${safeDomain}`
      ]);
      
      const exitCode = await certbotProcess.exited;
      if (exitCode !== 0) {
        throw new Error(`Certbot failed with exit code ${exitCode}`);
      }
    } finally {
      // Security: Always cleanup credentials file after use
      try {
        // Overwrite with zeros before deletion (secure delete)
        await Bun.write(credentialsPath, "0".repeat(credentialsContent.length));
        await Bun.spawn(["rm", "-f", credentialsPath]).exited;
        console.log(`🔒 Cleaned up credentials file: ${credentialsPath}`);
      } catch (cleanupError) {
        console.warn(`⚠️  Could not cleanup credentials file: ${cleanupError}`);
      }
    }
  } else {
    // Fallback: Use HTTP challenge (requires domain to resolve to VPS)
    const certbotProcess = Bun.spawn([
      "certbot", "certonly",
      "--standalone",
      "--email", safeEmail,
      "--agree-tos",
      "--non-interactive",
      "-d", safeDomain,
      "-d", `*.${safeDomain}`
    ]);
    
    const exitCode = await certbotProcess.exited;
    if (exitCode !== 0) {
      throw new Error(`Certbot failed with exit code ${exitCode}`);
    }
  }

  console.log(`✅ Certificate issued for ${safeDomain}`);
  
  // Track successful certificate issuance
  monitoringService.trackCertRenewal(true);
  monitoringService.addLog('info', 'certificates', `Certificate issued for ${safeDomain}`);
  
  return certPath;
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

