import { getCollections } from "../utils/mongodb";
import { generateId } from "../utils/helpers";
import type { 
  Organization, 
  OrganizationMember,
  User,
  Subscription,
  Plan
} from "../types/index";

// Generate URL-friendly slug from name
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
}

// Create organization
export async function createOrganization(name: string, owner: User): Promise<Organization> {
  if (owner.status === 'pending') {
    throw new Error("Your account is pending approval. You cannot create organizations yet.");
  }
  if (owner.status === 'disabled') {
    throw new Error("Your account is disabled.");
  }

  const collections = getCollections();

  // Generate unique slug
  let slug = generateSlug(name);
  let counter = 0;
  
  while (await collections.organizations.findOne({ slug })) {
    counter++;
    slug = `${generateSlug(name)}-${counter}`;
  }

  const organization: Organization = {
    id: generateId(),
    name,
    slug,
    ownerId: owner.id,
    members: [
      {
        userId: owner.id,
        role: "owner",
        joinedAt: Date.now(),
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isActive: true,
  };

  await collections.organizations.insertOne(organization);

  // Create free subscription for new organization
  await createFreeSubscription(organization.id);

  return organization;
}

// Create free subscription for organization
async function createFreeSubscription(organizationId: string): Promise<Subscription> {
  const collections = getCollections();

  // Get free plan
  let freePlan = await collections.plans.findOne({ tier: "free", isActive: true }) as Plan | null;
  
  // Create free plan if it doesn't exist
  if (!freePlan) {
    freePlan = await createDefaultPlans();
  }

  const now = Date.now();
  const subscription: Subscription = {
    id: generateId(),
    organizationId,
    planId: freePlan.id,
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: now + 365 * 24 * 60 * 60 * 1000, // 1 year for free plan
    cancelAtPeriodEnd: false,
    createdAt: now,
    updatedAt: now,
  };

  await collections.subscriptions.insertOne(subscription);
  await collections.organizations.updateOne(
    { id: organizationId },
    { $set: { subscriptionId: subscription.id } }
  );

  return subscription;
}

// Create default plans
async function createDefaultPlans(): Promise<Plan> {
  const collections = getCollections();

  const plans: Plan[] = [
    {
      id: generateId(),
      name: "Free",
      tier: "free",
      description: "Perfect for getting started",
      price: 0,
      currency: "USD",
      interval: "month",
      features: [
        { name: "1 Tunnel", included: true },
        { name: "1 Domain", included: true },
        { name: "Community Support", included: true },
        { name: "Custom Domains", included: false },
        { name: "Priority Support", included: false },
      ],
      limits: {
        maxTunnels: 1,
        maxDomains: 1,
        maxApiKeys: 1,
        maxMembers: 1,
        maxBandwidthGb: 1,
        sslIncluded: true,
        customDomains: false,
        prioritySupport: false,
      },
      isActive: true,
      createdAt: Date.now(),
    },
    {
      id: generateId(),
      name: "Starter",
      tier: "starter",
      description: "For small teams and projects",
      price: 999, // $9.99
      currency: "USD",
      interval: "month",
      features: [
        { name: "5 Tunnels", included: true },
        { name: "3 Domains", included: true },
        { name: "3 API Keys", included: true },
        { name: "3 Team Members", included: true },
        { name: "10GB Bandwidth", included: true },
        { name: "Custom Domains", included: true },
        { name: "Email Support", included: true },
      ],
      limits: {
        maxTunnels: 5,
        maxDomains: 3,
        maxApiKeys: 3,
        maxMembers: 3,
        maxBandwidthGb: 10,
        sslIncluded: true,
        customDomains: true,
        prioritySupport: false,
      },
      isActive: true,
      createdAt: Date.now(),
    },
    {
      id: generateId(),
      name: "Pro",
      tier: "pro",
      description: "For growing businesses",
      price: 2999, // $29.99
      currency: "USD",
      interval: "month",
      features: [
        { name: "20 Tunnels", included: true },
        { name: "10 Domains", included: true },
        { name: "10 API Keys", included: true },
        { name: "10 Team Members", included: true },
        { name: "100GB Bandwidth", included: true },
        { name: "Custom Domains", included: true },
        { name: "Priority Support", included: true },
      ],
      limits: {
        maxTunnels: 20,
        maxDomains: 10,
        maxApiKeys: 10,
        maxMembers: 10,
        maxBandwidthGb: 100,
        sslIncluded: true,
        customDomains: true,
        prioritySupport: true,
      },
      isActive: true,
      createdAt: Date.now(),
    },
    {
      id: generateId(),
      name: "Enterprise",
      tier: "enterprise",
      description: "For large organizations",
      price: 9999, // $99.99
      currency: "USD",
      interval: "month",
      features: [
        { name: "Unlimited Tunnels", included: true },
        { name: "Unlimited Domains", included: true },
        { name: "Unlimited API Keys", included: true },
        { name: "Unlimited Team Members", included: true },
        { name: "Unlimited Bandwidth", included: true },
        { name: "Custom Domains", included: true },
        { name: "Dedicated Support", included: true },
        { name: "SLA", included: true },
      ],
      limits: {
        maxTunnels: -1, // -1 means unlimited
        maxDomains: -1,
        maxApiKeys: -1,
        maxMembers: -1,
        maxBandwidthGb: -1,
        sslIncluded: true,
        customDomains: true,
        prioritySupport: true,
      },
      isActive: true,
      createdAt: Date.now(),
    },
  ];

  await collections.plans.insertMany(plans);
  console.log("✅ Default plans created");

  return plans[0]; // Return free plan
}

// Get organization by ID
export async function getOrganizationById(id: string): Promise<Organization | null> {
  const collections = getCollections();
  return await collections.organizations.findOne({ id, isActive: true }) as Organization | null;
}

// Get organization by slug
export async function getOrganizationBySlug(slug: string): Promise<Organization | null> {
  const collections = getCollections();
  return await collections.organizations.findOne({ slug, isActive: true }) as Organization | null;
}

// Get all organizations for a user
export async function getUserOrganizations(userId: string): Promise<Organization[]> {
  const collections = getCollections();
  return await collections.organizations
    .find({
      "members.userId": userId,
      isActive: true,
    })
    .toArray() as Organization[];
}

// Update organization
export async function updateOrganization(
  id: string, 
  updates: { name?: string }
): Promise<Organization | null> {
  const collections = getCollections();

  const updateData: Record<string, unknown> = { updatedAt: Date.now() };
  
  if (updates.name) {
    updateData.name = updates.name;
    // Update slug if name changes
    let slug = generateSlug(updates.name);
    let counter = 0;
    while (await collections.organizations.findOne({ slug, id: { $ne: id } })) {
      counter++;
      slug = `${generateSlug(updates.name)}-${counter}`;
    }
    updateData.slug = slug;
  }

  const result = await collections.organizations.findOneAndUpdate(
    { id },
    { $set: updateData },
    { returnDocument: "after" }
  );

  return result as Organization | null;
}

// Add member to organization
export async function addMember(
  organizationId: string,
  userId: string,
  role: "admin" | "member"
): Promise<Organization | null> {
  const collections = getCollections();

  const member: OrganizationMember = {
    userId,
    role,
    joinedAt: Date.now(),
  };

  const result = await collections.organizations.findOneAndUpdate(
    { id: organizationId },
    { 
      $push: { members: member } as any,
      $set: { updatedAt: Date.now() }
    },
    { returnDocument: "after" }
  );

  return result as Organization | null;
}

// Remove member from organization
export async function removeMember(
  organizationId: string,
  userId: string
): Promise<Organization | null> {
  const collections = getCollections();

  const result = await collections.organizations.findOneAndUpdate(
    { id: organizationId },
    { 
      $pull: { members: { userId } } as any,
      $set: { updatedAt: Date.now() }
    },
    { returnDocument: "after" }
  );

  return result as Organization | null;
}

// Update member role
export async function updateMemberRole(
  organizationId: string,
  userId: string,
  role: "admin" | "member"
): Promise<Organization | null> {
  const collections = getCollections();

  const result = await collections.organizations.findOneAndUpdate(
    { id: organizationId, "members.userId": userId },
    { 
      $set: { 
        "members.$.role": role,
        updatedAt: Date.now() 
      }
    },
    { returnDocument: "after" }
  );

  return result as Organization | null;
}

// Check if user is member of organization
export function isMember(organization: Organization, userId: string): boolean {
  return organization.members.some(m => m.userId === userId);
}

// Check if user is admin or owner of organization
export function isAdminOrOwner(organization: Organization, userId: string): boolean {
  return organization.members.some(
    m => m.userId === userId && (m.role === "owner" || m.role === "admin")
  );
}

// Check if user is owner of organization
export function isOwner(organization: Organization, userId: string): boolean {
  return organization.ownerId === userId;
}

// Delete organization (soft delete)
export async function deleteOrganization(id: string): Promise<boolean> {
  const collections = getCollections();
  
  const result = await collections.organizations.updateOne(
    { id },
    { $set: { isActive: false, updatedAt: Date.now() } }
  );

  // Also deactivate all API keys
  await collections.apiKeys.updateMany(
    { organizationId: id },
    { $set: { isActive: false } }
  );

  return result.modifiedCount > 0;
}

// Get organization subscription
export async function getOrganizationSubscription(
  organizationId: string
): Promise<{ subscription: Subscription; plan: Plan } | null> {
  const collections = getCollections();

  const subscription = await collections.subscriptions.findOne({
    organizationId,
  }) as Subscription | null;

  if (!subscription) return null;

  const plan = await collections.plans.findOne({ id: subscription.planId }) as Plan | null;
  if (!plan) return null;

  return { subscription, plan };
}

// Get all plans
export async function getAllPlans(): Promise<Plan[]> {
  const collections = getCollections();
  return await collections.plans
    .find({ isActive: true })
    .sort({ price: 1 })
    .toArray() as Plan[];
}

// Get all organizations (admin only)
export async function getAllOrganizations(limit = 100, skip = 0): Promise<Organization[]> {
  const collections = getCollections();
  return await collections.organizations
    .find({ isActive: true })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray() as Organization[];
}
