import type { Tunnel, CustomDomain } from "../types/index";
import { getCollections } from "./mongodb";
import { ObjectId } from "mongodb";

// ===== TUNNEL OPERATIONS =====

export async function getTunnel(id: string): Promise<Tunnel | null> {
  const collections = getCollections();
  return await collections.tunnels.findOne({ _id: new ObjectId(id) });
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
  const collections = getCollections();
  return await collections.tunnels.findOne({ domain });
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
  const collections = getCollections();
  return await collections.customDomains.findOne({ domain });
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
}

export async function deleteCustomDomain(id: string): Promise<void> {
  const collections = getCollections();
  await collections.customDomains.deleteOne({ _id: new ObjectId(id) });
}
