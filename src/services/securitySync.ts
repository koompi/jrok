/**
 * Security rules that must be the same on every server (P4, P5 in
 * docs/plans/jrok-scale-out-plan.md).
 *
 * An API call lands on one server, but visitors arrive at all of them. On
 * staging, an allowlist set through one edge was enforced nowhere: the edge
 * holding the agent never heard of it. Admin IP blocks and suspensions lived
 * only in the memory of the server that took the call, and a restart lost them.
 *
 * Every server now re-reads what changed every SYNC_INTERVAL_MS:
 * - per-tunnel IP rules, from `tunnels` (ipSecurityChangedAt);
 * - admin IP blocks and suspensions, from `securityRules`.
 * Change times come from MongoDB's clock ($currentDate), never a server's.
 *
 * Automatic abuse blocks (securityService.detectAbuse) stay local on purpose:
 * each server judges the traffic it sees.
 *
 * If MongoDB is unreachable, the rules already loaded stay in force and the
 * next successful sync catches up.
 */
import { getCollections } from "../utils/mongodb";
import * as securityService from "./securityService";

export type SecurityRuleKind = "block-ip" | "suspend-org" | "suspend-domain";

interface SecurityRule {
  kind: SecurityRuleKind;
  key: string;
  active: boolean;
  reason?: string;
  expiresAt?: number; // block-ip only
  updatedAt: Date;
}

const SYNC_INTERVAL_MS = 10_000;
// Re-read a little before the last change seen: two writes can commit out of
// order around the same instant. Applying a rule twice is harmless.
const OVERLAP_MS = 2_000;

let lastTunnelChange: Date | null = null;
let lastRuleChange: Date | null = null;
let syncTimer: Timer | null = null;
let syncing = false;
// Version (updatedAt) of each rule last applied here, so the overlap doesn't
// re-apply (and re-log) the same rule on every sync.
const appliedVersions = new Map<string, number>();

function applyRule(rule: SecurityRule): void {
  switch (rule.kind) {
    case "block-ip":
      if (rule.active && (rule.expiresAt ?? 0) > Date.now()) {
        const seconds = Math.ceil(((rule.expiresAt ?? 0) - Date.now()) / 1000);
        securityService.blockIp(rule.key, rule.reason || "Blocked", seconds);
      } else {
        securityService.unblockIp(rule.key);
      }
      break;
    case "suspend-org":
      if (rule.active) securityService.suspendOrganization(rule.key, rule.reason);
      else securityService.unsuspendOrganization(rule.key);
      break;
    case "suspend-domain":
      if (rule.active) securityService.suspendDomain(rule.key, rule.reason);
      else securityService.unsuspendDomain(rule.key);
      break;
  }
}

/**
 * Save a rule for every server and apply it here at once. Throws if MongoDB
 * can't take it: the caller must report that, since the other servers won't
 * enforce it.
 */
export async function setRule(
  kind: SecurityRuleKind,
  key: string,
  active: boolean,
  options: { reason?: string; durationSeconds?: number } = {}
): Promise<void> {
  const rule: Omit<SecurityRule, "updatedAt"> = { kind, key, active, reason: options.reason };
  if (kind === "block-ip") rule.expiresAt = Date.now() + (options.durationSeconds ?? 3600) * 1000;

  applyRule({ ...rule, updatedAt: new Date() });
  await getCollections().securityRules.updateOne(
    { kind, key },
    { $set: rule, $currentDate: { updatedAt: true } },
    { upsert: true }
  );
}

const since = (last: Date | null) => (last ? { $gt: new Date(last.getTime() - OVERLAP_MS) } : { $exists: true });

const newest = (current: Date | null, seen: unknown): Date | null =>
  seen instanceof Date && (!current || seen > current) ? seen : current;

/** Read and apply everything changed since the last sync (everything, the first time). */
export async function syncSecurityRules(): Promise<{ tunnels: number; rules: number }> {
  const collections = getCollections();

  const tunnels = await collections.tunnels
    .find({ ipSecurityChangedAt: since(lastTunnelChange) }, { projection: { id: 1, domain: 1, ipSecurity: 1, ipSecurityChangedAt: 1 } })
    .toArray();
  for (const tunnel of tunnels) {
    securityService.applyTunnelIpSecurity(tunnel);
    lastTunnelChange = newest(lastTunnelChange, tunnel.ipSecurityChangedAt);
  }

  const rules = (await collections.securityRules
    .find({ updatedAt: since(lastRuleChange) })
    .toArray()) as unknown as SecurityRule[];
  for (const rule of rules) {
    const id = `${rule.kind}:${rule.key}`;
    const version = rule.updatedAt instanceof Date ? rule.updatedAt.getTime() : 0;
    if (appliedVersions.get(id) !== version) {
      applyRule(rule);
      appliedVersions.set(id, version);
    }
    lastRuleChange = newest(lastRuleChange, rule.updatedAt);
  }

  return { tunnels: tunnels.length, rules: rules.length };
}

/** First full load, then a sync every SYNC_INTERVAL_MS. */
export async function startSecuritySync(): Promise<void> {
  try {
    const loaded = await syncSecurityRules();
    console.log(`🔐 Shared security rules loaded: ${loaded.rules} rule(s), ${loaded.tunnels} tunnel IP rule(s) with change times`);
  } catch (error: any) {
    console.error("⚠️ Shared security rules not loaded yet:", error?.message || error);
  }

  syncTimer = setInterval(async () => {
    if (syncing) return;
    syncing = true;
    try {
      await syncSecurityRules();
    } catch {
      // Keep enforcing what is loaded; the next sync catches up.
    } finally {
      syncing = false;
    }
  }, SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}

export function stopSecuritySync(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

/** For tests: forget what has been seen, as a fresh server would. */
export function resetSecuritySync(): void {
  lastTunnelChange = null;
  lastRuleChange = null;
  appliedVersions.clear();
}
