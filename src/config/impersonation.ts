/**
 * Which agent API keys may act on behalf of another organization.
 *
 * The same identity is what utils/access.ts treats as the platform key: it may
 * see and manage every org's domains, tunnel IP rules, logs and agents.
 *
 * kconsole runs every customer's tunnels with ONE platform key. For a custom
 * domain it passes `organizationId=<customer org>` so the agent passes the
 * ownership check against the domain's record; for default subdomains and TCP
 * it passes nothing and the tunnel belongs to the platform key's own org.
 *
 * This used to be granted to any key of a hard-coded org (plus any '*'/'sudo'
 * key) for ANY domain — so every key in that org, not just kconsole's, could
 * take over any organization's subdomains and custom domains. Now:
 *
 *   - impersonation is honoured only for custom domains (the one case kconsole
 *     needs); on a subdomain/TCP tunnel the requested org is ignored, and
 *   - JROK_IMPERSONATION_KEY_IDS pins it to specific key ids (kconsole's). When
 *     unset, the previous org-based rule applies, with the org list now
 *     configurable via JROK_IMPERSONATION_ORG_IDS ("none" disables it).
 */

/** KOOMPI Cloud's org on the managed jrok — the value that used to be hard-coded. */
export const DEFAULT_IMPERSONATION_ORG_IDS = ["af9ef06c-d009-4ed4-8d13-017622ac2014"];

function csv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function impersonationOrgIds(): Set<string> {
  const raw = process.env.JROK_IMPERSONATION_ORG_IDS;
  if (raw === undefined) return new Set(DEFAULT_IMPERSONATION_ORG_IDS);
  if (raw.trim().toLowerCase() === "none") return new Set();
  return new Set(csv(raw));
}

export function impersonationKeyIds(): Set<string> {
  return new Set(csv(process.env.JROK_IMPERSONATION_KEY_IDS));
}

export interface AgentKeyIdentity {
  organizationId?: string;
  apiKeyId?: string;
  permissions?: string[];
}

/** May this key speak for an organization other than its own? */
export function canImpersonate(key: AgentKeyIdentity): boolean {
  const keyIds = impersonationKeyIds();
  if (keyIds.size > 0) {
    return !!key.apiKeyId && keyIds.has(key.apiKeyId);
  }
  // '*' and 'sudo' can't be granted through the API (organizationHandler
  // filters permissions), so a key holding them was provisioned by an operator.
  return (
    (!!key.organizationId && impersonationOrgIds().has(key.organizationId)) ||
    !!key.permissions?.includes("*") ||
    !!key.permissions?.includes("sudo")
  );
}

export type ImpersonationDecision =
  | { action: "own-org"; organizationId?: string }
  | { action: "impersonate"; organizationId: string }
  | { action: "ignore"; organizationId?: string }
  | { action: "deny" };

/**
 * The org an agent connection runs as.
 *
 * @param key           the authenticated key
 * @param requestedOrg  `organizationId` from the handshake, if any
 * @param customDomain  whether the requested domain is a custom domain
 */
export function resolveAgentOrg(
  key: AgentKeyIdentity,
  requestedOrg: string | null | undefined,
  customDomain: boolean
): ImpersonationDecision {
  if (!requestedOrg || requestedOrg === key.organizationId) {
    return { action: "own-org", organizationId: key.organizationId };
  }
  if (!canImpersonate(key)) return { action: "deny" };
  if (!customDomain) {
    // Not something kconsole asks for, and the one case where acting as
    // another org would let a key take over that org's existing subdomain.
    // Ignored rather than refused so an old caller still gets its tunnel.
    return { action: "ignore", organizationId: key.organizationId };
  }
  return { action: "impersonate", organizationId: requestedOrg };
}
