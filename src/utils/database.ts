import type { Tunnel, CustomDomain } from "../types/index";
import { getCollections } from "./mongodb";
import { ObjectId } from "mongodb";

// ===== IN-MEMORY CACHE FOR PERFORMANCE =====
// Avoids MongoDB queries on every proxied request

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// Cache for tunnel lookups by domain (most critical for performance)
const tunnelDomainCache = new Map<string, CacheEntry<Tunnel | null>>();
const TUNNEL_CACHE_TTL = 60_000; // 60 seconds cache TTL

// Cache for tunnel lookups by ID
const tunnelIdCache = new Map<string, CacheEntry<Tunnel | null>>();

// Cache for custom domain lookups by hostname (most critical for per-request savings)
const customDomainNameCache = new Map<string, CacheEntry<CustomDomain | null>>();
const CUSTOM_DOMAIN_CACHE_TTL = 60_000; // 60 seconds

export function invalidateCustomDomainCache(domain?: string): void {
  if (domain) {
    customDomainNameCache.delete(domain);
    domainStates.delete(domain.toLowerCase());
  } else {
    customDomainNameCache.clear();
    domainStates.clear();
  }
}

/**
 * Purge expired entries from all caches.
 * Call periodically (e.g. every 5 minutes) to prevent unbounded Map growth.
 * Especially important for customDomainNameCache which can accumulate entries
 * for every unique hostname that hits the server (bots, scanners, etc).
 */
export function purgeExpiredCaches(): void {
  const now = Date.now();
  for (const [key, entry] of tunnelDomainCache.entries()) {
    if (now - entry.timestamp > TUNNEL_CACHE_TTL) tunnelDomainCache.delete(key);
  }
  for (const [key, entry] of tunnelIdCache.entries()) {
    if (now - entry.timestamp > TUNNEL_CACHE_TTL) tunnelIdCache.delete(key);
  }
  for (const [key, entry] of customDomainNameCache.entries()) {
    if (now - entry.timestamp > CUSTOM_DOMAIN_CACHE_TTL) customDomainNameCache.delete(key);
  }
}

export function invalidateTunnelCache(domain?: string, id?: string): void {
  if (domain) tunnelDomainCache.delete(domain);
  if (id) tunnelIdCache.delete(id);
}

export function clearAllTunnelCache(): void {
  tunnelDomainCache.clear();
  tunnelIdCache.clear();
}

// ===== TUNNEL OPERATIONS =====

export async function getTunnel(id: string): Promise<Tunnel | null> {
  // Check cache first
  const cached = tunnelIdCache.get(id);
  if (cached && Date.now() - cached.timestamp < TUNNEL_CACHE_TTL) {
    return cached.data;
  }

  const collections = getCollections();
  const tunnel = await collections.tunnels.findOne({ _id: new ObjectId(id) });

  // Update cache
  tunnelIdCache.set(id, { data: tunnel as Tunnel | null, timestamp: Date.now() });

  return tunnel as Tunnel | null;
}

export async function getAllTunnels(): Promise<Tunnel[]> {
  const collections = getCollections();
  return await collections.tunnels.find({}).toArray() as Tunnel[];
}

export async function createTunnel(tunnel: Tunnel): Promise<void> {
  const collections = getCollections();
  await collections.tunnels.insertOne({
    ...tunnel,
    _id: new ObjectId(),
  });
}

export async function updateTunnel(id: string, updates: Partial<Tunnel>): Promise<void> {
  const collections = getCollections();
  await collections.tunnels.updateOne(
    { _id: new ObjectId(id) },
    { $set: updates }
  );
}

export async function deleteTunnel(id: string): Promise<void> {
  const collections = getCollections();
  await collections.tunnels.deleteOne({ _id: new ObjectId(id) });
}

export async function getActiveTunnels(): Promise<Tunnel[]> {
  const collections = getCollections();
  return await collections.tunnels.find({ active: true }).toArray() as Tunnel[];
}

export async function getTunnelByDomain(domain: string): Promise<Tunnel | null> {
  // Check cache first - critical for performance!
  const cached = tunnelDomainCache.get(domain);
  if (cached && Date.now() - cached.timestamp < TUNNEL_CACHE_TTL) {
    return cached.data;
  }

  const collections = getCollections();
  const tunnel = await collections.tunnels.findOne({ domain });

  // Update cache
  tunnelDomainCache.set(domain, { data: tunnel as Tunnel | null, timestamp: Date.now() });

  return tunnel as Tunnel | null;
}

export async function getTunnelsByAgentId(agentId: string): Promise<Tunnel[]> {
  const collections = getCollections();
  return await collections.tunnels.find({ agentId }).toArray() as Tunnel[];
}

// ===== CUSTOM DOMAIN OPERATIONS =====

export async function getCustomDomain(id: string): Promise<CustomDomain | null> {
  const collections = getCollections();
  return await collections.customDomains.findOne({ _id: new ObjectId(id) });
}

export async function getCustomDomainByName(domain: string): Promise<CustomDomain | null> {
  // Check cache first — avoids MongoDB query on every request for custom domain hostnames
  const cached = customDomainNameCache.get(domain);
  if (cached && Date.now() - cached.timestamp < CUSTOM_DOMAIN_CACHE_TTL) {
    return cached.data;
  }

  const collections = getCollections();
  const result = await collections.customDomains.findOne({ domain }) as CustomDomain | null;

  customDomainNameCache.set(domain, { data: result, timestamp: Date.now() });
  return result;
}

// ===== CUSTOM DOMAINS ON THE REQUEST PATH =====
// Every request for a name that isn't ours asks "is this an active custom
// domain?". That was a MongoDB query per name every minute, with no fallback:
// a minute into a MongoDB outage, every custom-domain request waited 10 s and
// got 503, even with its agent connected. The active set is small, so it is
// kept whole: reloaded in the background with one query when older than
// ACTIVE_CUSTOM_DOMAINS_TTL_MS, kept when a reload fails, and changed at once
// when this server activates or deletes a domain. Only the first load is waited
// for. Random Host headers from scanners cost nothing and evict nothing.
const ACTIVE_CUSTOM_DOMAINS_TTL_MS = 15_000;
let activeCustomDomains: Set<string> | null = null;
let activeCustomDomainsAt = 0;
let activeCustomDomainsLoad: Promise<Set<string>> | null = null;
let activeCustomDomainsFailing = false;

function loadActiveCustomDomains(): Promise<Set<string>> {
  if (!activeCustomDomainsLoad) {
    activeCustomDomainsLoad = (async () => {
      const docs = await getCollections().customDomains.find({ active: true }, { projection: { domain: 1 } }).toArray();
      const names = new Set<string>();
      for (const doc of docs) if (typeof doc.domain === "string") names.add(doc.domain.toLowerCase());
      activeCustomDomains = names;
      activeCustomDomainsAt = Date.now();
      if (activeCustomDomainsFailing) console.log(`✅ Custom domains reloaded (${names.size} active)`);
      activeCustomDomainsFailing = false;
      return names;
    })().finally(() => {
      activeCustomDomainsLoad = null;
    });
  }
  return activeCustomDomainsLoad;
}

/**
 * Is `hostname` an active custom domain? Answers from memory; waits on MongoDB
 * only until the first load (and throws if that fails).
 */
export async function isActiveCustomDomain(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase();
  if (activeCustomDomains === null) return (await loadActiveCustomDomains()).has(host);
  if (Date.now() - activeCustomDomainsAt >= ACTIVE_CUSTOM_DOMAINS_TTL_MS) {
    loadActiveCustomDomains().catch((error) => {
      if (!activeCustomDomainsFailing) {
        console.warn(`⚠️ Custom domains not reloaded, serving the ${activeCustomDomains?.size ?? 0} known:`, error?.message || error);
      }
      activeCustomDomainsFailing = true;
    });
  }
  return activeCustomDomains.has(host);
}

/** This server changed a domain: the set follows at once (other servers on their next reload). */
function noteCustomDomain(domain: string | undefined, active: boolean | undefined): void {
  if (!domain) domainStates.clear();
  if (!activeCustomDomains) return;
  if (!domain || active === undefined) {
    activeCustomDomainsAt = 0; // which one isn't known here: reload on the next request
    return;
  }
  if (active) activeCustomDomains.add(domain.toLowerCase());
  else activeCustomDomains.delete(domain.toLowerCase());
}

/**
 * Reload the set now, e.g. when another server's new certificate for a custom
 * domain lands here: that server has just activated the domain (or is about
 * to), and this one would otherwise answer from the old set for up to
 * ACTIVE_CUSTOM_DOMAINS_TTL_MS. On 2026-11-07 that sent koompi.com's visitors
 * to jrok's API (401) for 20 s on an edge that already had its certificate.
 */
export async function reloadActiveCustomDomains(): Promise<void> {
  if (activeCustomDomains === null) return; // nothing asked yet: the first request loads it
  await loadActiveCustomDomains();
}

/** For tests: forget the set, as a server that just started. */
export function resetActiveCustomDomains(): void {
  activeCustomDomains = null;
  activeCustomDomainsAt = 0;
  activeCustomDomainsLoad = null;
  activeCustomDomainsFailing = false;
  domainStates.clear();
}

// ===== A NAME THE SET DOESN'T HAVE, OPENED IN A BROWSER =====
// The set can lag another server's activation, and a name it doesn't have
// used to go to jrok's API, which answered a visitor with {"message":
// "Unauthorized"}. For a browser opening a page, the name is looked up in
// MongoDB (one indexed query per name every DOMAIN_STATE_TTL_MS) to tell
// "active after all" (route it, and add it to the set), "added but not
// verified yet" and "no app uses it" apart. Scripts and API clients never
// trigger the lookup.
export type CustomDomainState = "active" | "pending" | "none";

const DOMAIN_STATE_TTL_MS = 10_000;
const DOMAIN_STATE_MAX = 10_000;
const domainStates = new Map<string, { state: CustomDomainState; at: number }>();

/** What `hostname` is, from MongoDB (cached briefly). Throws if MongoDB can't be reached. */
export async function customDomainState(hostname: string): Promise<CustomDomainState> {
  const host = hostname.toLowerCase();
  const cached = domainStates.get(host);
  if (cached && Date.now() - cached.at < DOMAIN_STATE_TTL_MS) return cached.state;

  const doc = await getCollections().customDomains.findOne({ domain: host }, { projection: { active: 1 } });
  const state: CustomDomainState = !doc ? "none" : doc.active ? "active" : "pending";
  if (domainStates.size >= DOMAIN_STATE_MAX) domainStates.clear(); // scanners' random names
  domainStates.set(host, { state, at: Date.now() });
  if (state === "active") noteCustomDomain(host, true);
  return state;
}

export async function getAllCustomDomains(): Promise<CustomDomain[]> {
  const collections = getCollections();
  return await collections.customDomains.find({}).toArray() as CustomDomain[];
}

export async function getActiveDomains(): Promise<CustomDomain[]> {
  const collections = getCollections();
  return await collections.customDomains.find({ active: true }).toArray() as CustomDomain[];
}

export async function createCustomDomain(domain: CustomDomain): Promise<void> {
  const collections = getCollections();
  await collections.customDomains.insertOne({
    ...domain,
    _id: new ObjectId(),
  });
  // Invalidate cache so next request sees the new domain
  invalidateCustomDomainCache(domain.domain);
  if (domain.active) noteCustomDomain(domain.domain, true);
}

export async function updateCustomDomain(id: string, updates: Partial<CustomDomain>): Promise<void> {
  const collections = getCollections();
  await collections.customDomains.updateOne(
    { _id: new ObjectId(id) },
    { $set: updates }
  );
  if ("active" in updates) noteCustomDomain(undefined, undefined);
}

export async function updateCustomDomainByName(domain: string, updates: Partial<CustomDomain>): Promise<void> {
  const collections = getCollections();
  await collections.customDomains.updateOne(
    { domain },
    { $set: updates }
  );
  invalidateCustomDomainCache(domain);
  if ("active" in updates) noteCustomDomain(domain, updates.active);
}

export async function deleteCustomDomainById(id: string): Promise<void> {
  const collections = getCollections();
  // Try to delete by _id (ObjectId) first
  if (ObjectId.isValid(id)) {
    await collections.customDomains.deleteOne({ _id: new ObjectId(id) });
  } else {
    // Fallback: try by UUID 'id' field (legacy)
    await collections.customDomains.deleteOne({ id: id });
  }
  noteCustomDomain(undefined, undefined);
}

export async function deleteCustomDomainByName(domainName: string): Promise<void> {
  const collections = getCollections();
  const result = await collections.customDomains.deleteOne({ domain: domainName });
  if (result.deletedCount === 0) {
    throw new Error(`Domain ${domainName} not found in database`);
  }
  invalidateCustomDomainCache(domainName);
  noteCustomDomain(domainName, false);
}
