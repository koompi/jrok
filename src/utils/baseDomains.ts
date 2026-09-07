/**
 * Base domain matching.
 *
 * A jrok server serves tunnels under a base domain — "shop" becomes
 * shop.public.koompi.cloud. Renaming that base domain is customer-visible in a
 * way that a normal deploy is not: every deployed URL changes, every OAuth
 * redirect URI registered with an identity provider stops matching, and every
 * customer CNAME points at the old name. Done as a flag day, it breaks all of
 * them at once.
 *
 * So a server accepts SEVERAL base domains: one primary, which is what new
 * URLs are generated with, plus any number of legacy names that keep resolving
 * for everything already out there. The rename then happens by configuration,
 * at whatever pace customers can be migrated, instead of in a single cutover.
 *
 *   BASE_DOMAIN=public.koompi.cloud
 *   LEGACY_BASE_DOMAINS=tunnel.koompi.cloud
 *
 * Both must have DNS and a wildcard certificate for as long as both are
 * accepted. LEGACY_BASE_DOMAINS may be dropped once nothing resolves there.
 */

/** Domains this server answers for, primary first. */
export function allBaseDomains(): string[] {
  const primary = (process.env.BASE_DOMAIN || "tunnel.example.com").toLowerCase().trim();
  const legacy = (process.env.LEGACY_BASE_DOMAINS || "")
    .split(",")
    .map((d) => d.toLowerCase().trim())
    .filter(Boolean);

  // De-duplicate, keeping the primary first — callers rely on [0] being the
  // name to generate new URLs with.
  return [...new Set([primary, ...legacy])];
}

/** The domain new tunnel URLs are built with. */
export function primaryBaseDomain(): string {
  return allBaseDomains()[0]!;
}

/**
 * Which base domain this hostname belongs to, or null if it is neither one of
 * ours nor a subdomain of one (i.e. it is a custom domain, or unknown).
 *
 * Matching is exact on the label boundary: "notpublic.koompi.cloud" must not
 * match a base domain of "public.koompi.cloud", which a plain endsWith() would
 * wrongly accept and route to a stranger's tunnel.
 */
export function matchBaseDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().trim();
  for (const base of allBaseDomains()) {
    if (host === base || host.endsWith(`.${base}`)) return base;
  }
  return null;
}

/** True when the hostname is a tunnel subdomain, e.g. shop.public.koompi.cloud. */
export function isTunnelSubdomain(hostname: string): boolean {
  const base = matchBaseDomain(hostname);
  return base !== null && hostname.toLowerCase().trim() !== base;
}

/**
 * The tunnel name from a hostname — "shop" from shop.public.koompi.cloud —
 * or null when the hostname is not a tunnel subdomain of any accepted base.
 */
export function extractSubdomain(hostname: string): string | null {
  const host = hostname.toLowerCase().trim();
  const base = matchBaseDomain(host);
  if (!base || host === base) return null;
  return host.slice(0, -(base.length + 1)) || null;
}
