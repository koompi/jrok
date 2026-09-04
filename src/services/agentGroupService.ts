import type { AgentGroup, AgentGroupMember, Agent, LoadBalanceStrategy } from "../types/index";
import { getCollections } from "../utils/mongodb";
import { generateId } from "../utils/helpers";
import * as agentService from "./agentService";

// =============================================================================
// MULTI-AGENT GROUP SERVICE
// =============================================================================
// Provides load balancing across multiple agents sharing the same domain.
// Supports round-robin, least-connections, random, and weighted strategies.
// =============================================================================

// Local cache for round-robin counters (per group)
const roundRobinCounters = new Map<string, number>();

// Cache for isGroupedDomain checks — eliminates a MongoDB query on every request.
// Both group creation (createOrJoinGroup) and deletion invalidate the entry for
// their domain, so the TTL only has to cover changes made outside this process
// (another node in the cluster); it does not need to be short for correctness.
// It used to be 5s, which meant one request in every 5-second window per domain
// still paid a database round trip on the proxy path for no benefit.
const groupedDomainCache = new Map<string, { result: boolean; expires: number }>();
const GROUP_DOMAIN_CACHE_TTL = 60_000; // 60 seconds

// =============================================================================
// GROUP MANAGEMENT
// =============================================================================

/**
 * Create or get an existing agent group for a domain
 */
export async function getOrCreateGroup(
  domain: string,
  organizationId?: string,
  strategy: LoadBalanceStrategy = 'round-robin'
): Promise<AgentGroup> {
  const collections = getCollections();

  // Try to find existing group
  const existing = await collections.agentGroups.findOne({ domain });
  if (existing) {
    return existing as unknown as AgentGroup;
  }

  // Create new group
  const group: AgentGroup = {
    id: generateId(),
    domain,
    organizationId,
    strategy,
    agentIds: [],
    activeAgentCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentIndex: 0,
    healthCheckEnabled: true,
    healthCheckInterval: 30000,
  };

  await collections.agentGroups.insertOne(group);
  groupedDomainCache.delete(domain); // invalidate so next request sees the new group
  console.log(`✅ Created agent group for domain: ${domain}`);

  return group;
}

/**
 * Get agent group by domain
 */
export async function getGroupByDomain(domain: string): Promise<AgentGroup | null> {
  const collections = getCollections();
  const group = await collections.agentGroups.findOne({ domain });
  return group as unknown as AgentGroup | null;
}

/**
 * Get agent group by ID
 */
export async function getGroupById(groupId: string): Promise<AgentGroup | null> {
  const collections = getCollections();
  const group = await collections.agentGroups.findOne({ id: groupId });
  return group as unknown as AgentGroup | null;
}

/**
 * Check if a domain has a multi-agent group
 */
export async function isGroupedDomain(domain: string): Promise<boolean> {
  // Check short-lived cache first to avoid MongoDB query on every request
  const cached = groupedDomainCache.get(domain);
  if (cached && Date.now() < cached.expires) {
    return cached.result;
  }

  const collections = getCollections();
  const group = await collections.agentGroups.findOne({ domain });
  const result = !!group && (group.agentIds?.length > 0 || group.activeAgentCount > 0);

  groupedDomainCache.set(domain, { result, expires: Date.now() + GROUP_DOMAIN_CACHE_TTL });
  return result;
}

/**
 * Delete an agent group (when all agents leave)
 */
export async function deleteGroup(groupId: string): Promise<void> {
  const collections = getCollections();

  // Fetch domain before deleting (needed for cache invalidation)
  const group = await collections.agentGroups.findOne({ id: groupId });

  // Remove all members first
  await collections.agentGroupMembers.deleteMany({ groupId });

  // Remove the group
  await collections.agentGroups.deleteOne({ id: groupId });

  // Clean up local caches
  roundRobinCounters.delete(groupId);
  if (group?.domain) {
    groupedDomainCache.delete(group.domain);
  }

  console.log(`🗑️ Deleted agent group: ${groupId}`);
}

// =============================================================================
// MEMBER MANAGEMENT
// =============================================================================

/**
 * Add an agent to a group
 */
export async function addAgentToGroup(
  groupId: string,
  agentId: string,
  instanceId: string,
  weight: number = 1
): Promise<AgentGroupMember> {
  const collections = getCollections();

  const member: AgentGroupMember = {
    agentId,
    instanceId,
    weight: Math.max(1, Math.min(100, weight)), // Clamp to 1-100
    healthy: true,
    lastHealthCheck: Date.now(),
    activeConnections: 0,
    joinedAt: Date.now(),
  };

  // Upsert member by groupId + instanceId (instance IDs are stable across reconnections)
  // This ensures container-1 always maps to the same member record
  await collections.agentGroupMembers.updateOne(
    { groupId, instanceId },
    { $set: { ...member, groupId } },
    { upsert: true }
  );

  // Update group's agent list and count. findOneAndUpdate (rather than
  // updateOne) so we get the domain back without a second query — the
  // isGroupedDomain cache must be invalidated here, not just in
  // getOrCreateGroup: creating a group leaves it with zero agents, so a request
  // arriving in between caches "not a group" and would otherwise keep routing
  // around the load balancer until the entry expired.
  const updated = await collections.agentGroups.findOneAndUpdate(
    { id: groupId },
    {
      $addToSet: { agentIds: agentId },
      $inc: { activeAgentCount: 1 },
      $set: { updatedAt: Date.now() }
    },
    { returnDocument: 'after' }
  );

  if (updated?.domain) {
    groupedDomainCache.delete(updated.domain);
  }

  console.log(`➕ Agent ${agentId} (instance: ${instanceId}) joined group ${groupId}`);

  return member;
}

/**
 * Remove an agent from a group
 */
export async function removeAgentFromGroup(agentId: string): Promise<void> {
  const collections = getCollections();

  // Find the member to get the group ID
  const member = await collections.agentGroupMembers.findOne({ agentId });
  if (!member) return;

  const groupId = member.groupId;

  // Remove member
  await collections.agentGroupMembers.deleteOne({ agentId });

  // Update group
  const updateResult = await collections.agentGroups.findOneAndUpdate(
    { id: groupId },
    {
      $pull: { agentIds: agentId },
      $inc: { activeAgentCount: -1 },
      $set: { updatedAt: Date.now() }
    },
    { returnDocument: 'after' }
  );

  if (updateResult?.domain) {
    groupedDomainCache.delete(updateResult.domain);
  }

  console.log(`➖ Agent ${agentId} left group ${groupId}`);

  // If group is empty, consider deleting it
  if (updateResult && updateResult.activeAgentCount <= 0) {
    // Keep the group for a while in case agents reconnect
    // Could add TTL-based cleanup later
    console.log(`📭 Group ${groupId} is now empty`);
  }
}

/**
 * Get all members of a group
 */
export async function getGroupMembers(groupId: string): Promise<AgentGroupMember[]> {
  const collections = getCollections();
  const members = await collections.agentGroupMembers.find({ groupId }).sort({ instanceId: 1 }).toArray();
  return members as unknown as AgentGroupMember[];
}

/**
 * Get healthy members of a group
 */
export async function getHealthyGroupMembers(groupId: string): Promise<AgentGroupMember[]> {
  const collections = getCollections();
  const members = await collections.agentGroupMembers.find({
    groupId,
    healthy: true
  }).sort({ instanceId: 1 }).toArray();
  return members as unknown as AgentGroupMember[];
}

/**
 * Update member health status
 */
export async function updateMemberHealth(agentId: string, healthy: boolean): Promise<void> {
  const collections = getCollections();
  await collections.agentGroupMembers.updateOne(
    { agentId },
    {
      $set: {
        healthy,
        lastHealthCheck: Date.now()
      }
    }
  );
}

/**
 * Increment active connections for a member
 */
// Outstanding increments this process has issued, per agent. Only the
// 'least-connections' strategy reads activeConnections, so we only pay for the
// counter when something actually consumes it — but once we HAVE incremented,
// the matching decrement must still run, or the counter drifts upward forever
// and that member stops being selected. This map is what keeps the pair honest
// without needing a group lookup on the decrement path.
const outstandingConnectionIncrements = new Map<string, number>();

/**
 * Increment active connections for a member.
 *
 * No-op unless the group actually balances on connection count. This runs on
 * EVERY request through a grouped domain, and every kconsole HTTP tunnel is
 * grouped — so for the default round-robin strategy this was a MongoDB write
 * per request that nothing ever read. Paired with the decrement below, that was
 * two wasted writes per request, competing with the agent heartbeat writes whose
 * delay expires agentConnections records and gets healthy tunnels killed
 * (see Fix-065).
 */
export async function incrementMemberConnections(
  agentId: string,
  strategy?: LoadBalanceStrategy
): Promise<void> {
  if (strategy !== 'least-connections') return;

  const collections = getCollections();
  await collections.agentGroupMembers.updateOne(
    { agentId },
    { $inc: { activeConnections: 1 } }
  );
  outstandingConnectionIncrements.set(
    agentId,
    (outstandingConnectionIncrements.get(agentId) ?? 0) + 1
  );
}

/**
 * Decrement active connections for a member.
 *
 * Only writes if THIS process actually issued a matching increment, so the
 * write disappears alongside the increment for strategies that don't balance on
 * connection count — without the caller needing to know the strategy (the
 * request-completion path in index.ts doesn't, and looking it up there would
 * just trade one query for another).
 *
 * Guarding on our own outstanding count also stops the counter being driven
 * negative by unmatched decrements, which would permanently bias
 * least-connections selection toward that member.
 */
export async function decrementMemberConnections(agentId: string): Promise<void> {
  const outstanding = outstandingConnectionIncrements.get(agentId) ?? 0;
  if (outstanding <= 0) return;

  if (outstanding === 1) {
    outstandingConnectionIncrements.delete(agentId);
  } else {
    outstandingConnectionIncrements.set(agentId, outstanding - 1);
  }

  const collections = getCollections();
  await collections.agentGroupMembers.updateOne(
    { agentId },
    { $inc: { activeConnections: -1 } }
  );
}

// =============================================================================
// LOAD BALANCING
// =============================================================================

/**
 * Select the next agent for a request using the group's load balancing strategy
 * This is the main entry point for load-balanced agent selection
 */
export async function selectAgent(domain: string): Promise<Agent | null> {
  const group = await getGroupByDomain(domain);

  // If no group exists, fall back to single-agent lookup
  if (!group) {
    return agentService.getAgentByDomainAsync(domain);
  }

  // Get healthy members
  let healthyMembers = await getHealthyGroupMembers(group.id);

  console.log(`⚖️  Load balancer: domain=${domain}, strategy=${group.strategy}, healthyMembers=${healthyMembers.length}`);
  healthyMembers.forEach((m, i) => {
    console.log(`   [${i}] instanceId=${m.instanceId}, agentId=${m.agentId}`);
  });

  if (healthyMembers.length === 0) {
    // SELF-HEAL: no member is flagged healthy, but a member's agent socket may
    // actually be live — a member gets flagged unhealthy on a transient blip
    // (jrok-server restart, momentary disconnect) and nothing ever flips it back,
    // so the service serves 503 forever until a redeploy. Recover here by
    // selecting any member whose WebSocket is currently OPEN and restoring its
    // healthy flag. This branch ONLY runs when the group would otherwise return
    // null (503), so it can never make a working service worse.
    const allMembers = await getGroupMembers(group.id);
    const liveMembers = allMembers.filter((m) => {
      try {
        const ws = agentService.getAgentSocket(m.agentId);
        return !!ws && ws.readyState === 1; // 1 = WebSocket.OPEN
      } catch {
        return false;
      }
    });

    if (liveMembers.length === 0) {
      console.warn(`⚠️ No healthy agents in group for domain: ${domain}`);
      return null;
    }

    console.warn(`♻️  Self-healing ${liveMembers.length} group member(s) with live sockets for domain: ${domain}`);
    for (const m of liveMembers) {
      try {
        await updateMemberHealth(m.agentId, true);
      } catch (err) {
        console.error(`Failed to self-heal member ${m.agentId}:`, err);
      }
    }
    healthyMembers = liveMembers;
  }

  // Select agent based on strategy
  let selectedMember: AgentGroupMember;

  switch (group.strategy) {
    case 'round-robin':
      selectedMember = await selectRoundRobin(group, healthyMembers);
      break;
    case 'least-connections':
      selectedMember = selectLeastConnections(healthyMembers);
      break;
    case 'random':
      selectedMember = selectRandom(healthyMembers);
      break;
    case 'weighted':
      selectedMember = selectWeighted(healthyMembers);
      break;
    default:
      selectedMember = await selectRoundRobin(group, healthyMembers);
  }

  // Get the actual agent
  const agent = await agentService.getAgentAsync(selectedMember.agentId);

  console.log(`⚖️  Selected: instanceId=${selectedMember.instanceId}, agentId=${selectedMember.agentId}, agentFound=${!!agent}`);

  if (agent) {
    // Track connection for least-connections strategy. No-op for every other
    // strategy — nothing else reads activeConnections.
    await incrementMemberConnections(selectedMember.agentId, group.strategy);
  }

  return agent;
}

/**
 * Round-robin selection
 */
async function selectRoundRobin(
  group: AgentGroup,
  members: AgentGroupMember[]
): Promise<AgentGroupMember> {
  const collections = getCollections();

  // Get current index from local cache or database
  let currentIndex = roundRobinCounters.get(group.id) ?? group.currentIndex ?? 0;

  // Select member
  const selectedMember = members[currentIndex % members.length];

  // Increment and wrap index
  const nextIndex = (currentIndex + 1) % members.length;
  roundRobinCounters.set(group.id, nextIndex);

  // Periodically sync to database (every 10 requests)
  if (nextIndex % 10 === 0) {
    await collections.agentGroups.updateOne(
      { id: group.id },
      { $set: { currentIndex: nextIndex } }
    );
  }

  return selectedMember;
}

/**
 * Least-connections selection
 */
function selectLeastConnections(members: AgentGroupMember[]): AgentGroupMember {
  return members.reduce((min, member) =>
    member.activeConnections < min.activeConnections ? member : min
  );
}

/**
 * Random selection
 */
function selectRandom(members: AgentGroupMember[]): AgentGroupMember {
  const randomIndex = Math.floor(Math.random() * members.length);
  return members[randomIndex];
}

/**
 * Weighted random selection
 */
function selectWeighted(members: AgentGroupMember[]): AgentGroupMember {
  // Calculate total weight
  const totalWeight = members.reduce((sum, m) => sum + m.weight, 0);

  // Generate random number in range [0, totalWeight)
  let random = Math.random() * totalWeight;

  // Find the member
  for (const member of members) {
    random -= member.weight;
    if (random <= 0) {
      return member;
    }
  }

  // Fallback to first member
  return members[0];
}

// =============================================================================
// QUERY HELPERS
// =============================================================================

/**
 * Get group statistics
 */
export async function getGroupStats(groupId: string): Promise<{
  totalMembers: number;
  healthyMembers: number;
  totalConnections: number;
  strategy: LoadBalanceStrategy;
} | null> {
  const group = await getGroupById(groupId);
  if (!group) return null;

  const members = await getGroupMembers(groupId);
  const healthyMembers = members.filter(m => m.healthy);
  const totalConnections = members.reduce((sum, m) => sum + m.activeConnections, 0);

  return {
    totalMembers: members.length,
    healthyMembers: healthyMembers.length,
    totalConnections,
    strategy: group.strategy,
  };
}

/**
 * Get all groups for an organization
 */
export async function getGroupsByOrganization(organizationId: string): Promise<AgentGroup[]> {
  const collections = getCollections();
  const groups = await collections.agentGroups.find({ organizationId }).toArray();
  return groups as unknown as AgentGroup[];
}

/**
 * Update group strategy
 */
export async function updateGroupStrategy(
  groupId: string,
  strategy: LoadBalanceStrategy
): Promise<void> {
  const collections = getCollections();
  await collections.agentGroups.updateOne(
    { id: groupId },
    { $set: { strategy, updatedAt: Date.now() } }
  );
}

/**
 * Get agent's group membership info
 */
export async function getAgentGroupInfo(agentId: string): Promise<{
  group: AgentGroup;
  member: AgentGroupMember;
} | null> {
  const collections = getCollections();

  const member = await collections.agentGroupMembers.findOne({ agentId });
  if (!member) return null;

  const group = await collections.agentGroups.findOne({ id: member.groupId });
  if (!group) return null;

  return {
    group: group as unknown as AgentGroup,
    member: member as unknown as AgentGroupMember,
  };
}

// =============================================================================
// HEALTH CHECK CLEANUP
// =============================================================================

/**
 * Mark agents as unhealthy if they haven't had a heartbeat recently
 * Should be called periodically (e.g., every 30 seconds)
 */
export async function cleanupUnhealthyAgents(maxAgeMs: number = 60000): Promise<number> {
  const collections = getCollections();
  const cutoff = Date.now() - maxAgeMs;

  const result = await collections.agentGroupMembers.updateMany(
    { lastHealthCheck: { $lt: cutoff }, healthy: true },
    { $set: { healthy: false } }
  );

  if (result.modifiedCount > 0) {
    console.log(`🏥 Marked ${result.modifiedCount} agents as unhealthy`);
  }

  return result.modifiedCount;
}

/**
 * Remove stale group members that haven't had activity
 * Should be called periodically (e.g., every 5 minutes)
 */
export async function cleanupStaleMembers(maxAgeMs: number = 300000): Promise<number> {
  const collections = getCollections();
  const cutoff = Date.now() - maxAgeMs;

  // Find stale members
  const staleMembers = await collections.agentGroupMembers.find({
    lastHealthCheck: { $lt: cutoff }
  }).toArray();

  // Remove each and update their groups
  for (const member of staleMembers) {
    await removeAgentFromGroup(member.agentId);
  }

  return staleMembers.length;
}
