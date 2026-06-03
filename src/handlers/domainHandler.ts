import type { CustomDomain, RegisterCustomDomainRequest } from "../types/index";
import * as domainService from "../services/domainService";
import * as database from "../utils/database";
import { checkGlobalRateLimit, checkDomainRateLimit, getClientIp } from "../utils/rateLimiter";
import * as notificationService from "../services/notificationService";
import * as planLimitService from "../services/planLimitService";
import * as authService from "../services/authService";

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

function jsonError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ success: false, message } as DomainResponse),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Authenticate the request and confirm the caller's organization owns `domainName`.
 * Super admins bypass the ownership check. A domain that exists but is owned by a
 * different organization is reported as 404 (not 403) so callers can't enumerate or
 * probe other tenants' domains by name.
 */
async function authorizeDomain(
  req: Request,
  domainName: string
): Promise<{ ok: true; domain: CustomDomain } | { ok: false; response: Response }> {
  const authContext = await authService.authenticateRequest(req);
  if (!authContext) {
    return { ok: false, response: jsonError(401, "Unauthorized") };
  }
  const domain = await domainService.getCustomDomain(domainName);
  const isSuperAdmin = authContext.user?.role === "super_admin";
  const orgId = authContext.organization?.id;
  if (!domain || (!isSuperAdmin && (!orgId || domain.organizationId !== orgId))) {
    return { ok: false, response: jsonError(404, "Domain not found") };
  }
  return { ok: true, domain };
}

export async function handleRegisterDomain(req: Request): Promise<Response> {
  try {
    // Check global rate limit
    const clientIp = getClientIp(req);
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

    const body = (await req.json()) as RegisterCustomDomainRequest & { email?: string };

    // Accept `email` (preferred) or the legacy `certbotEmail` field as the domain
    // contact email. It is stored for contact only — Cloudflare provisions the cert,
    // so no email is used for certificate issuance.
    const contactEmail = body.email || body.certbotEmail;

    // Validate input
    if (!body.domain || !contactEmail) {
      return jsonError(400, "Missing required fields: domain and a contact email");
    }
    body.certbotEmail = contactEmail;

    // Validate domain format (basic validation)
    if (!isValidDomain(body.domain)) {
      return jsonError(400, "Invalid domain format");
    }

    // Validate the contact email format (it is persisted and surfaced in the UI).
    if (!isValidEmail(contactEmail)) {
      return jsonError(400, "Invalid contact email format");
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

    // ====== AUTH + ORGANIZATION BINDING ======
    // Bind the domain to the caller's authenticated organization. NEVER trust an
    // organizationId supplied in the request body — that would let any user register
    // a domain under another organization. Super admins may target a specific org.
    const authContext = await authService.authenticateRequest(req);
    if (!authContext) {
      return jsonError(401, "Unauthorized");
    }
    const callerOrgId = authContext.organization?.id;
    if (authContext.user?.role === "super_admin") {
      body.organizationId = body.organizationId || callerOrgId;
    } else {
      if (!callerOrgId) {
        return jsonError(403, "No organization context for this request");
      }
      body.organizationId = callerOrgId;
    }

    // ====== PLAN LIMIT CHECK: Domain Count ======
    if (body.organizationId) {
      const domainLimitCheck = await planLimitService.checkDomainLimit(body.organizationId);
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

export async function handleGetDomain(domain: string, req: Request): Promise<Response> {
  try {
    if (!domain) {
      return jsonError(400, "Domain name is required");
    }

    const auth = await authorizeDomain(req, domain);
    if (!auth.ok) return auth.response;

    return new Response(
      JSON.stringify({
        success: true,
        domain: auth.domain,
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

export async function handleListDomains(req: Request): Promise<Response> {
  try {
    const authContext = await authService.authenticateRequest(req);
    if (!authContext) {
      return jsonError(401, "Unauthorized");
    }

    // Only ever return the caller's own organization's domains. Super admins may
    // list everything.
    let domains: CustomDomain[];
    if (authContext.user?.role === "super_admin") {
      domains = await domainService.listCustomDomains();
    } else if (authContext.organization?.id) {
      domains = await domainService.listCustomDomainsByOrganization(authContext.organization.id);
    } else {
      domains = [];
    }

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

export async function handleDeleteDomain(domain: string, req: Request): Promise<Response> {
  try {
    if (!domain) {
      return jsonError(400, "Domain name is required");
    }

    const auth = await authorizeDomain(req, domain);
    if (!auth.ok) return auth.response;

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

export async function handleResyncDomain(domain: string, req: Request): Promise<Response> {
  try {
    if (!domain) {
      return jsonError(400, "Domain name is required");
    }

    const auth = await authorizeDomain(req, domain);
    if (!auth.ok) return auth.response;

    const customDomain = await domainService.resyncCertificate(domain);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Refreshed certificate status from Cloudflare",
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

// NOTE: certificate transfer/backup/restore endpoints were removed.
// Certificates are now provisioned and managed by Cloudflare for SaaS — there
// are no local cert files to transfer, back up, or restore.

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
 * Basic contact-email validation (single address, reasonable length).
 */
function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Check CNAME verification status for a domain
 * GET /domains/:domain/verify-status
 */
export async function handleCheckCnameStatus(domain: string, req: Request): Promise<Response> {
  try {
    if (!domain) {
      return jsonError(400, "Domain name is required");
    }

    const auth = await authorizeDomain(req, domain);
    if (!auth.ok) return auth.response;

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
export async function handleVerifyAndIssueCertificate(domain: string, req: Request): Promise<Response> {
  try {
    if (!domain) {
      return jsonError(400, "Domain name is required");
    }

    const auth = await authorizeDomain(req, domain);
    if (!auth.ok) return auth.response;

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
