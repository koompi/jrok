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
  } else {
    customDomainNameCache.clear();
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
}

export async function updateCustomDomain(id: string, updates: Partial<CustomDomain>): Promise<void> {
  const collections = getCollections();
  await collections.customDomains.updateOne(
    { _id: new ObjectId(id) },
    { $set: updates }
  );
}

export async function updateCustomDomainByName(domain: string, updates: Partial<CustomDomain>): Promise<void> {
  const collections = getCollections();
  await collections.customDomains.updateOne(
    { domain },
    { $set: updates }
  );
  invalidateCustomDomainCache(domain);
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
}

export async function deleteCustomDomainByName(domainName: string): Promise<void> {
  const collections = getCollections();
  const result = await collections.customDomains.deleteOne({ domain: domainName });
  if (result.deletedCount === 0) {
    throw new Error(`Domain ${domainName} not found in database`);
  }
  invalidateCustomDomainCache(domainName);
}
