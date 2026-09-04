/**
 * Proxy Mode
 *
 * Jrok's role in the KOOMPI Cloud stack is a dumb, fast L7/L4 proxy. Metering,
 * quotas and pricing live in kconsole, which owns the billing data and the
 * customer relationship — duplicating those rules here only made every proxied
 * request pay for a policy decision that jrok is not the authority on.
 *
 * With proxy mode on (the default):
 *   - No plan lookups on the request path (zero MongoDB queries per request).
 *   - No per-tunnel/per-client rate limits, connection caps or bandwidth quotas.
 *   - No tunnel/domain/api-key/member limits at agent connect time.
 *   - Usage is still ACCOUNTED FOR — in-memory counters flushed to Mongo in a
 *     30s batch — because kconsole reads those records to bill. Accounting is
 *     off the hot path; enforcement is gone from it entirely.
 *
 * What stays enforced, because it is abuse control rather than plan policy and
 * costs an in-memory Map lookup:
 *   - Globally blocked IPs (admin action).
 *   - Per-tunnel IP allowlist/blocklist (a user-configured feature).
 *   - Suspensions pushed in by kconsole (see securityService.suspendOrganization),
 *     which is how a customer over quota or unpaid actually gets cut off.
 *
 * Set JROK_PROXY_MODE=false to restore the legacy self-contained behaviour,
 * where jrok enforces its own plans (useful for standalone/self-hosted use).
 */
export const PROXY_MODE = process.env.JROK_PROXY_MODE !== "false";

/** True when jrok should enforce its own plan limits (legacy standalone mode). */
export const ENFORCE_PLAN_LIMITS = !PROXY_MODE;
