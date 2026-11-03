/**
 * What the edge cache leaves to jrok.
 *
 * nginx answers from its cache before jrok sees the request, so jrok's per-app
 * IP rules, suspensions and IP blocks never applied to cached responses: an
 * internal app limited to office addresses had the files it marks shareable
 * (Next.js bundles, data, images) served by every edge to anyone, for as long
 * as they stayed cached, and a suspended app kept being served the same way.
 *
 * jrok keeps two files the Ansible nginx role's nginx.conf includes, and
 * reloads nginx when either changes:
 * - JROK_CACHE_OFF_MAP (/etc/nginx/jrok-cache-off.map): every host of an app
 *   with IP rules (an allowlist, or a blocklist with addresses) or a
 *   suspension (of the app, or of its organization);
 * - JROK_BLOCKED_IPS_GEO (/etc/nginx/jrok-blocked-ips.geo): addresses blocked
 *   by hand (POST /security/block-ip). Flood blocks are left out: they protect
 *   the apps and tunnels, which cached files don't touch, and they come and go
 *   too often to reload nginx for each.
 * nginx neither answers those requests from the cache nor stores their
 * responses ($jrok_cache_off), so jrok's checks see every one.
 *
 * Rules reach every edge within 10 s (securitySync); this follows within
 * CHECK_MS, with at most one reload per MIN_RELOAD_GAP_MS. Nothing is written
 * until this edge has loaded the rules from MongoDB, and a lookup that fails
 * keeps what is on disk, so a restart during a MongoDB outage can't drop a
 * restriction. A server whose nginx.conf includes neither file (self-hosted,
 * or before the nginx deploy) is left alone.
 */
import { readFile, writeFile, rename, rm } from "fs/promises";
import { readFileSync } from "fs";
import { isIP } from "net";
import { allBaseDomains } from "../utils/baseDomains";
import { getCollections } from "../utils/mongodb";
import * as securityService from "./securityService";
import { securityRulesLoaded } from "./securitySync";
import { FLOOD_REASON_PREFIX } from "./floodGuard";
import { testAndReloadNginx, type NginxReloadResult } from "./certificateSyncService";

const CHECK_MS = 5_000;
const MIN_RELOAD_GAP_MS = 15_000;
// A content nginx refused is not tried again before this.
const RETRY_REFUSED_MS = 5 * 60_000;
// A reload that failed (nginx -t passed; nginx stopped, systemctl failing) is
// tried again after this, whether or not the rules change meanwhile.
const RETRY_FAILED_RELOAD_MS = 60_000;
// How long an organization's list of domains is reused.
const ORG_LOOKUP_MS = 60_000;

const HEADER = "# Written by jrok (src/services/edgeCacheRules.ts) whenever the rules change. Edits here are lost.\n";

export function cacheOffMapPath(): string {
  return process.env.JROK_CACHE_OFF_MAP || "/etc/nginx/jrok-cache-off.map";
}

export function blockedIpsGeoPath(): string {
  return process.env.JROK_BLOCKED_IPS_GEO || "/etc/nginx/jrok-blocked-ips.geo";
}

// Only characters that can't change the meaning of an nginx config line.
const NAME = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/;

/**
 * The hosts visitors reach an app's domain on: an app name under every base
 * domain, and a dotted name (a custom domain) as itself too. Anything unsafe
 * to write into nginx config gives none.
 */
export function hostsOfDomain(domain: string, bases: string[] = allBaseDomains()): string[] {
  const name = domain.trim().toLowerCase().replace(/\.+$/, "");
  if (!name || name.length > 253 || !NAME.test(name)) return [];
  const hosts = bases.map((base) => `${name}.${base}`);
  if (name.includes(".")) hosts.push(name);
  return hosts.filter((host) => host.length <= 253);
}

/** The cache-off map for these app domains. */
export function cacheOffMap(domains: Iterable<string>, bases: string[] = allBaseDomains()): string {
  const hosts = new Set<string>();
  for (const domain of domains) for (const host of hostsOfDomain(domain, bases)) hosts.add(host);
  return HEADER + [...hosts].sort().map((host) => `${host} 1;\n`).join("");
}

/** The blocked-address list for nginx's geo block; anything but a plain address is dropped. */
export function blockedIpsGeo(ips: Iterable<string>): string {
  const valid = new Set<string>();
  for (const ip of ips) {
    const address = ip.trim().toLowerCase();
    if (isIP(address) !== 0) valid.add(address);
  }
  return HEADER + [...valid].sort().map((ip) => `${ip} 1;\n`).join("");
}

/** Addresses blocked by hand: not by the flood guard, nor automatically. */
export function handBlockedIps(): string[] {
  return securityService.getBlockedIps()
    .filter((b) => !b.reason.startsWith(FLOOD_REASON_PREFIX) && !b.reason.startsWith("Auto-blocked:"))
    .map((b) => b.ip);
}

export type OrganizationDomains = (organizationIds: string[]) => Promise<unknown[]>;

/** Every domain of these organizations' apps, from MongoDB. */
const organizationDomainsFromDb: OrganizationDomains = async (organizationIds) => {
  const c = getCollections();
  const orgs = { $in: organizationIds };
  const found = await Promise.all([
    // checkSuspension goes by the API key's organization, else the tunnel's.
    c.agentConnections.distinct("domain", { $or: [{ apiKeyOrgId: orgs }, { organizationId: orgs }] }),
    c.tunnels.distinct("domain", { organizationId: orgs }),
    c.customDomains.distinct("domain", { organizationId: orgs }),
  ]);
  return found.flat();
};

let orgLookup: { key: string; at: number; domains: string[] } | null = null;

/** The organizations' domains, reused for ORG_LOOKUP_MS; null when MongoDB can't say and never could. */
async function domainsOfOrganizations(organizationIds: string[], now: number, lookup: OrganizationDomains): Promise<string[] | null> {
  const key = [...organizationIds].sort().join(",");
  if (orgLookup && orgLookup.key === key && now - orgLookup.at < ORG_LOOKUP_MS) return orgLookup.domains;
  try {
    const domains = (await lookup(organizationIds)).filter((d): d is string => typeof d === "string");
    orgLookup = { key, at: now, domains };
    return domains;
  } catch {
    return orgLookup && orgLookup.key === key ? orgLookup.domains : null;
  }
}

/** Every app domain the edge cache must leave to jrok, or null when that isn't known yet. */
export async function restrictedDomains(now = Date.now(), lookup: OrganizationDomains = organizationDomainsFromDb): Promise<string[] | null> {
  const domains = new Set(securityService.ipRestrictedKeys());
  const suspensions = securityService.getSuspensions();
  for (const s of suspensions.domains) domains.add(s.domain);
  if (suspensions.organizations.length > 0) {
    const ofOrgs = await domainsOfOrganizations(suspensions.organizations.map((o) => o.organizationId), now, lookup);
    if (ofOrgs === null) return null;
    for (const d of ofOrgs) domains.add(d);
  }
  return [...domains];
}

export interface EdgeCacheFiles {
  /** Path -> wanted content, for the files nginx.conf includes. */
  wanted: Map<string, string>;
  reload: () => Promise<NginxReloadResult>;
  now: number;
}

export type EdgeCacheOutcome = "unchanged" | "reloaded" | "waiting" | "refused" | "reload-failed";

let lastReloadAt = 0;
let refused: { content: string; at: number } | null = null;
// The files on disk are newer than what nginx runs: its reload failed.
let reloadPending = false;

async function readOrNull(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(() => null);
}

/**
 * Bring the files to what is wanted and reload nginx. When nginx -t refuses
 * the result, the files are put back as they were.
 */
export async function writeEdgeCacheFiles({ wanted, reload, now }: EdgeCacheFiles): Promise<EdgeCacheOutcome> {
  const previous = new Map<string, string | null>();
  for (const [path, content] of wanted) {
    const current = await readOrNull(path);
    if (current !== content) previous.set(path, current);
  }
  if (previous.size === 0 && !reloadPending) return "unchanged";

  const all = [...wanted.values()].join("\0");
  if (refused && refused.content === all && now - refused.at < RETRY_REFUSED_MS) return "refused";
  if (now - lastReloadAt < (reloadPending ? RETRY_FAILED_RELOAD_MS : MIN_RELOAD_GAP_MS)) return "waiting";

  for (const path of previous.keys()) await writeAtomically(path, wanted.get(path)!);
  const result = await reload();
  if (result === "test-failed") {
    for (const [path, content] of previous) {
      if (content === null) await rm(path, { force: true }).catch(() => {});
      else await writeAtomically(path, content).catch(() => {});
    }
    refused = { content: all, at: now };
    console.error("❌ nginx refused the edge cache rules; the previous ones were put back");
    return "refused";
  }
  lastReloadAt = now;
  refused = null;
  if (result !== "reloaded") {
    // nginx -t accepted the files, but nginx still runs the old rules: it
    // used to count as done, and was never reloaded for them.
    reloadPending = true;
    console.error(`❌ Edge cache rules written, but nginx was not reloaded (${result}); trying again in ${RETRY_FAILED_RELOAD_MS / 1000} s`);
    return "reload-failed";
  }
  reloadPending = false;
  console.log(`🧊 Edge cache rules updated (${[...previous.keys()].join(", ") || "reloaded again"})`);
  return "reloaded";
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, path);
}

/** Which of the two files nginx.conf includes (NGINX_CONF_PATH overrides where it is). */
export function includedFiles(): string[] {
  try {
    const conf = readFileSync(process.env.NGINX_CONF_PATH || "/etc/nginx/nginx.conf", "utf8");
    return [cacheOffMapPath(), blockedIpsGeoPath()].filter((path) => conf.includes(`include ${path};`));
  } catch {
    return [];
  }
}

/** One check: work out the rules from what this edge knows, and apply any change. */
export async function updateEdgeCacheRules(now = Date.now()): Promise<EdgeCacheOutcome | "off" | "not-ready"> {
  const files = includedFiles();
  if (files.length === 0) return "off";
  if (!securityRulesLoaded() || !securityService.ipSecurityLoadedFromDb()) return "not-ready";
  const domains = await restrictedDomains(now);
  if (domains === null) return "not-ready";

  const wanted = new Map<string, string>();
  if (files.includes(cacheOffMapPath())) wanted.set(cacheOffMapPath(), cacheOffMap(domains));
  if (files.includes(blockedIpsGeoPath())) wanted.set(blockedIpsGeoPath(), blockedIpsGeo(handBlockedIps()));
  return writeEdgeCacheFiles({ wanted, reload: testAndReloadNginx, now });
}

let timer: Timer | null = null;
let checking = false;

export function startEdgeCacheRules(): void {
  if (timer) return;
  timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await updateEdgeCacheRules();
    } catch (error: any) {
      console.error("⚠️ Edge cache rules not updated:", error?.message || error);
    } finally {
      checking = false;
    }
  }, CHECK_MS);
  timer.unref?.();
}

export function stopEdgeCacheRules(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** For tests: forget past reloads and refusals. */
export function resetEdgeCacheRules(): void {
  lastReloadAt = 0;
  refused = null;
  reloadPending = false;
  orgLookup = null;
}
