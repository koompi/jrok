/**
 * Plan Limit Enforcement Service
 * 
 * Centralized service for checking and enforcing plan-based limits
 * for organizations. This ensures users can't exceed their plan's
 * tunnel, domain, bandwidth, and other resource limits.
 */

import { getCollections } from "../utils/mongodb";
import * as securityService from "./securityService";
import type { Plan, PlanLimits, Organization } from "../types/index";

// Cache for plan info to avoid repeated DB lookups
const planCache = new Map<string, { plan: Plan; timestamp: number }>();
const PLAN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fully-resolved plan info per organization, so the hot path costs no queries
// at all. Bounded by organization count, so it needs no eviction sweep.
//
// TTL is short because this gates rate limits and bandwidth quotas: an upgrade
// should take effect promptly, and a downgrade shouldn't stay unenforced for
// long. Call invalidateOrgPlan() to make a change visible immediately.
const orgPlanCache = new Map<string, { info: PlanInfo; timestamp: number }>();
const ORG_PLAN_CACHE_TTL = 60 * 1000; // 1 minute

/**
 * Drop the cached plan for an organization (or all of them). Call after a
 * subscription changes so the new tier applies without waiting out the TTL.
 */
export function invalidateOrgPlan(organizationId?: string): void {
  if (organizationId) {
    orgPlanCache.delete(organizationId);
  } else {
    orgPlanCache.clear();
  }
}

// Default limits for free plan (fallback)
const DEFAULT_FREE_LIMITS: PlanLimits = {
  maxTunnels: 1,
  maxDomains: 1,
  maxApiKeys: 3,
  maxMembers: 2,
  maxBandwidthGb: 1,
  sslIncluded: true,
  customDomains: false,
  prioritySupport: false,
  maxHttpRequestsPerMinute: 100,
  maxHttpRequestsPerHour: 3000,
  maxTcpConnectionsPerTunnel: 5000,
  maxTcpConnectionsPerOrg: 20000,
  maxTcpBandwidthMbPerMinute: 10,
};

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  current: number;
  limit: number;
  percentUsed: number;
}

export interface PlanInfo {
  plan: Plan | null;
  limits: PlanLimits;
  tier: string;
}

/**
 * Get plan information for an organization
 */
/**
 * Get plan information for an organization
 */
export async function getOrganizationPlan(organizationId: string): Promise<PlanInfo> {
  // Serve the fully-resolved answer from cache when it's fresh.
  //
  // This runs on EVERY tunneled request, and planCache below only covers the
  // plan document — the subscription lookup in front of it was uncached, and
  // ran TWICE whenever the org id is a Mongo ObjectId (the string match misses,
  // then the ObjectId match runs). Worst of all, an org with no subscription at
  // all — the free tier, i.e. most of them — paid both queries on every request
  // only to be told 'free' again.
  //
  // Those queries competed with agent heartbeat writes, and a delayed heartbeat
  // expires an agentConnections record and gets a healthy tunnel killed
  // (Fix-065). Caching here protects tunnel liveness, not just latency.
  const cachedInfo = orgPlanCache.get(organizationId);
  if (cachedInfo && Date.now() - cachedInfo.timestamp < ORG_PLAN_CACHE_TTL) {
    return cachedInfo.info;
  }

  const collections = getCollections();

  // Resolve, then cache whatever we concluded — including the negative result,
  // which is the hot path for free-tier orgs.
  const remember = (info: PlanInfo): PlanInfo => {
    orgPlanCache.set(organizationId, { info, timestamp: Date.now() });
    return info;
  };

  try {
    // Get subscription - try string ID first
    let subscription = await collections.subscriptions.findOne({
      organizationId,
      status: 'active'
    });

    // If not found, try ObjectId
    if (!subscription) {
      try {
        const { ObjectId } = await import("mongodb");
        if (ObjectId.isValid(organizationId)) {
          subscription = await collections.subscriptions.findOne({
            organizationId: new ObjectId(organizationId),
            status: 'active'
          });
        }
      } catch (e) {
        // Ignore ObjectId errors
      }
    }

    if (!subscription) {
      return remember({ plan: null, limits: DEFAULT_FREE_LIMITS, tier: 'free' });
    }

    // Check cache
    const cached = planCache.get(subscription.planId);
    if (cached && Date.now() - cached.timestamp < PLAN_CACHE_TTL) {
      return remember({
        plan: cached.plan,
        limits: cached.plan.limits || DEFAULT_FREE_LIMITS,
        tier: cached.plan.tier
      });
    }

    // Fetch plan
    const plan = await collections.plans.findOne({ id: subscription.planId }) as Plan | null;

    if (!plan) {
      return remember({ plan: null, limits: DEFAULT_FREE_LIMITS, tier: 'free' });
    }

    // Update cache
    planCache.set(subscription.planId, { plan, timestamp: Date.now() });

    return remember({
      plan,
      limits: plan.limits || DEFAULT_FREE_LIMITS,
      tier: plan.tier
    });
  } catch (error) {
    console.error("Error getting organization plan:", error);
    return { plan: null, limits: DEFAULT_FREE_LIMITS, tier: 'free' };
  }
}

/**
 * Check if organization can create a new tunnel
 */
export async function checkTunnelLimit(
  organizationId: string,
  intendedDomain?: string,
  instanceId?: string
): Promise<LimitCheckResult> {
  const collections = getCollections();
  const { limits, tier } = await getOrganizationPlan(organizationId);

  // -1 means unlimited (enterprise)
  if (limits.maxTunnels === -1) {
    return { allowed: true, current: 0, limit: -1, percentUsed: 0 };
  }

  // Count active tunnels for this org
  const tunnelCount = await collections.tunnels.countDocuments({
    organizationId,
    active: true
  });

  // Also count active agent connections (more accurate for real-time)
  // FIX: Count unique domains, not total connections, to allow load-balanced groups
  const uniqueAgentDomains = await collections.agentConnections.distinct('domain', {
    organizationId,
    active: true
  });
  const agentCount = uniqueAgentDomains.length;

  // Use the higher of the two counts
  const currentCount = Math.max(tunnelCount, agentCount);

  console.log(`[LimitCheck] Org: ${organizationId}, Domain: ${intendedDomain}, Instance: ${instanceId}`);
  console.log(`[LimitCheck] Tunnels: ${tunnelCount}, UniqueAgents: ${agentCount}, Domains: ${JSON.stringify(uniqueAgentDomains)}`);

  // FIX: 1. Also check if there is an active TUNNEL for this domain.
  // If a tunnel exists but has no agents (zombie/reconnecting), we should allowed to reconnect to it.
  const existingTunnel = await collections.tunnels.findOne({
    domain: intendedDomain,
    organizationId,
    active: true
  });

  // FIX: 2. Check if this instance already has active agents (same instance can have multiple domains/connections)
  // This allows connecting a Custom Domain to an existing instance without consumption of extra tunnel quota.
  let instanceHasActiveAgents = false;
  if (instanceId) {
    const existingInstanceAgents = await collections.agentConnections.findOne({
      organizationId,
      active: true,
      instanceId: instanceId
    });
    if (existingInstanceAgents) {
      instanceHasActiveAgents = true;
    }
  }

  // If intendedDomain is active (agent connected OR tunnel exists) OR instance is already active, bypass limit.
  if ((intendedDomain && uniqueAgentDomains.includes(intendedDomain)) || existingTunnel || instanceHasActiveAgents) {
    console.log(`[LimitCheck] Bypassing limit for existing entity: Domain=${intendedDomain}, Instance=${instanceId}`);
    return {
      allowed: true, // Allow joining existing active domain or instance
      current: currentCount,
      limit: limits.maxTunnels,
      percentUsed: (currentCount / limits.maxTunnels) * 100
    };
  }

  const allowed = currentCount < limits.maxTunnels;
  console.log(`[LimitCheck] Allowed: ${allowed} (Current: ${currentCount}, Limit: ${limits.maxTunnels})`);
  const percentUsed = (currentCount / limits.maxTunnels) * 100;

  return {
    allowed,
    reason: allowed ? undefined : `Tunnel limit reached (${limits.maxTunnels} for ${tier} plan). Upgrade your plan for more tunnels.`,
    current: currentCount,
    limit: limits.maxTunnels,
    percentUsed,
  };
}

/**
 * Check if organization can register a new custom domain
 */
export async function checkDomainLimit(organizationId: string): Promise<LimitCheckResult> {
  const collections = getCollections();
  const { limits, tier } = await getOrganizationPlan(organizationId);

  // Check if custom domains are allowed
  if (!limits.customDomains && tier === 'free') {
    return {
      allowed: false,
      reason: "Custom domains are not available on the free plan. Upgrade to use custom domains.",
      current: 0,
      limit: 0,
      percentUsed: 100,
    };
  }

  // -1 means unlimited
  if (limits.maxDomains === -1) {
    return { allowed: true, current: 0, limit: -1, percentUsed: 0 };
  }

  // Count custom domains for this org
  const domainCount = await collections.customDomains.countDocuments({
    organizationId,
    active: true,
  });

  const allowed = domainCount < limits.maxDomains;
  const percentUsed = (domainCount / limits.maxDomains) * 100;

  return {
    allowed,
    reason: allowed ? undefined : `Domain limit reached (${limits.maxDomains} for ${tier} plan). Upgrade your plan for more domains.`,
    current: domainCount,
    limit: limits.maxDomains,
    percentUsed,
  };
}

/**
 * Check if organization can create a new API key
 */
export async function checkApiKeyLimit(organizationId: string): Promise<LimitCheckResult> {
  const collections = getCollections();
  const { limits, tier } = await getOrganizationPlan(organizationId);

  // -1 means unlimited
  if (limits.maxApiKeys === -1) {
    return { allowed: true, current: 0, limit: -1, percentUsed: 0 };
  }

  // Count active API keys for this org
  const keyCount = await collections.apiKeys.countDocuments({
    organizationId,
    isActive: true,
  });

  const allowed = keyCount < limits.maxApiKeys;
  const percentUsed = (keyCount / limits.maxApiKeys) * 100;

  return {
    allowed,
    reason: allowed ? undefined : `API key limit reached (${limits.maxApiKeys} for ${tier} plan). Upgrade your plan for more API keys.`,
    current: keyCount,
    limit: limits.maxApiKeys,
    percentUsed,
  };
}

/**
 * Check if organization can add a new member
 */
export async function checkMemberLimit(organizationId: string): Promise<LimitCheckResult> {
  const collections = getCollections();
  const { limits, tier } = await getOrganizationPlan(organizationId);

  // -1 means unlimited
  if (limits.maxMembers === -1) {
    return { allowed: true, current: 0, limit: -1, percentUsed: 0 };
  }

  // Get current member count from organization
  const org = await collections.organizations.findOne({ id: organizationId }) as Organization | null;
  const memberCount = org?.members?.length || 0;

  const allowed = memberCount < limits.maxMembers;
  const percentUsed = (memberCount / limits.maxMembers) * 100;

  return {
    allowed,
    reason: allowed ? undefined : `Member limit reached (${limits.maxMembers} for ${tier} plan). Upgrade your plan for more members.`,
    current: memberCount,
    limit: limits.maxMembers,
    percentUsed,
  };
}

/**
 * Check monthly bandwidth limit and suspend if exceeded
 */
export async function checkBandwidthLimit(
  organizationId: string,
  additionalBytes: number = 0
): Promise<LimitCheckResult & { suspended: boolean }> {
  const { limits, tier } = await getOrganizationPlan(organizationId);

  // -1 means unlimited (enterprise)
  if (limits.maxBandwidthGb === -1) {
    return { allowed: true, suspended: false, current: 0, limit: -1, percentUsed: 0 };
  }

  // Get current usage from securityService
  const bandwidthCheck = securityService.checkMonthlyBandwidth(organizationId, tier);

  // Calculate with additional bytes
  const totalBytes = bandwidthCheck.usedBytes + additionalBytes;
  const limitBytes = limits.maxBandwidthGb * 1024 * 1024 * 1024;
  const percentUsed = (totalBytes / limitBytes) * 100;

  const allowed = totalBytes < limitBytes;

  // If exceeded, we could suspend - but for now just block new requests
  const suspended = percentUsed >= 100;

  return {
    allowed,
    suspended,
    reason: allowed ? undefined : `Monthly bandwidth limit exceeded (${limits.maxBandwidthGb}GB for ${tier} plan). Upgrade your plan or wait until next month.`,
    current: Math.round(totalBytes / (1024 * 1024 * 1024) * 100) / 100, // GB
    limit: limits.maxBandwidthGb,
    percentUsed,
  };
}

/**
 * Get complete limit status for an organization
 */
export async function getOrganizationLimitStatus(organizationId: string): Promise<{
  plan: PlanInfo;
  tunnels: LimitCheckResult;
  domains: LimitCheckResult;
  apiKeys: LimitCheckResult;
  members: LimitCheckResult;
  bandwidth: LimitCheckResult & { suspended: boolean };
}> {
  const [plan, tunnels, domains, apiKeys, members, bandwidth] = await Promise.all([
    getOrganizationPlan(organizationId),
    checkTunnelLimit(organizationId),
    checkDomainLimit(organizationId),
    checkApiKeyLimit(organizationId),
    checkMemberLimit(organizationId),
    checkBandwidthLimit(organizationId),
  ]);

  return { plan, tunnels, domains, apiKeys, members, bandwidth };
}

/**
 * Clear plan cache (call when plan is upgraded)
 */
export function clearPlanCache(organizationId?: string): void {
  if (organizationId) {
    // Clear specific org's cache would require subscription lookup
    // For simplicity, just clear all
    planCache.clear();
  } else {
    planCache.clear();
  }
}
