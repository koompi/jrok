/**
 * Whose request is this: a customer's tunnel, or jrok's own management API?
 *
 * jrok used to answer ~80 management routes (/auth/*, /plans, /organizations*,
 * /admin/*, /stats/*, /security/*, ...) by PATH alone, before it looked at the
 * Host. On every customer subdomain and custom domain those paths therefore
 * belonged to jrok, not to the customer's app. The worst case was
 * /auth/callback: a customer app's OAuth redirect was answered with a 302 to
 * jrok's dashboard carrying the app's `code` and `state`.
 *
 * So the Host is classified FIRST, and a tunnel host is routed to its tunnel
 * whatever the path:
 *
 *   1. JROK_API_HOSTS                 management (operator says so; wins over 3)
 *   2. IP literal, localhost          management (health checks, the certbot hook,
 *                                     peer servers, nothing a customer can own)
 *   3. <name>.<base domain>           tunnel
 *   4. <base domain> itself           management (tunnel.koompi.cloud is the API)
 *   5. anything else                  a custom domain if one is registered and
 *                                     active -> tunnel; otherwise management, as
 *                                     before (a host with no tunnel behind it
 *                                     has no customer app to hijack). Set
 *                                     JROK_STRICT_API_HOSTS=true to refuse those
 *                                     instead, once every API client uses a
 *                                     host covered by 1, 2 or 4.
 *
 * The lookup in step 5 is the caller's (it needs the database); this module
 * stays pure so it can be tested.
 */

import { matchBaseDomain, extractSubdomain, allBaseDomains } from "./baseDomains";

/** Lower-case, no port, no trailing dot. "Shop.Example.COM." -> "shop.example.com". */
export function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  if (colon !== -1 && host.indexOf(":", colon + 1) === -1) host = host.slice(0, colon);
  return host.replace(/\.+$/, "");
}

/** Accepts bare hosts, host:port, or full URLs, so the env var is forgiving. */
function hostFromEntry(entry: string): string | null {
  const value = entry.trim();
  if (!value) return null;
  if (value.includes("://")) {
    try {
      return normalizeHostname(new URL(value).hostname);
    } catch {
      return null;
    }
  }
  return normalizeHostname(value.split("/")[0] || "");
}

/**
 * Hosts that always serve the management API, even if they look like a tunnel
 * subdomain (e.g. JROK_API_HOSTS=api.tunnel.example.com). Base-domain apexes,
 * localhost and IP literals are management without being listed.
 */
export function managementHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const entry of (process.env.JROK_API_HOSTS || "").split(",")) {
    const host = hostFromEntry(entry);
    if (host) hosts.add(host);
  }
  return hosts;
}

export function strictApiHosts(): boolean {
  return (process.env.JROK_STRICT_API_HOSTS || "").trim().toLowerCase() === "true";
}

const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isIpLiteralHost(host: string): boolean {
  return IPV4_HOST.test(host) || (host.startsWith("[") && host.endsWith("]"));
}

export type HostRoute =
  /** jrok's own API. `listed` is false for the backward-compatible fallback (step 5 miss). */
  | { kind: "management"; listed: boolean }
  /** A tunnel subdomain; `name` is what agents register, e.g. "shop". */
  | { kind: "tunnel"; name: string }
  /** Not ours by name: a custom domain if the database says so. */
  | { kind: "custom-candidate"; host: string };

/** Steps 1-4 above, plus the hand-off for step 5. `host` must be normalized. */
export function classifyHost(host: string): HostRoute {
  if (managementHosts().has(host)) return { kind: "management", listed: true };
  if (host === "localhost" || isIpLiteralHost(host)) return { kind: "management", listed: true };

  const base = matchBaseDomain(host);
  if (base !== null) {
    const name = extractSubdomain(host);
    return name ? { kind: "tunnel", name } : { kind: "management", listed: true };
  }

  return { kind: "custom-candidate", host };
}

/**
 * jrok's own OAuth redirect (KOOMPI_REDIRECT_URI, normally <api host>/auth/callback)
 * is jrok's whatever host it names. Kept on the management side even if an
 * operator pointed it at a host that classifies as a tunnel, so a quirky
 * deployment doesn't lose dashboard login; it cannot match a customer's host
 * unless the operator configured jrok's redirect to be that host.
 */
export function isOwnOAuthRedirect(host: string, path: string): boolean {
  const configured = process.env.KOOMPI_REDIRECT_URI;
  if (!configured) return false;
  try {
    const url = new URL(configured);
    return url.pathname === "/auth/callback" && path === "/auth/callback" && normalizeHostname(url.hostname) === host;
  } catch {
    return false;
  }
}

/**
 * The agent upgrade on a TUNNEL host. Agents are meant to dial the API host,
 * but an old deploy may point --server somewhere else; rather than strand it,
 * a request that carries the agent handshake (domain + localPort + a jrok
 * credential) is still taken as one. A customer app's own /ws/agent socket
 * doesn't carry those and goes to the app.
 */
export function looksLikeAgentHandshake(url: URL, headers: Headers): boolean {
  const params = url.searchParams;
  if (!params.get("domain") || !params.get("localPort")) return false;
  const authz = headers.get("authorization") || "";
  return params.has("auth") || /^bearer\s+jrok_/i.test(authz.trim());
}

/** Summary for the startup log. */
export function describeManagementHosts(): string {
  const listed = [...managementHosts()];
  const parts = [
    ...allBaseDomains(),
    ...listed,
    "localhost",
    "IP literals",
  ];
  return `${[...new Set(parts)].join(", ")}${strictApiHosts() ? " (strict)" : " + any non-tunnel host"}`;
}
