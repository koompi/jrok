import type { CustomDomain, RegisterCustomDomainRequest } from "../types/index";
import * as db from "../utils/database";
import * as notificationService from "./notificationService";
import * as cloudflareService from "./cloudflareService";
import { generateId, sanitizeDomainToSubdomain } from "../utils/helpers";
import dns from "dns/promises";

// =============================================================================
// CUSTOM DOMAINS via Cloudflare for SaaS (Custom Hostnames)
// =============================================================================
// TLS for custom domains is provisioned, served, and auto-renewed by Cloudflare
// at the edge. We never issue or sync certificates ourselves (no Certbot, no
// nginx, no leader election). Customers point their domain at our Cloudflare-for-
// SaaS fallback hostname as a DNS-only (grey-cloud) CNAME.
// =============================================================================

const BASE_DOMAIN = process.env.BASE_DOMAIN || "live.koompi.cloud";
// The hostname customers CNAME to (must resolve to our Cloudflare edge / fallback origin).
const SAAS_CNAME_TARGET = process.env.CF_SAAS_FALLBACK_HOSTNAME || BASE_DOMAIN;

/**
 * Verify that a domain's CNAME record points to the expected target
 */
export async function verifyCname(
  domain: string,
  expectedTarget: string
): Promise<{ verified: boolean; actualCname?: string; error?: string }> {
  try {
    const records = await dns.resolveCname(domain);
    const normalizedExpected = expectedTarget.toLowerCase().replace(/\.$/, "");

    for (const record of records) {
      const normalizedRecord = record.toLowerCase().replace(/\.$/, "");
      if (normalizedRecord === normalizedExpected) {
        return { verified: true, actualCname: record };
      }
    }

    return {
      verified: false,
      actualCname: records[0] || undefined,
      error: `CNAME points to "${records[0] || "nothing"}" instead of "${expectedTarget}"`,
    };
  } catch (error: any) {
    if (error.code === "ENODATA" || error.code === "ENOTFOUND") {
      return { verified: false, error: `No CNAME record found for ${domain}` };
    }
    return { verified: false, error: `DNS lookup failed: ${error.message}` };
  }
}

/**
 * Validate and sanitize a domain name (defensive; also rejects traversal).
 */
function sanitizeDomain(domain: string): string {
  const sanitized = domain.toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(sanitized)) {
    throw new Error("Invalid domain name format");
  }
  if (sanitized.length > 253) {
    throw new Error("Domain name too long");
  }
  if (sanitized.includes("..") || sanitized.includes("/")) {
    throw new Error("Invalid characters in domain name");
  }
  return sanitized;
}

/**
 * Register a custom domain. Creates the Cloudflare-for-SaaS custom hostname and
 * returns the record (pending until the customer's CNAME resolves and Cloudflare
 * issues the edge certificate).
 */
export async function registerCustomDomain(
  request: RegisterCustomDomainRequest
): Promise<CustomDomain> {
  const safeDomain = sanitizeDomain(request.domain);

  const existing = await db.getCustomDomainByName(safeDomain);
  if (existing) {
    throw new Error(`Domain ${safeDomain} is already registered`);
  }

  // Create the Cloudflare custom hostname (CF provisions + auto-renews the cert).
  let cfHostnameId: string | undefined;
  let ownership: CustomDomain["ownershipVerification"];
  let sslStatus = "pending";

  if (cloudflareService.isConfigured()) {
    // Non-fatal: if Cloudflare is briefly unavailable we still persist the
    // pending record so the customer can retry `verify` (which re-creates the
    // custom hostname if it's missing) instead of losing the registration.
    try {
      const ch = await cloudflareService.createCustomHostname(safeDomain);
      cfHostnameId = ch.id;
      ownership = ch.ownership;
      sslStatus = ch.sslStatus;
    } catch (error) {
      console.warn(
        `⚠️  Could not create Cloudflare custom hostname for ${safeDomain} (will retry on verify): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } else {
    console.warn(
      "⚠️  Cloudflare for SaaS not configured (CF_API_TOKEN / CF_ZONE_ID) — custom hostname not created."
    );
  }

  const domain: CustomDomain = {
    id: generateId(),
    domain: safeDomain,
    baseDomain: false,
    certbotEmail: request.certbotEmail, // contact email only
    createdAt: Date.now(),
    active: false, // becomes true once Cloudflare reports the cert active
    synced: false,
    targetSubdomain: sanitizeDomainToSubdomain(safeDomain),
    cnameTarget: SAAS_CNAME_TARGET,
    cnameVerified: false,
    organizationId: request.organizationId,
    cfHostnameId,
    sslStatus,
    ownershipVerification: ownership,
  };

  await db.createCustomDomain(domain);

  console.log(
    `📝 Custom domain registered: ${safeDomain} → CNAME (DNS only) to ${SAAS_CNAME_TARGET}`
  );
  return domain;
}

/**
 * Verify the CNAME and activate the domain once Cloudflare has issued the cert.
 * (Kept under the original name for API/CLI compatibility — no longer runs Certbot.)
 */
export async function verifyAndIssueCertificate(domainName: string): Promise<CustomDomain> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain) {
    throw new Error(`Domain ${domainName} not found`);
  }
  if (!domain.cnameTarget) {
    throw new Error(`Domain ${domainName} has no CNAME target configured`);
  }

  // 1. The customer must CNAME their domain (DNS only / grey cloud) to our target.
  const verification = await verifyCname(domain.domain, domain.cnameTarget);
  if (!verification.verified) {
    throw new Error(
      `CNAME not verified: ${verification.error}. Add this record (DNS only — do NOT enable the orange proxy): ${domain.domain} CNAME ${domain.cnameTarget}`
    );
  }

  await db.updateCustomDomainByName(domainName, {
    cnameVerified: true,
    cnameVerifiedAt: Date.now(),
  });

  if (!cloudflareService.isConfigured()) {
    throw new Error("Cloudflare for SaaS is not configured on the server (CF_API_TOKEN / CF_ZONE_ID).");
  }

  // 2. Ensure we have a Cloudflare custom hostname, then poll its status.
  let cfId = domain.cfHostnameId;
  if (!cfId) {
    const existing = await cloudflareService.findCustomHostnameByName(domain.domain);
    const ch = existing || (await cloudflareService.createCustomHostname(domain.domain));
    cfId = ch.id;
    await db.updateCustomDomainByName(domainName, { cfHostnameId: cfId });
  }

  const ch = await cloudflareService.getCustomHostname(cfId);
  await db.updateCustomDomainByName(domainName, {
    sslStatus: ch.sslStatus,
    ownershipVerification: ch.ownership,
  });

  if (ch.status === "active" && ch.sslStatus === "active") {
    await db.updateCustomDomainByName(domainName, {
      active: true,
      synced: true,
      lastSyncedAt: Date.now(),
    });
    const updated = (await db.getCustomDomainByName(domainName)) as CustomDomain;
    await notificationService.notifyCertIssued(domainName, domain.certExpiry || 0).catch(() => {});
    console.log(`✅ Cloudflare edge certificate active for ${domainName}`);
    return updated;
  }

  throw new Error(
    `Cloudflare is still provisioning the certificate (hostname: ${ch.status}, ssl: ${ch.sslStatus}). This usually completes within a minute of the CNAME resolving — try again shortly.`
  );
}

/**
 * Check CNAME + Cloudflare SSL status without activating.
 */
export async function checkCnameStatus(domainName: string): Promise<{
  domain: string;
  cnameTarget: string;
  verified: boolean;
  actualCname?: string;
  error?: string;
  sslStatus?: string;
}> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain) {
    throw new Error(`Domain ${domainName} not found`);
  }
  if (!domain.cnameTarget) {
    throw new Error(`Domain ${domainName} has no CNAME target configured`);
  }

  const verification = await verifyCname(domain.domain, domain.cnameTarget);

  let sslStatus = domain.sslStatus;
  if (cloudflareService.isConfigured() && domain.cfHostnameId) {
    try {
      const ch = await cloudflareService.getCustomHostname(domain.cfHostnameId);
      sslStatus = ch.sslStatus;
    } catch {
      // best-effort; fall back to stored status
    }
  }

  return {
    domain: domain.domain,
    cnameTarget: domain.cnameTarget,
    verified: verification.verified,
    actualCname: verification.actualCname,
    error: verification.error,
    sslStatus,
  };
}

/**
 * Refresh a domain's certificate status from Cloudflare and persist it.
 * (Replaces the old VPS cert-resync — Cloudflare owns the cert now.)
 */
export async function resyncCertificate(domainName: string): Promise<CustomDomain> {
  const domain = await db.getCustomDomainByName(domainName);
  if (!domain) {
    throw new Error(`Domain ${domainName} not found`);
  }

  if (cloudflareService.isConfigured() && domain.cfHostnameId) {
    const ch = await cloudflareService.getCustomHostname(domain.cfHostnameId);
    const isActive = ch.status === "active" && ch.sslStatus === "active";
    await db.updateCustomDomainByName(domainName, {
      sslStatus: ch.sslStatus,
      ownershipVerification: ch.ownership,
      active: isActive,
      synced: isActive,
      lastSyncedAt: Date.now(),
    });
  }

  return (await db.getCustomDomainByName(domainName)) as CustomDomain;
}

/**
 * Get custom domain details
 */
export async function getCustomDomain(domainName: string): Promise<CustomDomain | null> {
  return await db.getCustomDomainByName(domainName);
}

/**
 * List all custom domains (super-admin / internal use only — not org-scoped).
 */
export async function listCustomDomains(): Promise<CustomDomain[]> {
  return await db.getAllCustomDomains();
}

/**
 * List custom domains owned by a specific organization.
 */
export async function listCustomDomainsByOrganization(organizationId: string): Promise<CustomDomain[]> {
  return await db.getCustomDomainsByOrganization(organizationId);
}

/**
 * Delete a custom domain (also removes the Cloudflare custom hostname).
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

  // Remove the Cloudflare custom hostname (best-effort).
  if (cloudflareService.isConfigured() && domain.cfHostnameId) {
    try {
      await cloudflareService.deleteCustomHostname(domain.cfHostnameId);
    } catch (error) {
      console.warn(
        `⚠️  Could not delete Cloudflare custom hostname for ${domainName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  await db.deleteCustomDomain(domain.id);
  console.log(`✅ Deleted custom domain ${domainName}`);
}
