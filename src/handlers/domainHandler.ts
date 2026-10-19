import type { AuthContext, CustomDomain, RegisterCustomDomainRequest } from "../types/index";
import * as domainService from "../services/domainService";
import * as database from "../utils/database";
import { checkGlobalRateLimit, checkDomainRateLimit } from "../utils/rateLimiter";
import * as notificationService from "../services/notificationService";
import * as planLimitService from "../services/planLimitService";
import { isPrivileged, checkOrgAccess, filterOwned, resolveDomainOwner } from "../utils/access";

export interface DomainResponse {
  success: boolean;
  message: string;
  domain?: CustomDomain;
  error?: string;
}

export interface ListDomainsResponse {
  success: boolean;
  domains: CustomDomain[];
  total: number;
}

/**
 * Ownership gate for every /domains/:domain route (see utils/access.ts). These
 * used to require only a signed-in caller, so any jrok account or any org's API
 * key could read, delete, re-sync, transfer or restore any customer's domain.
 * Privileged callers (kconsole's platform key, the server key, super-admins)
 * keep access to all of them. Returns a response to send, or null to proceed.
 */
async function denyUnlessDomainOwner(domain: string, ctx: AuthContext): Promise<Response | null> {
  if (!domain || isPrivileged(ctx)) return null;
  const record = await database.getCustomDomainByName(domain);
  const decision = await checkOrgAccess(ctx, record?.organizationId);
  if (decision.allowed) return null;
  return new Response(
    JSON.stringify({ success: false, message: "Domain not found" } as DomainResponse),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
}

// `clientIp` is the verified visitor address from the server (utils/clientIp.ts).
export async function handleRegisterDomain(req: Request, clientIp: string, authContext: AuthContext): Promise<Response> {
  try {
    // Check global rate limit
    const globalLimit = checkGlobalRateLimit(clientIp);
    if (globalLimit) {
      // Send rate limit notification
      await notificationService.notifyRateLimitExceeded(clientIp);

      return new Response(
        JSON.stringify({
          success: false,
          message: `Rate limit exceeded. Try again in ${globalLimit.retryAfter} seconds`,
        } as DomainResponse),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(globalLimit.retryAfter),
          },
        }
      );
    }

    const body = (await req.json()) as RegisterCustomDomainRequest;

    // Validate input
    if (!body.domain || !body.certbotEmail) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Missing required fields: domain, certbotEmail",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Validate domain format (basic validation)
    if (!isValidDomain(body.domain)) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Invalid domain format",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check per-domain rate limit
    const domainLimit = checkDomainRateLimit(body.domain);
    if (domainLimit) {
      // Send rate limit notification
      await notificationService.notifyRateLimitExceeded(clientIp, body.domain);

      return new Response(
        JSON.stringify({
          success: false,
          message: `Domain rate limit exceeded. Try again in ${domainLimit.retryAfter} seconds`,
        } as DomainResponse),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(domainLimit.retryAfter),
          },
        }
      );
    }

    // ====== OWNER ======
    // Only privileged callers (kconsole registering for its customers) may name
    // an arbitrary organizationId; anyone else registers under their own org.
    const owner = await resolveDomainOwner(authContext, body.organizationId);
    if (!owner.ok) {
      return new Response(
        JSON.stringify({ success: false, message: owner.message } as DomainResponse),
        { status: owner.status, headers: { "Content-Type": "application/json" } }
      );
    }
    body.organizationId = owner.organizationId;

    // ====== PLAN LIMIT CHECK: Domain Count ======
    // Get organization from auth context
    if (authContext?.organization?.id) {
      const domainLimitCheck = await planLimitService.checkDomainLimit(authContext.organization.id);
      if (!domainLimitCheck.allowed) {
        return new Response(
          JSON.stringify({
            success: false,
            message: domainLimitCheck.reason,
            current: domainLimitCheck.current,
            limit: domainLimitCheck.limit,
          } as DomainResponse),
          { status: 402, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const domain = await domainService.registerCustomDomain(body);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Custom domain registered successfully",
        domain,
      } as DomainResponse),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Domain registration error:", errorMsg);

    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to register custom domain",
        error: errorMsg,
      } as DomainResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleGetDomain(domain: string, authContext: AuthContext): Promise<Response> {
  try {
    const denied = await denyUnlessDomainOwner(domain, authContext);
    if (denied) return denied;

    if (!domain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain name is required",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const customDomain = await domainService.getCustomDomain(domain);

    if (!customDomain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain not found",
        } as DomainResponse),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        domain: customDomain,
      } as DomainResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to retrieve domain",
        error: errorMsg,
      } as DomainResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleListDomains(authContext: AuthContext): Promise<Response> {
  try {
    // Privileged callers see every domain; everyone else only their orgs'.
    const domains = await filterOwned(authContext, await domainService.listCustomDomains(), (d) => d.organizationId);

    return new Response(
      JSON.stringify({
        success: true,
        domains,
        total: domains.length,
      } as ListDomainsResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to list domains",
        error: errorMsg,
      } as DomainResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleDeleteDomain(domain: string, authContext: AuthContext): Promise<Response> {
  try {
    const denied = await denyUnlessDomainOwner(domain, authContext);
    if (denied) return denied;

    if (!domain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain name is required",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if domain exists
    const existingDomain = await domainService.getCustomDomain(domain);
    if (!existingDomain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain not found",
        } as DomainResponse),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    await domainService.deleteCustomDomain(domain);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Domain deleted successfully",
      } as DomainResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to delete domain",
        error: errorMsg,
      } as DomainResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleResyncDomain(domain: string, authContext: AuthContext): Promise<Response> {
  try {
    const denied = await denyUnlessDomainOwner(domain, authContext);
    if (denied) return denied;

    if (!domain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain name is required",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const customDomain = await domainService.resyncCertificate(domain);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Domain certificate synced to all VPS servers",
        domain: customDomain,
      } as DomainResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to resync domain certificate",
        error: errorMsg,
      } as DomainResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleTransferDomain(domain: string, req: Request, authContext: AuthContext): Promise<Response> {
  try {
    const denied = await denyUnlessDomainOwner(decodeURIComponent(domain), authContext);
    if (denied) return denied;

    if (!domain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain name is required",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = (await req.json()) as {
      targetVpsId: string;
      includeOtherServers?: boolean;
    };

    if (!body.targetVpsId) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "targetVpsId is required",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const customDomain = await domainService.transferDomain(
      decodeURIComponent(domain),
      body.targetVpsId,
      body.includeOtherServers !== false
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: "Domain transferred successfully",
        domain: customDomain,
      } as DomainResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to transfer domain",
        error: errorMsg,
      } as DomainResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleBackupDomain(domain: string, authContext: AuthContext): Promise<Response> {
  try {
    const denied = await denyUnlessDomainOwner(decodeURIComponent(domain), authContext);
    if (denied) return denied;

    if (!domain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain name is required",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const backup = await domainService.backupDomain(decodeURIComponent(domain));

    return new Response(
      JSON.stringify({
        success: true,
        message: "Domain backup created successfully",
        backup,
      }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to backup domain",
        error: errorMsg,
      } as DomainResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleRestoreDomain(domain: string, backupId: string, authContext: AuthContext): Promise<Response> {
  try {
    const denied = await denyUnlessDomainOwner(decodeURIComponent(domain), authContext);
    if (denied) return denied;

    if (!domain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain name is required",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!backupId) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Backup ID is required",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // The backup must be one of THIS domain's. backupId is joined onto the
    // backup directory as a path, so an arbitrary value could restore another
    // domain's certificate here, or name a directory outside the backups.
    const ownBackups = await domainService.listDomainBackups(decodeURIComponent(domain));
    if (!ownBackups.some((b) => b.id === backupId)) {
      return new Response(
        JSON.stringify({ success: false, message: "Backup not found for this domain" } as DomainResponse),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const customDomain = await domainService.restoreDomain(decodeURIComponent(domain), backupId);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Domain restored from backup successfully",
        domain: customDomain,
      } as DomainResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to restore domain",
        error: errorMsg,
      } as DomainResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function handleListBackups(domain: string, authContext: AuthContext): Promise<Response> {
  try {
    const denied = await denyUnlessDomainOwner(decodeURIComponent(domain), authContext);
    if (denied) return denied;

    if (!domain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain name is required",
        } as DomainResponse),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const backups = await domainService.listDomainBackups(decodeURIComponent(domain));

    return new Response(
      JSON.stringify({
        success: true,
        backups,
        total: backups.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Failed to list backups",
        error: errorMsg,
      } as DomainResponse),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Basic domain validation
 * Ensures domain has at least 2 parts separated by dots
 */
function isValidDomain(domain: string): boolean {
  // Must contain at least one dot
  if (!domain.includes(".")) {
    return false;
  }

  const parts = domain.split(".");

  // Must have at least 2 parts (e.g., example.com)
  if (parts.length < 2) {
    return false;
  }

  // Each part must be valid
  for (const part of parts) {
    // Must not be empty
    if (part.length === 0) {
      return false;
    }

    // Must start and end with alphanumeric
    if (!/^[a-zA-Z0-9]/.test(part) || !/[a-zA-Z0-9]$/.test(part)) {
      return false;
    }

    // Must contain only alphanumeric and hyphens
    if (!/^[a-zA-Z0-9-]+$/.test(part)) {
      return false;
    }
  }

  return true;
}

/**
 * Check CNAME verification status for a domain
 * GET /domains/:domain/verify-status
 */
export async function handleCheckCnameStatus(domain: string, authContext: AuthContext): Promise<Response> {
  try {
    const denied = await denyUnlessDomainOwner(domain, authContext);
    if (denied) return denied;

    if (!domain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain name is required",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const status = await domainService.checkCnameStatus(domain);

    return new Response(
      JSON.stringify({
        success: true,
        ...status,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: errorMsg,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Verify CNAME and issue certificate
 * POST /domains/:domain/verify
 */
export async function handleVerifyAndIssueCertificate(domain: string, authContext: AuthContext): Promise<Response> {
  try {
    const denied = await denyUnlessDomainOwner(domain, authContext);
    if (denied) return denied;

    if (!domain) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Domain name is required",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const updatedDomain = await domainService.verifyAndIssueCertificate(domain);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Certificate issued for ${domain}`,
        domain: updatedDomain,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        message: errorMsg,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}
