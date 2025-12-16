// In development, use the proxy (/api -> localhost:3000)
// In production, use the actual API URL from env
const API_BASE = import.meta.env.VITE_API_URL || '/api';

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

export const api = new ApiClient();
