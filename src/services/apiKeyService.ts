import { getCollections } from "../utils/mongodb";
import { generateId } from "../utils/helpers";
import type { ApiKey, ApiKeyPermission, Organization, Plan } from "../types/index";
import crypto from "crypto";

// Generate a secure API key
function generateApiKey(): { key: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(32).toString("hex");
  const key = `jrok_${random}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const prefix = key.substring(0, 14); // jrok_ + first 8 chars

  return { key, hash, prefix };
}

// Create API key
export async function createApiKey(
  organizationId: string,
  createdBy: string,
  name: string,
  permissions: ApiKeyPermission[],
  expiresIn?: number // seconds
): Promise<{ apiKey: ApiKey; rawKey: string }> {
  const collections = getCollections();

  const { key, hash, prefix } = generateApiKey();

  const apiKey: ApiKey = {
    id: generateId(),
    name,
    key: hash,
    keyPrefix: prefix,
    organizationId,
    createdBy,
    permissions,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    createdAt: Date.now(),
    isActive: true,
  };

  await collections.apiKeys.insertOne(apiKey);

  return { apiKey, rawKey: key };
}

// Get API key by ID
export async function getApiKeyById(id: string): Promise<ApiKey | null> {
  const collections = getCollections();
  return await collections.apiKeys.findOne({ id }) as ApiKey | null;
}

// Get all API keys for organization
export async function getOrganizationApiKeys(organizationId: string): Promise<ApiKey[]> {
  const collections = getCollections();
  return await collections.apiKeys
    .find({ organizationId, isActive: true })
    .sort({ createdAt: -1 })
    .toArray() as ApiKey[];
}

// Revoke API key
export async function revokeApiKey(id: string): Promise<boolean> {
  const collections = getCollections();
  const result = await collections.apiKeys.updateOne(
    { id },
    { $set: { isActive: false } }
  );
  return result.modifiedCount > 0;
}

// Delete API key permanently
export async function deleteApiKey(id: string): Promise<boolean> {
  const collections = getCollections();
  const result = await collections.apiKeys.deleteOne({ id });
  return result.deletedCount > 0;
}

// Update API key name
export async function updateApiKeyName(id: string, name: string): Promise<ApiKey | null> {
  const collections = getCollections();
  const result = await collections.apiKeys.findOneAndUpdate(
    { id },
    { $set: { name } },
    { returnDocument: "after" }
  );
  return result as ApiKey | null;
}

// Update API key permissions
export async function updateApiKeyPermissions(
  id: string, 
  permissions: ApiKeyPermission[]
): Promise<ApiKey | null> {
  const collections = getCollections();
  const result = await collections.apiKeys.findOneAndUpdate(
    { id },
    { $set: { permissions } },
    { returnDocument: "after" }
  );
  return result as ApiKey | null;
}

// Check if API key has permission
export function hasPermission(apiKey: ApiKey, permission: ApiKeyPermission): boolean {
  return apiKey.permissions.includes(permission);
}

// Check organization API key limits
export async function canCreateApiKey(
  organization: Organization,
  plan: Plan
): Promise<{ allowed: boolean; reason?: string }> {
  const collections = getCollections();

  if (plan.limits.maxApiKeys === -1) {
    return { allowed: true };
  }

  const count = await collections.apiKeys.countDocuments({
    organizationId: organization.id,
    isActive: true,
  });

  if (count >= plan.limits.maxApiKeys) {
    return {
      allowed: false,
      reason: `API key limit reached (${plan.limits.maxApiKeys}). Upgrade your plan to create more.`,
    };
  }

  return { allowed: true };
}

// Get API key count for organization
export async function getApiKeyCount(organizationId: string): Promise<number> {
  const collections = getCollections();
  return await collections.apiKeys.countDocuments({
    organizationId,
    isActive: true,
  });
}

// Rotate API key (create new, revoke old)
export async function rotateApiKey(id: string): Promise<{ apiKey: ApiKey; rawKey: string } | null> {
  const collections = getCollections();
  
  const oldKey = await getApiKeyById(id);
  if (!oldKey) return null;

  // Revoke old key
  await revokeApiKey(id);

  // Create new key with same settings
  return await createApiKey(
    oldKey.organizationId,
    oldKey.createdBy,
    oldKey.name,
    oldKey.permissions,
    oldKey.expiresAt ? Math.floor((oldKey.expiresAt - Date.now()) / 1000) : undefined
  );
}
