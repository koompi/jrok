import { getCollections } from "../utils/mongodb";
import { ObjectId } from "mongodb";

export interface VpsServer {
  _id?: ObjectId;
  id: string;
  name: string;
  host: string;
  healthy: boolean;
  lastHealthCheck: number;
  createdAt: number;
  region?: string; // e.g., "us-east", "eu-west"
  // TCP port range for distributed port allocation
  tcpPortMin?: number; // Start of TCP port range
  tcpPortMax?: number; // End of TCP port range
}

export async function registerVpsServer(server: Omit<VpsServer, "_id">): Promise<VpsServer> {
  const collections = getCollections();

  const doc = {
    ...server,
    createdAt: Date.now(),
    lastHealthCheck: Date.now(),
  };

  const result = await collections.vpsServers.insertOne(doc);

  return { ...doc, _id: result.insertedId };
}

export async function getAllVpsServers(): Promise<VpsServer[]> {
  const collections = getCollections();
  return await collections.vpsServers.find({}).toArray() as VpsServer[];
}

export async function getHealthyVpsServers(): Promise<VpsServer[]> {
  const collections = getCollections();
  return await collections.vpsServers.find({ healthy: true }).toArray() as VpsServer[];
}

export async function getVpsServerById(id: string): Promise<VpsServer | null> {
  const collections = getCollections();
  return await collections.vpsServers.findOne({ id });
}

export async function updateVpsServerHealth(id: string, healthy: boolean): Promise<void> {
  const collections = getCollections();
  await collections.vpsServers.updateOne(
    { id },
    {
      $set: {
        healthy,
        lastHealthCheck: Date.now(),
      },
    }
  );
}

export async function deleteVpsServer(id: string): Promise<void> {
  const collections = getCollections();
  await collections.vpsServers.deleteOne({ id });
}

/**
 * Get a random healthy VPS server for agent assignment
 */
export async function getRandomVpsServer(): Promise<VpsServer | null> {
  const servers = await getHealthyVpsServers();
  if (servers.length === 0) return null;
  return servers[Math.floor(Math.random() * servers.length)];
}

/**
 * Get VPS server with least active tunnels (load balancing)
 */
export async function getLoadBalancedVpsServer(): Promise<VpsServer | null> {
  const servers = await getHealthyVpsServers();
  if (servers.length === 0) return null;

  const collections = getCollections();

  // Count tunnels per VPS by checking which VPS has the config
  // For now, just return random - can be optimized later
  return servers[Math.floor(Math.random() * servers.length)];
}
