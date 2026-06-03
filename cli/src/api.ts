/** Typed REST client for the kproxy server API. */

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Tunnel {
  id?: string;
  domain: string;
  customDomain?: string;
  protocol?: string;
  tcpPort?: number;
  active?: boolean;
  createdAt?: number;
}

export interface Organization {
  id?: string;
  _id?: string;
  name: string;
  slug: string;
  role?: string;
  plan?: string;
}

export interface ApiKeyInfo {
  id?: string;
  _id?: string;
  name: string;
  keyPrefix?: string;
  permissions?: string[];
  createdAt?: string;
  lastUsedAt?: string;
}

export interface DomainInfo {
  domain: string;
  cnameTarget?: string;
  targetSubdomain?: string;
  active?: boolean;
  synced?: boolean;
  certExpiry?: number;
  sslStatus?: string;
  // verify-status shape:
  verified?: boolean;
  actualCname?: string;
  error?: string;
}

export class KproxyApi {
  constructor(private readonly serverUrl: string, private readonly token?: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
      headers["X-API-Key"] = this.token;
    }
    if (init?.body) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}${path}`, { ...init, headers });
    } catch (err) {
      throw new ApiError(0, `Could not reach ${this.serverUrl} (${err instanceof Error ? err.message : String(err)})`);
    }

    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text };
    }
    if (!res.ok) {
      throw new ApiError(res.status, json.message || json.error || `${res.status} ${res.statusText}`);
    }
    return json as T;
  }

  // ---- Tunnels ----
  listTunnels(): Promise<{ tunnels?: Tunnel[] } & Tunnel[]> {
    return this.request("/tunnels");
  }
  deleteTunnel(domain: string): Promise<unknown> {
    return this.request(`/tunnels/${encodeURIComponent(domain)}`, { method: "DELETE" });
  }

  // ---- Organizations ----
  listOrganizations(): Promise<{ organizations?: Organization[] } & Organization[]> {
    return this.request("/organizations");
  }
  createOrganization(name: string): Promise<{ organization?: Organization } & Organization> {
    return this.request("/organizations", { method: "POST", body: JSON.stringify({ name }) });
  }

  // ---- API keys ----
  listApiKeys(orgId: string): Promise<{ apiKeys?: ApiKeyInfo[] } & ApiKeyInfo[]> {
    return this.request(`/organizations/${orgId}/api-keys`);
  }
  createApiKey(orgId: string, name: string, permissions: string[]): Promise<{ rawKey?: string; key?: string }> {
    return this.request(`/organizations/${orgId}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name, permissions }),
    });
  }
  revokeApiKey(orgId: string, keyId: string): Promise<unknown> {
    return this.request(`/organizations/${orgId}/api-keys/${keyId}`, { method: "DELETE" });
  }

  // ---- Custom domains ----
  registerDomain(domain: string, email: string, subdomain?: string): Promise<{ domain?: DomainInfo } & DomainInfo> {
    // Send both `email` (preferred by the new server) and `certbotEmail` (legacy) for compatibility.
    return this.request("/domains", {
      method: "POST",
      body: JSON.stringify({ domain, email, certbotEmail: email, subdomain }),
    });
  }
  domainStatus(domain: string): Promise<DomainInfo> {
    return this.request(`/domains/${encodeURIComponent(domain)}/verify-status`);
  }
  verifyDomain(domain: string): Promise<{ domain?: DomainInfo } & DomainInfo> {
    return this.request(`/domains/${encodeURIComponent(domain)}/verify`, { method: "POST" });
  }
  listDomains(): Promise<{ domains?: DomainInfo[] } & DomainInfo[]> {
    return this.request("/domains");
  }

  // ---- Auth ----
  getLoginUrl(): Promise<{ url?: string; loginUrl?: string }> {
    return this.request("/auth/login");
  }
  cliStart(label?: string): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    intervalSec: number;
    expiresInSec: number;
  }> {
    return this.request("/auth/cli/start", { method: "POST", body: JSON.stringify({ label }) });
  }
  cliPoll(deviceCode: string): Promise<{
    status: "pending" | "approved" | "denied" | "expired";
    apiKey?: string;
    organizationId?: string;
  }> {
    return this.request("/auth/cli/poll", { method: "POST", body: JSON.stringify({ deviceCode }) });
  }
  exchangeCode(code: string): Promise<any> {
    return this.request("/auth/callback", { method: "POST", body: JSON.stringify({ code }) });
  }
  me(): Promise<any> {
    return this.request("/auth/me");
  }
  health(): Promise<{ success?: boolean; serverId?: string }> {
    return this.request("/health");
  }
}
