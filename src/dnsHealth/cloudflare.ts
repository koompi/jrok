/**
 * The few Cloudflare DNS calls health-checked DNS needs. Records stay DNS-only
 * (never proxied, decision D1).
 */
import { readFileSync } from "fs";
import { recordType } from "./decide";

export interface AddressRecord {
  id: string;
  name: string;
  type: "A" | "AAAA";
  content: string;
  /** Added by a checker (it carries the checkers' comment), so a checker may also take it away. */
  managed: boolean;
}

/** The comment on records the checkers add. */
export const MANAGED_COMMENT = "jrok dns-health";

/**
 * The API token: CLOUDFLARE_API_TOKEN, or the `dns_cloudflare_api_token` line
 * of CLOUDFLARE_API_TOKEN_FILE (certbot's credentials file, already on every
 * edge), so the token isn't copied anywhere else.
 */
export function cloudflareToken(env = process.env): string {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN.trim();
  if (env.CLOUDFLARE_API_TOKEN_FILE) {
    const match = readFileSync(env.CLOUDFLARE_API_TOKEN_FILE, "utf8").match(/^\s*dns_cloudflare_api_token\s*=\s*(\S+)/m);
    if (match) return match[1]!;
  }
  throw new Error("Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_TOKEN_FILE");
}

export class CloudflareDns {
  private zoneIds = new Map<string, string>();

  constructor(
    private token: string,
    private options: { ttl?: number; comment?: string; apiBase?: string; zoneId?: string } = {}
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.options.apiBase ?? "https://api.cloudflare.com/client/v4"}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const reason = json.errors?.map((e: any) => e.message).join("; ") || `HTTP ${res.status}`;
      throw new Error(`Cloudflare ${method} ${path.split("?")[0]}: ${reason}`);
    }
    return json.result;
  }

  /** The zone holding `name`: DNS_HEALTH_ZONE_ID if set, else the longest zone name it ends with. */
  async zoneIdFor(name: string): Promise<string> {
    if (this.options.zoneId) return this.options.zoneId;
    const cached = this.zoneIds.get(name);
    if (cached) return cached;
    const labels = name.replace(/^\*\./, "").split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join(".");
      const zones = await this.call("GET", `/zones?name=${encodeURIComponent(candidate)}`);
      if (zones?.[0]?.id) {
        this.zoneIds.set(name, zones[0].id);
        return zones[0].id;
      }
    }
    throw new Error(`No Cloudflare zone this token can see holds ${name}`);
  }

  /** The A and AAAA records named exactly `name` ("*.example.com" included). */
  async addressRecords(name: string): Promise<AddressRecord[]> {
    const zone = await this.zoneIdFor(name);
    const records: any[] = await this.call("GET", `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
    return records
      .filter((r) => (r.type === "A" || r.type === "AAAA") && r.name === name)
      .map((r) => ({ id: r.id, name: r.name, type: r.type, content: r.content, managed: r.comment === (this.options.comment ?? MANAGED_COMMENT) }));
  }

  async addAddress(name: string, address: string): Promise<void> {
    const zone = await this.zoneIdFor(name);
    await this.call("POST", `/zones/${zone}/dns_records`, {
      type: recordType(address),
      name,
      content: address,
      ttl: this.options.ttl ?? 60,
      proxied: false,
      comment: this.options.comment ?? MANAGED_COMMENT,
    });
  }

  async removeRecord(name: string, recordId: string): Promise<void> {
    const zone = await this.zoneIdFor(name);
    await this.call("DELETE", `/zones/${zone}/dns_records/${recordId}`);
  }
}
