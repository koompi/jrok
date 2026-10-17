/**
 * Who may see or change which tenant's resources.
 *
 * Most of jrok's resource endpoints (/domains/*, /security/ip|allowlist|logs|
 * bandwidth, /agents) used to check only that the caller was signed in. Any
 * jrok account or any organization's API key could list every customer's
 * domains, delete or re-point them, switch off another tenant's IP allowlist,
 * or read its visitors' IPs.
 *
 * The rule now:
 *
 *   - privileged callers see everything, as before: the server API_KEY, a
 *     super-admin, and kconsole's platform key (the same identity that may
 *     impersonate an org; see config/impersonation.ts). kconsole manages every
 *     customer's domains and tunnels with that key.
 *   - everyone else sees only resources whose organizationId is one of their
 *     own orgs: the API key's org, or every org the user is a member of.
 *
 * A resource with no organizationId belongs to nobody, so only privileged
 * callers can reach it. Denials answer 404 rather than 403, so the endpoints
 * don't confirm which names exist under someone else's account.
 */

import type { AuthContext } from "../types/index";
import { canImpersonate } from "../config/impersonation";

/** Platform-wide access: server API_KEY, super-admin, or the platform key. */
export function isPrivileged(ctx: AuthContext | null | undefined): boolean {
  if (!ctx) return false;
  if (ctx.isServerKey) return true;
  if (ctx.user?.role === "super_admin") return true;
  if (ctx.apiKey) {
    return canImpersonate({
      organizationId: ctx.apiKey.organizationId,
      apiKeyId: ctx.apiKey.id,
      permissions: ctx.apiKey.permissions,
    });
  }
  return false;
}

export type UserOrgLookup = (userId: string) => Promise<Array<{ id: string }>>;

const defaultUserOrgLookup: UserOrgLookup = async (userId) => {
  const { getUserOrganizations } = await import("../services/organizationService");
  return getUserOrganizations(userId);
};

/** The org ids a caller acts for. An API key acts for its own org only. */
export async function callerOrgIds(
  ctx: AuthContext | null | undefined,
  lookupUserOrgs: UserOrgLookup = defaultUserOrgLookup
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!ctx) return ids;
  if (ctx.apiKey) {
    if (ctx.apiKey.organizationId) ids.add(ctx.apiKey.organizationId);
    return ids;
  }
  if (ctx.organization?.id) ids.add(ctx.organization.id);
  if (ctx.user) {
    for (const org of await lookupUserOrgs(ctx.user.id)) ids.add(org.id);
  }
  return ids;
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; status: 403 | 404; message: string };

const ALLOWED: AccessDecision = { allowed: true };

export interface AccessDeps {
  lookupUserOrgs?: UserOrgLookup;
  /** Every tunnel whose id OR domain equals the reference. */
  findTunnels?: (ref: string) => Promise<Array<{ organizationId?: string }>>;
}

/** May the caller act on resources of this org? */
export async function checkOrgAccess(
  ctx: AuthContext | null | undefined,
  organizationId: string | null | undefined,
  deps: AccessDeps = {}
): Promise<AccessDecision> {
  if (isPrivileged(ctx)) return ALLOWED;
  const orgs = await callerOrgIds(ctx, deps.lookupUserOrgs);
  if (organizationId && orgs.has(organizationId)) return ALLOWED;
  return { allowed: false, status: 404, message: "Not found" };
}

/**
 * May the caller act on a tunnel, referenced by tunnel id or domain the way the
 * /security endpoints take it?
 *
 * Every tunnel matching the reference must be the caller's. A lookup by "id OR
 * domain" could otherwise be steered: register a subdomain spelled like a
 * victim's tunnel id, and the first match would be your own tunnel while the
 * change lands on the victim's key.
 */
export async function checkTunnelAccess(
  ctx: AuthContext | null | undefined,
  ref: string,
  deps: AccessDeps = {}
): Promise<AccessDecision> {
  if (isPrivileged(ctx)) return ALLOWED;
  const notFound: AccessDecision = { allowed: false, status: 404, message: "Tunnel not found" };
  const tunnels = await (deps.findTunnels ?? findTunnelsByRef)(ref);
  if (tunnels.length === 0) return notFound;
  const orgs = await callerOrgIds(ctx, deps.lookupUserOrgs);
  const allOwned = tunnels.every((t) => !!t.organizationId && orgs.has(t.organizationId));
  return allOwned ? ALLOWED : notFound;
}

/** Keep only the items the caller may see. Privileged callers see all. */
export async function filterOwned<T>(
  ctx: AuthContext | null | undefined,
  items: T[],
  orgOf: (item: T) => string | null | undefined,
  deps: AccessDeps = {}
): Promise<T[]> {
  if (isPrivileged(ctx)) return items;
  const orgs = await callerOrgIds(ctx, deps.lookupUserOrgs);
  return items.filter((item) => {
    const org = orgOf(item);
    return !!org && orgs.has(org);
  });
}

/**
 * The owner a new custom domain is registered under.
 *
 * Privileged callers name any org (kconsole registers domains for its
 * customers). Anyone else gets their own org: an organizationId in the body
 * that isn't theirs is refused, and an absent one defaults to the caller's org
 * (the CLI sends none, which used to leave the domain with no owner at all).
 */
export async function resolveDomainOwner(
  ctx: AuthContext | null | undefined,
  requestedOrg: string | null | undefined,
  deps: AccessDeps = {}
): Promise<{ ok: true; organizationId?: string } | { ok: false; status: 403; message: string }> {
  if (isPrivileged(ctx)) return { ok: true, organizationId: requestedOrg || undefined };
  const orgs = await callerOrgIds(ctx, deps.lookupUserOrgs);
  if (requestedOrg) {
    return orgs.has(requestedOrg)
      ? { ok: true, organizationId: requestedOrg }
      : { ok: false, status: 403, message: "organizationId is not one of your organizations" };
  }
  return { ok: true, organizationId: ctx?.apiKey?.organizationId || ctx?.organization?.id || undefined };
}

async function findTunnelsByRef(ref: string): Promise<Array<{ organizationId?: string }>> {
  const { getCollections } = await import("./mongodb");
  return await getCollections()
    .tunnels.find({ $or: [{ id: ref }, { domain: ref }] }, { projection: { organizationId: 1 } })
    .toArray() as Array<{ organizationId?: string }>;
}

/** A JSON error response for a denied decision. */
export function accessDeniedResponse(decision: Exclude<AccessDecision, { allowed: true }>): Response {
  return new Response(
    JSON.stringify({ success: false, message: decision.message }),
    { status: decision.status, headers: { "Content-Type": "application/json" } }
  );
}
