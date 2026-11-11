/**
 * Self-serve accounts (JROK_SELF_SERVE).
 *
 * jrok's names (<name>.public.koompi.cloud) and custom domains are one
 * namespace shared by everyone on the edges. With self-serve open, anyone with
 * a KOOMPI ID could sign in to jrok directly, make an organization and an API
 * key with tunnel:create, and then claim any free name under KOOMPI Cloud's
 * domain (phishing), or a name a KOOMPI Cloud customer was about to pick:
 * kconsole checks only its own services, and jrok then refused kconsole's agent
 * for that name.
 *
 * JROK_SELF_SERVE=off (production; Ansible's default) closes that:
 *   - a new account starts pending, as with the waiting list. It can sign in,
 *     but has no organization and can't make one; a super-admin approves it,
 *     or an admin of KOOMPI Cloud's organization adds it as a member;
 *   - only super-admins create organizations;
 *   - API keys are created only in KOOMPI Cloud's own organization (the
 *     platform orgs, JROK_IMPERSONATION_ORG_IDS), by its owners and admins; a
 *     super-admin still may in any organization they own or administer.
 * Existing accounts, organizations and keys keep working; rotating a key is
 * allowed (it grants nothing new). kconsole needs none of this: it works with
 * its own platform key.
 *
 * Unset or anything else: open, as before (self-hosted jrok).
 */
import type { User } from "../types/index";
import { impersonationOrgIds } from "./impersonation";

export function selfServeOpen(): boolean {
  return (process.env.JROK_SELF_SERVE || "").trim().toLowerCase() !== "off";
}

/** KOOMPI Cloud's own organization(s) on this jrok: the platform orgs. */
export function isPlatformOrg(organizationId: string | null | undefined): boolean {
  return !!organizationId && impersonationOrgIds().has(organizationId);
}

export const SELF_SERVE_CLOSED =
  "jrok accounts are managed by KOOMPI Cloud: organizations and API keys aren't created here. Use KOOMPI Cloud (koompi.cloud).";

export type SelfServeDecision = { allowed: true } | { allowed: false; message: string };

const ALLOWED: SelfServeDecision = { allowed: true };
const CLOSED: SelfServeDecision = { allowed: false, message: SELF_SERVE_CLOSED };

/** The status a new account starts with. The first account (the super-admin) is always active. */
export function newAccountStatus(isFirstAccount: boolean, waitingListEnabled: boolean): User["status"] {
  if (isFirstAccount) return "active";
  return waitingListEnabled || !selfServeOpen() ? "pending" : "active";
}

/** May this user create an organization? */
export function mayCreateOrganization(user: Pick<User, "role">): SelfServeDecision {
  if (selfServeOpen() || user.role === "super_admin") return ALLOWED;
  return CLOSED;
}

/**
 * May this user create an API key in this organization? Membership (owner or
 * admin) is checked separately; this is only the self-serve rule.
 */
export function mayCreateApiKey(user: Pick<User, "role">, organizationId: string): SelfServeDecision {
  if (selfServeOpen() || user.role === "super_admin" || isPlatformOrg(organizationId)) return ALLOWED;
  return CLOSED;
}
