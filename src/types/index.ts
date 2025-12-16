export interface Agent {
  id: string;
  domain: string;
  localPort: number;
  localHost: string;
  connectedAt: number;
  lastHeartbeat: number;
  active: boolean;
  clientIp?: string;
}

export interface AgentMessage {
  type: "register" | "heartbeat" | "data" | "error";
  domain?: string;
  localPort?: number;
  localHost?: string;
  payload?: unknown;
}

export interface CustomDomain {
  id: string;
  domain: string; // e.g., client1.com
  baseDomain: boolean; // true if tunnel.example.com, false if custom
  certPath?: string; // /etc/letsencrypt/live/client1.com/
  certExpiry?: number; // timestamp when cert expires
  cloudflareToken?: string; // encrypted for auto-renewal
  certbotEmail: string;
  createdAt: number;
  active: boolean;
  synced: boolean; // true if cert synced to all VPS servers
  lastSyncedAt?: number;
}

export interface Tunnel {
  id: string;
  domain: string; // subdomain part, e.g., "myapp"
  customDomain?: string; // parent domain, e.g., "client1.com" (uses baseDomain if not set)
  agentId: string; // reference to connected agent
  createdAt: number; // timestamp
  expiresAt?: number; // optional expiration
  active: boolean;
}

export interface TunnelConfig {
  vpsHost: string;
  vpsUser: string;
  vpsPort?: number; // SSH port, defaults to 22
  nginxConfPath: string; // e.g., /etc/nginx/sites-available
  baseDomain: string; // e.g., tunnel.example.com
  apiKey: string; // for auth
}

export interface CreateTunnelRequest {
  domain: string;
  customDomain?: string; // optional custom domain
  localPort?: number;
  localHost?: string;
  expiresIn?: number; // seconds
  agentId?: string;
}

export interface RegisterCustomDomainRequest {
  domain: string; // e.g., client1.com
  certbotEmail: string;
  cloudflareToken?: string; // for auto DNS validation
}

export interface TunnelResponse {
  success: boolean;
  message: string;
  tunnel?: Tunnel;
  error?: string;
}

export interface ListTunnelsResponse {
  success: boolean;
  tunnels: Tunnel[];
}

export interface ListAgentsResponse {
  success: boolean;
  agents: Agent[];
}

// ============ SaaS Types ============

export type UserRole = "super_admin" | "admin" | "member";
export type SubscriptionStatus = "active" | "inactive" | "trial" | "cancelled" | "past_due";
export type PlanTier = "free" | "starter" | "pro" | "enterprise";

export interface User {
  id: string;
  koompId: string; // KOOMPI OAuth user ID
  email: string;
  fullname: string;
  username?: string;
  profile?: string; // avatar URL
  role: UserRole;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
  isActive: boolean;
  status: 'active' | 'pending' | 'disabled';
}

export interface SystemSettings {
  id: string; // usually just "default"
  waitingListEnabled: boolean;
  updatedAt: number;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  members: OrganizationMember[];
  createdAt: number;
  updatedAt: number;
  isActive: boolean;
  status?: 'active' | 'disabled'; // Added status for explicit disable
}

export interface OrganizationMember {
  userId: string;
  role: "owner" | "admin" | "member";
  joinedAt: number;
}

export interface ApiKey {
  id: string;
  name: string;
  key: string; // hashed
  keyPrefix: string; // first 8 chars for display
  organizationId: string;
  createdBy: string; // User ID
  permissions: ApiKeyPermission[];
  lastUsedAt?: number;
  expiresAt?: number;
  createdAt: number;
  isActive: boolean;
}

export type ApiKeyPermission = 
  | "tunnels:read" 
  | "tunnels:write" 
  | "tunnels:delete"
  | "domains:read"
  | "domains:write"
  | "domains:delete"
  | "agents:read";

export interface Plan {
  id: string;
  name: string;
  tier: PlanTier;
  description: string;
  price: number; // in cents
  currency: string;
  interval: "month" | "year";
  features: PlanFeature[];
  limits: PlanLimits;
  isActive: boolean;
  createdAt: number;
}

export interface PlanFeature {
  name: string;
  included: boolean;
  description?: string;
}

export interface PlanLimits {
  maxTunnels: number;
  maxDomains: number;
  maxApiKeys: number;
  maxMembers: number;
  maxBandwidthGb: number;
  sslIncluded: boolean;
  customDomains: boolean;
  prioritySupport: boolean;
}

export interface Subscription {
  id: string;
  organizationId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  trialEnd?: number;
  createdAt: number;
  updatedAt: number;
}

export interface UsageRecord {
  id: string;
  organizationId: string;
  period: string; // YYYY-MM format
  tunnelsCreated: number;
  domainsRegistered: number;
  bandwidthUsedMb: number;
  apiCalls: number;
  createdAt: number;
  updatedAt: number;
}

// Auth types
export interface AuthSession {
  id: string;
  userId: string;
  token: string; // JWT
  expiresAt: number;
  createdAt: number;
  userAgent?: string;
  ipAddress?: string;
}

export interface KoompiOAuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  refresh_token?: string;
}

export interface KoompiUserInfo {
  user: {
    _id: string;
    fullname: string;
    username?: string;
    email?: string;
    profile?: string;
    wallet_address?: string;
    telegram_id?: number;
    created_at?: string;
  };
  status: string;
}

// Request/Response types for SaaS APIs
export interface CreateOrganizationRequest {
  name: string;
}

export interface UpdateOrganizationRequest {
  name?: string;
}

export interface InviteMemberRequest {
  email: string;
  role: "admin" | "member";
}

export interface CreateApiKeyRequest {
  name: string;
  permissions: ApiKeyPermission[];
  expiresIn?: number; // seconds
}

export interface ApiKeyResponse {
  id: string;
  name: string;
  keyPrefix: string;
  key?: string; // Only returned on creation
  permissions: ApiKeyPermission[];
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  isActive: boolean;
}

export interface AuthContext {
  user?: User;
  organization?: Organization;
  apiKey?: ApiKey;
  isApiKeyAuth: boolean;
}
