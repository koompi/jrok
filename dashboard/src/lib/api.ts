// In development, use the proxy (/api -> localhost:3000)
// In production, use the actual API URL from env
const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Public hostname config (override per-deployment via Vite env).
// BASE_DOMAIN is the wildcard base for generated tunnel URLs (<sub>.<BASE_DOMAIN>).
// CNAME_TARGET is the Cloudflare-for-SaaS fallback hostname customers point custom
// domains at via a DNS-only (grey-cloud) CNAME.
export const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN || 'live.koompi.cloud';
export const CNAME_TARGET = import.meta.env.VITE_CNAME_TARGET || BASE_DOMAIN;

interface ApiResponse<T> {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('auth_token', token);
    } else {
      localStorage.removeItem('auth_token');
    }
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = localStorage.getItem('auth_token');
    }
    return this.token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const token = this.getToken();
    if (token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'An error occurred');
    }

    return data;
  }

  // Auth
  async getLoginUrl(): Promise<{ loginUrl: string; state: string }> {
    return this.request('/auth/login');
  }

  async handleCallback(code: string, state?: string): Promise<{
    token: string;
    user: User;
    organizations: Organization[];
  }> {
    return this.request('/auth/callback', {
      method: 'POST',
      body: JSON.stringify({ code, state }),
    });
  }

  async getCurrentUser(): Promise<{
    user: User;
    organizations: Organization[];
  }> {
    return this.request('/auth/me');
  }

  async logout(): Promise<void> {
    await this.request('/auth/logout', { method: 'POST' });
    this.setToken(null);
  }

  // Organizations
  async getOrganizations(): Promise<{ organizations: Organization[] }> {
    return this.request('/organizations');
  }

  async getOrganization(id: string): Promise<{ organization: OrganizationDetails }> {
    return this.request(`/organizations/${id}`);
  }

  async createOrganization(name: string): Promise<{ organization: Organization }> {
    return this.request('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  // Admin
  async adminGetOrganizations(page = 1, limit = 20, search?: string): Promise<{ organizations: Organization[], total: number }> {
    const params = new URLSearchParams({ page: page.toString(), limit: limit.toString() });
    if (search) params.append('search', search);
    return this.request(`/admin/organizations?${params.toString()}`);
  }

  async adminGetPlans(): Promise<{ plans: Plan[] }> {
    return this.request('/admin/plans');
  }

  async adminUpgradePlan(orgId: string, planId: string): Promise<{ subscription: any }> {
    return this.request(`/admin/organizations/${orgId}/plan`, {
      method: 'POST',
      body: JSON.stringify({ planId }),
    });
  }

  async updateOrganization(id: string, name: string): Promise<{ organization: Organization }> {
    return this.request(`/organizations/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
  }

  async deleteOrganization(id: string): Promise<void> {
    await this.request(`/organizations/${id}`, { method: 'DELETE' });
  }

  // API Keys
  async getApiKeys(orgId: string): Promise<{ apiKeys: ApiKey[] }> {
    return this.request(`/organizations/${orgId}/api-keys`);
  }

  async createApiKey(
    orgId: string,
    name: string,
    permissions: string[],
    expiresIn?: number
  ): Promise<{ apiKey: ApiKey & { key: string } }> {
    return this.request(`/organizations/${orgId}/api-keys`, {
      method: 'POST',
      body: JSON.stringify({ name, permissions, expiresIn }),
    });
  }

  async revokeApiKey(orgId: string, keyId: string): Promise<void> {
    await this.request(`/organizations/${orgId}/api-keys/${keyId}`, {
      method: 'DELETE',
    });
  }

  async rotateApiKey(orgId: string, keyId: string): Promise<{ apiKey: ApiKey & { key: string } }> {
    return this.request(`/organizations/${orgId}/api-keys/${keyId}/rotate`, {
      method: 'POST',
    });
  }

  // Plans
  async getPlans(): Promise<{ plans: Plan[] }> {
    return this.request('/plans');
  }

  // Admin
  async getAllUsers(): Promise<{ users: User[] }> {
    return this.request('/auth/users');
  }

  async updateUserRole(userId: string, role: string): Promise<{ user: User }> {
    return this.request(`/auth/users/${userId}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    });
  }

  async deactivateUser(userId: string): Promise<void> {
    await this.request(`/auth/users/${userId}`, { method: 'DELETE' });
  }

  async getAllOrganizations(): Promise<{ organizations: Organization[] }> {
    return this.request('/admin/organizations');
  }

  async getSystemSettings(): Promise<{ settings: SystemSettings }> {
    return this.request('/admin/settings');
  }

  async updateSystemSettings(settings: Partial<SystemSettings>): Promise<{ settings: SystemSettings }> {
    return this.request('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  async adminListUsers(page = 1, limit = 20, search?: string): Promise<{ users: User[], total: number }> {
    const params = new URLSearchParams({ page: page.toString(), limit: limit.toString() });
    if (search) params.append('search', search);
    return this.request(`/admin/users?${params.toString()}`);
  }

  async updateUserStatus(userId: string, status: string): Promise<void> {
    return this.request(`/admin/users/${userId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
  }

  async updateOrgStatus(orgId: string, status: string): Promise<void> {
    return this.request(`/admin/organizations/${orgId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
  }

  // ============ Activity API ============

  async getActivity(params?: {
    category?: ActivityCategory;
    startDate?: number;
    endDate?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ success: boolean; activities: ActivityLog[]; total: number; hasMore: boolean }> {
    const searchParams = new URLSearchParams();
    if (params?.category) searchParams.append('category', params.category);
    if (params?.startDate) searchParams.append('startDate', params.startDate.toString());
    if (params?.endDate) searchParams.append('endDate', params.endDate.toString());
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.offset) searchParams.append('offset', params.offset.toString());
    
    const query = searchParams.toString();
    return this.request(`/activity${query ? `?${query}` : ''}`);
  }

  async getRecentActivity(limit: number = 10): Promise<{ success: boolean; activities: ActivityLog[] }> {
    return this.request(`/activity/recent?limit=${limit}`);
  }

  async getActivitySummary(days: number = 7): Promise<{
    success: boolean;
    totalActivities: number;
    byCategory: Record<ActivityCategory, number>;
    byAction: Record<ActivityAction, number>;
    recentActivity: ActivityLog[];
  }> {
    return this.request(`/activity/summary?days=${days}`);
  }

  // ============ Stats API ============

  async getDashboardStats(): Promise<{ success: boolean; stats: DashboardStats }> {
    return this.request('/stats/dashboard');
  }

  async getBandwidthUsage(period: 'day' | 'week' | 'month' = 'month'): Promise<BandwidthUsage & { success: boolean }> {
    return this.request(`/stats/bandwidth?period=${period}`);
  }

  // ============ Enhanced Resources API ============

  async getEnhancedTunnels(): Promise<{ success: boolean; tunnels: EnhancedTunnel[] }> {
    return this.request('/tunnels/enhanced');
  }

  async getEnhancedAgents(): Promise<{ success: boolean; agents: EnhancedAgent[] }> {
    return this.request('/agents/enhanced');
  }

  async getEnhancedDomains(): Promise<{ success: boolean; domains: EnhancedDomain[] }> {
    return this.request('/domains/enhanced');
  }

  // ============ Security API ============

  async getSecurityStats(): Promise<{ success: boolean } & SecurityStats> {
    return this.request('/security/stats');
  }

  async getBlockedIps(): Promise<{ success: boolean; blockedIps: BlockedIp[] }> {
    return this.request('/security/blocked-ips');
  }

  async blockIp(ip: string, reason: string, duration?: number): Promise<{ success: boolean; message: string }> {
    return this.request('/security/block-ip', {
      method: 'POST',
      body: JSON.stringify({ ip, reason, duration }),
    });
  }

  async unblockIp(ip: string): Promise<{ success: boolean; message: string }> {
    return this.request('/security/unblock-ip', {
      method: 'POST',
      body: JSON.stringify({ ip }),
    });
  }

  async getTunnelAllowlist(tunnelId: string): Promise<{ success: boolean; tunnelId: string; allowlist: string[] }> {
    return this.request(`/security/allowlist/${tunnelId}`);
  }

  async setTunnelAllowlist(tunnelId: string, ips: string[]): Promise<{ success: boolean; message: string }> {
    return this.request(`/security/allowlist/${tunnelId}`, {
      method: 'POST',
      body: JSON.stringify({ ips }),
    });
  }

  // ============ New IP Security API ============

  async getTunnelIpSecurity(tunnelId: string): Promise<{ 
    success: boolean; 
    tunnelId: string; 
    ipSecurity: TunnelIpSecurity 
  }> {
    return this.request(`/security/ip/${tunnelId}`);
  }

  async setTunnelIpSecurity(
    tunnelId: string, 
    ipSecurity: TunnelIpSecurity
  ): Promise<{ success: boolean; message: string; mode: string }> {
    return this.request(`/security/ip/${tunnelId}`, {
      method: 'POST',
      body: JSON.stringify(ipSecurity),
    });
  }

  async addIpToTunnelSecurity(
    tunnelId: string, 
    ip: string, 
    listType: 'allow' | 'block'
  ): Promise<{ success: boolean; message: string }> {
    return this.request(`/security/ip/${tunnelId}/add`, {
      method: 'POST',
      body: JSON.stringify({ ip, listType }),
    });
  }

  async removeIpFromTunnelSecurity(
    tunnelId: string, 
    ip: string
  ): Promise<{ success: boolean; message: string }> {
    return this.request(`/security/ip/${tunnelId}/remove`, {
      method: 'POST',
      body: JSON.stringify({ ip }),
    });
  }

  async getTunnelConnectionLogs(tunnelId: string, limit?: number, offset?: number): Promise<{ 
    success: boolean; 
    tunnelId: string; 
    logs: ConnectionLog[] 
  }> {
    const params = new URLSearchParams();
    if (limit) params.append('limit', limit.toString());
    if (offset) params.append('offset', offset.toString());
    const query = params.toString();
    return this.request(`/security/logs/tunnel/${tunnelId}${query ? `?${query}` : ''}`);
  }

  async getOrganizationBandwidth(organizationId: string): Promise<{ 
    success: boolean; 
    organizationId: string 
  } & BandwidthLimit> {
    return this.request(`/security/bandwidth/${organizationId}`);
  }

  // ============ Monitoring API (Super Admin Only) ============

  async getMonitoringDashboard(): Promise<{ success: boolean; data: MonitoringDashboardData }> {
    return this.request('/admin/monitoring');
  }

  async getSystemHealth(): Promise<{ success: boolean; health: SystemHealth }> {
    return this.request('/admin/monitoring/health');
  }

  async getMetricsHistory(minutes: number = 60): Promise<{ success: boolean; history: SystemMetricsSnapshot[] }> {
    return this.request(`/admin/monitoring/metrics?minutes=${minutes}`);
  }

  async getMonitoringLogs(
    count?: number, 
    level?: 'info' | 'warn' | 'error' | 'debug',
    category?: string
  ): Promise<{ success: boolean; logs: SystemLog[] }> {
    const params = new URLSearchParams();
    if (count) params.append('count', count.toString());
    if (level) params.append('level', level);
    if (category) params.append('category', category);
    const query = params.toString();
    return this.request(`/admin/monitoring/logs${query ? `?${query}` : ''}`);
  }

  async getRateLimitStats(): Promise<{ success: boolean; rateLimits: RateLimitStats[] }> {
    return this.request('/admin/monitoring/rate-limits');
  }

  async getAuthMetrics(): Promise<{ success: boolean; auth: AuthMetrics }> {
    return this.request('/admin/monitoring/auth');
  }

  async getSystemConfig(): Promise<{ success: boolean; config: SystemConfig }> {
    return this.request('/admin/monitoring/config');
  }

  async updateSystemConfig(config: Partial<SystemConfig>): Promise<{ success: boolean; config: SystemConfig }> {
    return this.request('/admin/monitoring/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  }
}

// Types
export interface SystemSettings {
  id: string;
  waitingListEnabled: boolean;
  updatedAt: number;
}

export interface User {
  id: string;
  email: string;
  fullname: string;
  username?: string;
  profile?: string;
  role: 'super_admin' | 'admin' | 'member';
  createdAt: number;
  lastLoginAt?: number;
  isActive: boolean;
  status?: 'active' | 'pending' | 'disabled';
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  ownerId?: string;
  memberCount?: number;
  role?: string;
  isActive?: boolean;
  createdAt: number;
}

export interface OrganizationDetails extends Organization {
  members: {
    userId: string;
    role: string;
    joinedAt: number;
  }[];
  subscription?: {
    status: string;
    plan: {
      name: string;
      tier: string;
      limits: PlanLimits;
    };
    currentPeriodEnd: number;
  };
}

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  lastUsedAt?: number;
  expiresAt?: number;
  createdAt: number;
  isActive: boolean;
}

export interface Plan {
  id: string;
  name: string;
  tier: string;
  description: string;
  price: number;
  currency: string;
  interval: string;
  features: { name: string; included: boolean }[];
  limits: PlanLimits;
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

// Activity Types
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
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  createdAt: number;
}

// Enhanced Types
export interface EnhancedTunnel {
  id: string;
  domain: string;
  customDomain?: string;
  agentId: string;
  createdAt: number;
  active: boolean;
  status: "online" | "offline" | "error";
  totalRequests: number;
  bytesIn: number;
  bytesOut: number;
  lastRequestAt?: number;
  avgResponseTime?: number;
  errorRate?: number;
  // TCP tunnel fields
  protocol?: "http" | "tcp";
  tcpPort?: number; // Public TCP port (e.g., 10001 for SSH tunnel)
}

export interface EnhancedAgent {
  id: string;
  domain: string;
  localPort: number;
  localHost: string;
  connectedAt: number;
  lastHeartbeat: number;
  active: boolean;
  clientIp?: string;
  platform?: string;
  platformVersion?: string;
  arch?: string;
  cliVersion?: string;
  cpuUsage?: number;
  memoryUsage?: number;
  signalStrength?: number;
  tunnelCount?: number;
  bytesIn?: number;
  bytesOut?: number;
  totalRequests?: number;
}

export interface DnsRecord {
  type: "A" | "CNAME" | "TXT";
  name: string;
  value: string;
  verified: boolean;
}

export interface EnhancedDomain {
  id: string;
  domain: string;
  baseDomain: boolean;
  certExpiry?: number;
  certbotEmail?: string; // legacy contact email (no longer used for issuance)
  createdAt: number;
  active: boolean;
  synced: boolean;
  sslStatus: "valid" | "expiring" | "expired" | "pending" | "none";
  dnsVerified: boolean;
  dnsRecords?: DnsRecord[];
  tunnelCount: number;
  // Cloudflare for SaaS (Custom Hostnames) — replaces Certbot/Let's Encrypt
  cnameTarget?: string; // DNS-only CNAME target the customer points their domain at
  cnameVerified?: boolean;
  ownershipVerification?: { type?: string; name?: string; value?: string };
  cfHostnameId?: string;
}

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
    totalIn: number;
    totalOut: number;
    periodIn: number;
    periodOut: number;
  };
  requests: {
    total: number;
    today: number;
    thisWeek: number;
  };
  plan: {
    name: string;
    tier: string;
    tunnelLimit: number;
    domainLimit: number;
    bandwidthLimit: number;
    usedTunnels: number;
    usedDomains: number;
    usedBandwidth: number;
  };
}

export interface BandwidthUsage {
  totalIn: number;
  totalOut: number;
  totalRequests: number;
  byTunnel: Array<{ tunnelId: string; bytesIn: number; bytesOut: number; requests: number }>;
  timeline: Array<{ date: string; bytesIn: number; bytesOut: number; requests: number }>;
}

// Security Types
export interface SecurityStats {
  http: {
    activeConnections: number;
    requestsBlocked: number;
    requestsRateLimited: number;
  };
  tcp: {
    activeConnections: number;
    connectionsBlocked: number;
    connectionsRateLimited: number;
  };
  blockedIps: number;
  logsBuffered: number;
}

export interface TunnelIpSecurity {
  mode: 'allow-all' | 'allowlist' | 'blocklist';
  allowedIps?: string[];
  blockedIps?: string[];
  updatedAt?: number;
  updatedBy?: string;
}

export interface BlockedIp {
  ip: string;
  reason: string;
  blockedAt: number;
  expiresAt: number;
}

export interface ConnectionLog {
  id: string;
  tunnelId: string;
  organizationId?: string;
  type: 'http' | 'tcp';
  remoteIp: string;
  timestamp: number;
  bytesIn: number;
  bytesOut: number;
  duration?: number;
  status: 'allowed' | 'blocked' | 'rate_limited';
  reason?: string;
}

export interface BandwidthLimit {
  allowed: boolean;
  usedBytes: number;
  limitBytes: number;
  percentUsed: number;
}

// Monitoring Types
export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'critical';
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
    heapUsed: number;
    heapTotal: number;
  };
  cpu: {
    loadAverage: number[];
    cores: number;
  };
  connections: {
    agents: number;
    clients: number;
    perIpCount: number;
    maxAgents: number;
    maxClients: number;
  };
  mapSizes: {
    pendingRequests: number;
    orgPlanCache: number;
    rateLimitStats: number;
    connectionsPerIp: number;
  };
}

export interface RateLimitStats {
  endpoint: string;
  hits: number;
  blocked: number;
  lastHit: number;
}

export interface AuthMetrics {
  successCount: number;
  failureCount: number;
  failureRate: number;
  topFailedIdentifiers: Array<{ identifier: string; count: number; lastAttempt: number }>;
}

export interface SystemLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface SystemMetricsSnapshot {
  timestamp: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  cpu: {
    user: number;
    system: number;
  };
  connections: {
    agents: number;
    clients: number;
  };
  mapSizes: {
    pendingRequests: number;
    orgPlanCache: number;
  };
}

export interface MonitoringConfig {
  maxAgentConnections: number;
  maxClientConnections: number;
  maxConnectionsPerIp: number;
  metricsRetentionDays: number;
}

export interface MonitoringDashboardData {
  health: SystemHealth;
  rateLimits: RateLimitStats[];
  auth: AuthMetrics;
  logs: SystemLog[];
  history: SystemMetricsSnapshot[];
  config: MonitoringConfig;
}

export interface SystemConfig {
  maxAgentConnections: number;
  maxClientConnections: number;
  maxConnectionsPerIp: number;
  rateLimits: {
    auth: { requests: number; windowMinutes: number };
    domain: { requests: number; windowHours: number };
    certificate: { requests: number; windowHours: number };
    http: { requests: number; windowMinutes: number };
  };
  features: {
    waitingListEnabled: boolean;
    autoCleanupEnabled: boolean;
    crossServerRoutingEnabled: boolean;
  };
}

export const api = new ApiClient();
