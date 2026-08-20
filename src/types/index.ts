export interface Agent {
  id: string;
  domain: string;
  localPort: number;
  localHost: string;
  connectedAt: number;
  lastHeartbeat: number;
  active: boolean;
  clientIp?: string;
  organizationId?: string;
  apiKeyOrgId?: string; // The API key's org (for plan limits) - separate from impersonated org
  apiKeyId?: string;
  tunnelId?: string; // Cached for performance - avoids MongoDB lookup per request
  protocol?: TunnelProtocol; // 'http' or 'tcp'
  // Multi-server support: which server owns this agent connection
  serverId?: string; // VPS_ID of the server handling this agent
  serverHost?: string; // Public host of the server (for routing)
  // Multi-agent group support
  groupId?: string; // ID of the agent group this agent belongs to
  instanceId?: string; // Unique identifier for this agent instance within a group
  groupMode?: boolean; // True if this agent is part of a load-balanced group
  caps?: string[]; // CLI capabilities advertised at connect (e.g. "stream", "b64body")
}

// ============ Multi-Agent Group Types ============

export type LoadBalanceStrategy = 'round-robin' | 'least-connections' | 'random' | 'weighted';

export interface AgentGroup {
  id: string;
  domain: string; // The shared domain for this group
  organizationId?: string;
  strategy: LoadBalanceStrategy; // Load balancing strategy
  agentIds: string[]; // List of agent IDs in this group
  activeAgentCount: number; // Number of currently active agents
  createdAt: number;
  updatedAt: number;
  // Round-robin state
  currentIndex: number; // For round-robin load balancing
  // Health check settings
  healthCheckEnabled: boolean;
  healthCheckInterval?: number; // ms, default 30000
  healthCheckPath?: string; // e.g., "/health"
  // Metadata
  metadata?: Record<string, unknown>;
}

export interface AgentGroupMember {
  agentId: string;
  instanceId: string;
  weight: number; // For weighted load balancing (1-100)
  healthy: boolean;
  lastHealthCheck?: number;
  activeConnections: number; // For least-connections strategy
  joinedAt: number;
}

// ============ TCP Tunnel Types ============

export type TunnelProtocol = 'http' | 'tcp';

export interface TcpPortAllocation {
  id: string;
  port: number;
  tunnelId: string;
  agentId: string;
  organizationId?: string;
  localPort: number;
  localHost: string;
  createdAt: number;
  active: boolean;
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
  // CNAME verification fields
  targetSubdomain?: string; // The jrok subdomain to point to, e.g., "jersen-app"
  cnameTarget?: string; // Full CNAME target, e.g., "jersen-app.tunnel.koompi.cloud"
  cnameVerified?: boolean; // True if CNAME has been verified
  cnameVerifiedAt?: number; // When CNAME was verified
  organizationId?: string; // Owner organization
  // TXT record verification (for apex domains)
  verificationToken?: string; // Unique token for TXT record verification, e.g., "jrok-verify-abc123xyz"
  txtVerified?: boolean; // True if TXT record has been verified
  txtVerifiedAt?: number; // When TXT record was verified
}

export interface Tunnel {
  id: string;
  domain: string; // subdomain part, e.g., "myapp"
  customDomain?: string; // parent domain, e.g., "client1.com" (uses baseDomain if not set)
  agentId: string; // reference to connected agent
  organizationId?: string; // which organization owns this tunnel
  localPort?: number; // local service port
  localHost?: string; // local service host (e.g., localhost)
  createdAt: number; // timestamp
  expiresAt?: number; // optional expiration
  active: boolean;
  // TCP tunnel fields
  protocol?: TunnelProtocol; // 'http' (default) or 'tcp'
  tcpPort?: number; // allocated public TCP port (e.g., 10001)
  // Multi-server support
  serverId?: string; // VPS_ID of server owning the agent connection
  serverHost?: string; // Public host for direct routing
  updatedAt?: number; // Last update timestamp
  // IP Access Control
  ipSecurity?: TunnelIpSecurity;
}

// IP Security settings for a tunnel
export interface TunnelIpSecurity {
  mode: 'allow-all' | 'allowlist' | 'blocklist'; // default: 'allow-all'
  allowedIps?: string[]; // IPs/CIDRs allowed when mode='allowlist'
  blockedIps?: string[]; // IPs/CIDRs blocked when mode='blocklist'
  updatedAt?: number;
  updatedBy?: string; // userId who last updated
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
  protocol?: TunnelProtocol; // 'http' (default) or 'tcp'
}

export interface RegisterCustomDomainRequest {
  domain: string; // e.g., client1.com
  certbotEmail: string;
  cloudflareToken?: string; // for auto DNS validation
  subdomain?: string; // optional: custom subdomain to use (auto-generated from domain if not provided)
  organizationId?: string; // owner organization
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
  | "tunnel:create"
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
  // Security & Rate Limits
  maxHttpRequestsPerMinute?: number;  // Per tunnel
  maxHttpRequestsPerHour?: number;    // Per tunnel
  maxTcpConnectionsPerTunnel?: number;
  maxTcpConnectionsPerOrg?: number;
  maxTcpBandwidthMbPerMinute?: number;
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

// ============ Activity & Stats Types ============

export type ActivityCategory =
  | "tunnels"
  | "domains"
  | "api_keys"
  | "agents"
  | "organization"
  | "auth"
  | "billing";

export type ActivityAction =
  | "created"
  | "updated"
  | "deleted"
  | "connected"
  | "disconnected"
  | "renewed"
  | "expired"
  | "verified"
  | "failed"
  | "login"
  | "logout";

export interface ActivityLog {
  id: string;
  organizationId: string;
  userId?: string;
  category: ActivityCategory;
  action: ActivityAction;
  resourceType: string; // e.g., "tunnel", "domain", "api_key"
  resourceId?: string;
  resourceName?: string; // Human-readable name
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: number;
}

export interface ActivityLogFilters {
  organizationId: string;
  category?: ActivityCategory;
  action?: ActivityAction;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}

export interface ListActivityResponse {
  success: boolean;
  activities: ActivityLog[];
  total: number;
  hasMore: boolean;
}

// Enhanced Agent with system info
export interface EnhancedAgent extends Agent {
  platform?: string; // 'darwin', 'linux', 'windows'
  platformVersion?: string;
  arch?: string;
  cliVersion?: string;
  cpuUsage?: number; // 0-100
  memoryUsage?: number; // 0-100
  signalStrength?: number; // 0-100
  tunnelCount?: number;
  bytesIn?: number;
  bytesOut?: number;
  totalRequests?: number;
}

// Enhanced Tunnel with traffic stats
export interface EnhancedTunnel extends Tunnel {
  status: "online" | "offline" | "error";
  totalRequests: number;
  bytesIn: number;
  bytesOut: number;
  lastRequestAt?: number;
  avgResponseTime?: number;
  errorRate?: number;
}

// Enhanced Domain with SSL info
export interface EnhancedDomain extends CustomDomain {
  sslStatus: "valid" | "expiring" | "expired" | "pending" | "none";
  dnsVerified: boolean;
  dnsRecords?: DnsRecord[];
  tunnelCount: number;
}

export interface DnsRecord {
  type: "A" | "CNAME" | "TXT";
  name: string;
  value: string;
  verified: boolean;
}

// Dashboard Stats
export interface DashboardStats {
  tunnels: {
    total: number;
    online: number;
    offline: number;
  };
  domains: {
    total: number;
    sslValid: number;
    sslExpiring: number;
  };
  agents: {
    total: number;
    connected: number;
  };
  bandwidth: {
    totalIn: number; // bytes
    totalOut: number;
    periodIn: number; // current period
    periodOut: number;
  };
  requests: {
    total: number;
    today: number;
    thisWeek: number;
  };
  plan: {
    name: string;
    tier: PlanTier;
    tunnelLimit: number;
    domainLimit: number;
    bandwidthLimit: number; // GB
    usedTunnels: number;
    usedDomains: number;
    usedBandwidth: number; // GB
  };
}

export interface BandwidthRecord {
  id: string;
  organizationId: string;
  tunnelId?: string;
  agentId?: string;
  bytesIn: number;
  bytesOut: number;
  requests: number;
  timestamp: number;
  period: "hour" | "day" | "month";
}
