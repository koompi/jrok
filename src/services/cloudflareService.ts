/**
 * Cloudflare for SaaS — Custom Hostnames client
 * =============================================================================
 * Replaces Certbot/Let's Encrypt for customer custom domains. Instead of issuing
 * and syncing certs ourselves, we register the customer's hostname with
 * Cloudflare for SaaS; Cloudflare provisions, serves, and auto-renews the edge
 * certificate for that hostname on OUR zone.
 *
 * Customer flow (see custom-domain docs):
 *   1. We create a custom hostname for `app.client.com` here.
 *   2. Customer adds  `app.client.com  CNAME  <CF_SAAS_FALLBACK_HOSTNAME>`  as
 *      DNS only (grey cloud — never orange, or they hit Error 1014).
 *   3. Cloudflare validates ownership + issues the cert; we poll until active.
 *
 * Required env:
 *   CF_API_TOKEN   — token with "SSL and Certificates: Edit" on the zone
 *   CF_ZONE_ID     — the zone that owns the fallback origin (e.g. live.koompi.cloud)
 * =============================================================================
 */

import type { CustomHostnameOwnership } from "../types/index";

const CF_API = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CF_API_TOKEN || "";
const ZONE_ID = process.env.CF_ZONE_ID || "";

export interface CustomHostnameResult {
  id: string;
  hostname: string;
  status: string;     // hostname status: pending | active | ...
  sslStatus: string;  // ssl status: pending | pending_validation | active | ...
  ownership?: CustomHostnameOwnership;
}

/** Whether Cloudflare for SaaS is configured on this server. */
export function isConfigured(): boolean {
  return Boolean(TOKEN && ZONE_ID);
}

async function cfFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    const errs = Array.isArray(json?.errors)
      ? json.errors.map((e: any) => e.message).join("; ")
      : res.statusText;
    throw new Error(`Cloudflare API error (${res.status}): ${errs}`);
  }
  return json.result;
}

function normalize(result: any): CustomHostnameResult {
  const ov = result?.ownership_verification || {};
  const ownership: CustomHostnameOwnership | undefined =
    ov.type || ov.name ? { type: ov.type, name: ov.name, value: ov.value } : undefined;

  return {
    id: result.id,
    hostname: result.hostname,
    status: result.status || "pending",
    sslStatus: result?.ssl?.status || "pending",
    ownership,
  };
}

/** Register a custom hostname. Cloudflare provisions + auto-renews its edge cert. */
export async function createCustomHostname(hostname: string): Promise<CustomHostnameResult> {
  const result = await cfFetch(`/zones/${ZONE_ID}/custom_hostnames`, {
    method: "POST",
    body: JSON.stringify({
      hostname,
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    }),
  });
  console.log(`☁️  Cloudflare custom hostname created: ${hostname} (${result.id})`);
  return normalize(result);
}

/** Fetch current status of a custom hostname (poll until ssl/status === 'active'). */
export async function getCustomHostname(id: string): Promise<CustomHostnameResult> {
  const result = await cfFetch(`/zones/${ZONE_ID}/custom_hostnames/${id}`);
  return normalize(result);
}

/** Look up an existing custom hostname by its name (recovery if we lost the id). */
export async function findCustomHostnameByName(hostname: string): Promise<CustomHostnameResult | null> {
  const result = await cfFetch(
    `/zones/${ZONE_ID}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`
  );
  if (Array.isArray(result) && result.length > 0) return normalize(result[0]);
  return null;
}

export async function deleteCustomHostname(id: string): Promise<void> {
  await cfFetch(`/zones/${ZONE_ID}/custom_hostnames/${id}`, { method: "DELETE" });
  console.log(`☁️  Cloudflare custom hostname deleted: ${id}`);
}
