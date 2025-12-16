import { getCollections } from "../utils/mongodb";
import { generateId } from "../utils/helpers";
import type { 
  Organization, 
  Subscription,
  Plan,
  User
} from "../types/index";

// Get all organizations (paginated)
export async function getAllOrganizations(page = 1, limit = 20, search?: string): Promise<{ organizations: Organization[], total: number }> {
  const collections = getCollections();
  const skip = (page - 1) * limit;
  
  const query: any = {};
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { slug: { $regex: search, $options: "i" } }
    ];
  }

  const [organizations, total] = await Promise.all([
    collections.organizations.find(query).skip(skip).limit(limit).toArray(),
    collections.organizations.countDocuments(query)
  ]);

  return { 
    organizations: organizations as Organization[], 
    total 
  };
}

// Get all plans
export async function getAllPlans(): Promise<Plan[]> {
  const collections = getCollections();
  return collections.plans.find({ isActive: true }).toArray() as Promise<Plan[]>;
}

// Upgrade organization plan
export async function upgradeOrganizationPlan(organizationId: string, planId: string): Promise<Subscription> {
  const collections = getCollections();

  // Verify organization exists
  const organization = await collections.organizations.findOne({ id: organizationId });
  if (!organization) {
    throw new Error("Organization not found");
  }

  // Verify plan exists
  const plan = await collections.plans.findOne({ id: planId });
  if (!plan) {
    throw new Error("Plan not found");
  }

  // Get current subscription
  const currentSubscription = await collections.subscriptions.findOne({ 
    organizationId, 
    status: { $in: ["active", "trial", "past_due"] } 
  }) as Subscription | null;

  const now = Date.now();
  
  // If active subscription exists, update it (or cancel and create new one - let's update for simplicity)
  if (currentSubscription) {
    // If it's the same plan, just return it
    if (currentSubscription.planId === planId) {
      return currentSubscription;
    }

    // Update subscription
    await collections.subscriptions.updateOne(
      { id: currentSubscription.id },
      { 
        $set: { 
          planId,
          updatedAt: now,
          // Reset period if upgrading? Or keep same period?
          // For manual upgrade, let's set a new period starting now
          currentPeriodStart: now,
          currentPeriodEnd: now + (plan.interval === "year" ? 365 : 30) * 24 * 60 * 60 * 1000,
          status: "active"
        } 
      }
    );

    return { ...currentSubscription, planId, updatedAt: now } as Subscription;
  } else {
    // Create new subscription
    const subscription: Subscription = {
      id: generateId(),
      organizationId,
      planId,
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: now + (plan.interval === "year" ? 365 : 30) * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false,
      createdAt: now,
      updatedAt: now,
    };

    await collections.subscriptions.insertOne(subscription);
    
    // Link to organization
    await collections.organizations.updateOne(
      { id: organizationId },
      { $set: { subscriptionId: subscription.id } }
    );

    return subscription;
  }
}

// Check if user is super admin
export async function isSuperAdmin(userId: string): Promise<boolean> {
  const collections = getCollections();
  const user = await collections.users.findOne({ id: userId }) as User | null;
  return user?.role === "super_admin";
}

// --- System Settings ---

export async function getSystemSettings(): Promise<SystemSettings> {
  const collections = getCollections();
  let settings = await collections.settings.findOne({ id: "default" }) as SystemSettings | null;

  if (!settings) {
    settings = {
      id: "default",
      waitingListEnabled: false,
      updatedAt: Date.now(),
    };
    await collections.settings.insertOne(settings);
  }

  return settings;
}

export async function updateSystemSettings(updates: Partial<SystemSettings>): Promise<SystemSettings> {
  const collections = getCollections();
  await collections.settings.updateOne(
    { id: "default" },
    { 
      $set: {
        ...updates,
        updatedAt: Date.now()
      } 
    },
    { upsert: true }
  );
  return getSystemSettings();
}

// --- User Management ---

export async function getAllUsers(page = 1, limit = 20, search?: string): Promise<{ users: User[], total: number }> {
  const collections = getCollections();
  const skip = (page - 1) * limit;
  
  const query: any = {};
  if (search) {
    query.$or = [
      { fullname: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { username: { $regex: search, $options: "i" } }
    ];
  }

  const [users, total] = await Promise.all([
    collections.users.find(query).skip(skip).limit(limit).toArray(),
    collections.users.countDocuments(query)
  ]);

  return { 
    users: users as User[], 
    total 
  };
}

export async function updateUserStatus(userId: string, status: User['status']): Promise<void> {
  const collections = getCollections();
  await collections.users.updateOne(
    { id: userId },
    { $set: { status, updatedAt: Date.now() } }
  );
}

// --- Organization Management ---

export async function updateOrganizationStatus(orgId: string, status: Organization['status']): Promise<void> {
  const collections = getCollections();
  await collections.organizations.updateOne(
    { id: orgId },
    { 
      $set: { 
        status, 
        isActive: status === 'active', // Sync isActive for backward compatibility
        updatedAt: Date.now() 
      } 
    }
  );
}
