import type { AgentGroup, AgentGroupMember, Agent, LoadBalanceStrategy } from "../types/index";
import { getCollections } from "../utils/mongodb";
import type { Collection } from "mongodb";
import { generateId } from "../utils/helpers";
import * as agentService from "./agentService";
import { StaleCache } from "../utils/staleCache";

// =============================================================================
// MULTI-AGENT GROUP SERVICE
// =============================================================================
// Provides load balancing across multiple agents sharing the same domain.
// Supports round-robin, least-connections, random, and weighted strategies.
// =============================================================================

// Local cache for round-robin counters (per group)
const roundRobinCounters = new Map<string, number>();
// Round-robin position among the replicas connected to THIS server, per domain.
const localRoundRobin = new Map<string, number>();

function hasMembers(group: AgentGroup | null): boolean {
  return !!group && (group.agentIds?.length > 0 || group.activeAgentCount > 0);
}

// Whether a domain is grouped, for domains with no replica connected here
// (with one, its own record answers: see isGroupedDomain). Changes made in this
// process store their result directly, so the TTL only bounds how long a change
// made on another server takes to be seen here. An expired answer is served
// while it reloads, and kept if MongoDB fails (StaleCache).
const groupedDomainCache = new StaleCache<string, boolean>(
  "group lookup",
  async (domain) => hasMembers(await getGroupByDomain(domain)),
  60_000,
);

// The group document itself (id + strategy), read by selectAgent on every
// request through a grouped domain. Same rules as above.
const groupCache = new StaleCache<string, AgentGroup | null>(
  "group document",
  (domain) => getGroupByDomain(domain),
  30_000,
);

/** Record a group as this process just wrote it, instead of re-reading it. */
function rememberGroup(domain: string, group: AgentGroup | null): void {
  groupCache.set(domain, group);
  groupedDomainCache.set(domain, hasMembers(group));
}

function getGroupByDomainCached(domain: string): Promise<AgentGroup | null> {
  return groupCache.get(domain);
}

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
  const { group, created } = await upsertGroup(getCollections().agentGroups, domain, organizationId, strategy);
  rememberGroup(domain, group); // so the next request sees the new group
  if (created) console.log(`✅ Created agent group for domain: ${domain}`);
  return group;
}

/**
 * The domain's group, created if missing, in one atomic step. It used to find,
 * then insert: when a domain's replicas registered together (a new service,
 * or every replica coming back after an edge restart), all but one insert hit
 * the unique index on `domain` and those agents were disconnected (288 of 300
 * on staging). MongoDB retries an upsert that races on a unique index itself;
 * the duplicate-key catch is for servers that don't.
 */
export async function upsertGroup(
  groups: Collection,
  domain: string,
  organizationId?: string,
  strategy: LoadBalanceStrategy = 'round-robin'
): Promise<{ group: AgentGroup; created: boolean }> {
  const id = generateId();
  const now = Date.now();
  const fresh: Omit<AgentGroup, 'domain'> = {
    id,
    organizationId,
    strategy,
    agentIds: [],
    activeAgentCount: 0,
    createdAt: now,
    updatedAt: now,
    currentIndex: 0,
    healthCheckEnabled: true,
    healthCheckInterval: 30000,
  };

  let group: AgentGroup | null = null;
  try {
    group = await groups.findOneAndUpdate(
      { domain },
      { $setOnInsert: fresh },
      { upsert: true, returnDocument: 'after' }
    ) as unknown as AgentGroup | null;
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
  }
  group ??= await groups.findOne({ domain }) as unknown as AgentGroup | null;
  if (!group) throw new Error(`Could not create the agent group for ${domain}`);
  return { group, created: group.id === id };
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
  // A replica connected here says so itself (it registered in group mode), so
  // a domain served by this server never waits on MongoDB for this.
  const local = agentService.getLocalAgentsForDomain(domain);
  if (local.length > 0) return local.some((agent) => agent.groupMode === true);

  return groupedDomainCache.get(domain);
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
    rememberGroup(group.domain, null);
    localRoundRobin.delete(group.domain);
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
  // updateOne) so we get the group back without a second query — the
  // isGroupedDomain cache must be updated here, not just in getOrCreateGroup:
  // creating a group leaves it with zero agents, so a request arriving in
  // between caches "not a group" and would otherwise keep routing around the
  // load balancer until the entry expired.
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
    rememberGroup(updated.domain, updated as unknown as AgentGroup);
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
    rememberGroup(updateResult.domain, updateResult as unknown as AgentGroup);
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
  // FAST PATH (no MongoDB): pick among the replicas connected to THIS server.
  // This runs on every request to every kconsole HTTP tunnel. It used to read
  // the group, its healthy members and the chosen agent's record — three
  // queries per request — competing with the writes that keep tunnels alive
  // (see Fix-065). A request only gets here when this server holds a live
  // socket for the domain (findServerForDomain), so local replicas are the
  // right candidates; picking a member on another server only led to it being
  // marked unhealthy below.
  //
  // An open socket is the health signal: the stored `healthy` flag is only
  // ever cleared when a member's socket isn't open, and the self-heal branch
  // below already treats an open socket as healthy.
  //
  // The group document only supplies the strategy, and this never waits on
  // MongoDB for it: the last known copy is used (reloaded in the background,
  // kept if MongoDB fails), and until the first copy arrives the default,
  // round-robin, applies. Every kconsole group is round-robin. On staging, the
  // request that found this cache expired while MongoDB was unreachable waited
  // 10 s and got a 500, and so did every request after it.
  //
  // least-connections and weighted read counters/weights stored per member,
  // so they keep using the stored members (and MongoDB). Nothing sets them.
  // Replicas that went quiet (machine likely gone) get no new requests while
  // another is answering (agentService.getResponsiveLocalAgents).
  const local = agentService.getResponsiveLocalAgents(domain);
  if (local.length > 0) {
    const strategy = groupCache.getNow(domain)?.strategy ?? 'round-robin';
    if (strategy !== 'least-connections' && strategy !== 'weighted') {
      if (strategy === 'random') {
        return local[Math.floor(Math.random() * local.length)] ?? null;
      }
      const index = localRoundRobin.get(domain) ?? 0;
      localRoundRobin.set(domain, (index + 1) % local.length);
      return local[index % local.length] ?? null;
    }
  }

  const group = await getGroupByDomainCached(domain);

  // If no group exists, fall back to single-agent lookup
  if (!group) {
    return agentService.getAgentByDomainAsync(domain);
  }

  // Get healthy members
  let healthyMembers = await getHealthyGroupMembers(group.id);

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
  // Get current index from local cache or database
  let currentIndex = roundRobinCounters.get(group.id) ?? group.currentIndex ?? 0;

  // Select member
  const selectedMember = members[currentIndex % members.length];

  // Increment and wrap index. Not written back to MongoDB: the old "sync every
  // 10 requests" tested the wrapped index, so a one-replica group wrote on
  // every request and a two-replica group on every other one. A position that
  // restarts at 0 after a server restart costs nothing.
  const nextIndex = (currentIndex + 1) % members.length;
  roundRobinCounters.set(group.id, nextIndex);

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
  const updated = await collections.agentGroups.findOneAndUpdate(
    { id: groupId },
    { $set: { strategy, updatedAt: Date.now() } },
    { returnDocument: 'after' }
  );
  if (updated?.domain) {
    rememberGroup(updated.domain, updated as unknown as AgentGroup);
  }
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
