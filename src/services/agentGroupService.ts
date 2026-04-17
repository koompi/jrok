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

// Short-lived cache for isGroupedDomain checks — eliminates MongoDB query on every request.
// TTL is intentionally short (5s) so that newly created/deleted groups are picked up quickly.
const groupedDomainCache = new Map<string, { result: boolean; expires: number }>();
const GROUP_DOMAIN_CACHE_TTL = 5_000; // 5 seconds

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

  // Update group's agent list and count
  await collections.agentGroups.updateOne(
    { id: groupId },
    {
      $addToSet: { agentIds: agentId },
      $inc: { activeAgentCount: 1 },
      $set: { updatedAt: Date.now() }
    }
  );

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
export async function incrementMemberConnections(agentId: string): Promise<void> {
  const collections = getCollections();
  await collections.agentGroupMembers.updateOne(
    { agentId },
    { $inc: { activeConnections: 1 } }
  );
}

/**
 * Decrement active connections for a member
 */
export async function decrementMemberConnections(agentId: string): Promise<void> {
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
  const healthyMembers = await getHealthyGroupMembers(group.id);

  console.log(`⚖️  Load balancer: domain=${domain}, strategy=${group.strategy}, healthyMembers=${healthyMembers.length}`);
  healthyMembers.forEach((m, i) => {
    console.log(`   [${i}] instanceId=${m.instanceId}, agentId=${m.agentId}`);
  });

  if (healthyMembers.length === 0) {
    console.warn(`⚠️ No healthy agents in group for domain: ${domain}`);
    return null;
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
    // Track connection for least-connections strategy
    await incrementMemberConnections(selectedMember.agentId);
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
