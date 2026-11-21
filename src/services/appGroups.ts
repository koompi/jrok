/**
 * Which apps belong to the same customer, for the cross-app guard
 * (crossAppGuard.ts).
 *
 * jrok can't tell: every KOOMPI Cloud app connects with the platform's own key,
 * so to jrok they are all one organization. KOOMPI Cloud knows, and pushes the
 * map here (PUT /security/app-groups) whenever it changes: an app's tunnel name
 * ("shop" for shop.public.koompi.cloud) or custom domain -> an opaque group id
 * (KOOMPI Cloud hashes the organization's id). It is kept with the shared
 * security rules (securitySync.ts, kind "app-groups"), so every edge has it
 * within a sync; `version` is KOOMPI Cloud's hash of the map, which it compares
 * before pushing again.
 *
 * Never loaded (or an app missing from it): the app's group is unknown, and the
 * guard only reports.
 */

export interface AppGroups {
  version: string;
  /** Tunnel name -> group id. */
  labels: Record<string, string>;
  /** Custom domain (full host) -> group id. */
  domains: Record<string, string>;
}

/** As saved in MongoDB: pairs, since a custom domain's dots can't be field names. */
export interface StoredAppGroups {
  version?: unknown;
  labels?: unknown;
  domains?: unknown;
}

/** Room for every app KOOMPI Cloud plans for (<5000 services) many times over. */
export const MAX_APP_GROUP_ENTRIES = 100_000;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const GROUP = /^[0-9a-f]{16,64}$/;
const VERSION = /^[0-9a-f]{8,64}$/;

let labels = new Map<string, string>();
let domains = new Map<string, string>();
let version: string | null = null;
let loadedAt: number | null = null;

const validName = (name: string) => NAME.test(name) && !name.includes("..");

function readPairs(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(value)) return map;
  for (const pair of value) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
    if (validName(pair[0]) && GROUP.test(pair[1])) map.set(pair[0], pair[1]);
  }
  return map;
}

/** Take the map saved in MongoDB (or just pushed) as this server's. */
export function loadAppGroups(stored: StoredAppGroups): void {
  labels = readPairs(stored.labels);
  domains = readPairs(stored.domains);
  version = typeof stored.version === "string" ? stored.version : null;
  loadedAt = Date.now();
}

/** A pushed map as it is saved: entries as [name, group] pairs, sorted. */
export function toStored(groups: AppGroups): { version: string; labels: [string, string][]; domains: [string, string][] } {
  const pairs = (record: Record<string, string>) =>
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as [string, string][];
  return { version: groups.version, labels: pairs(groups.labels), domains: pairs(groups.domains) };
}

/**
 * The body of PUT /security/app-groups, checked: `{version, labels, domains}`,
 * names lower-case host labels or hosts, groups hex.
 */
export function parseAppGroups(body: unknown): { ok: true; value: AppGroups } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send {version, labels, domains}" };
  const input = body as Record<string, unknown>;
  if (typeof input.version !== "string" || !VERSION.test(input.version)) {
    return { ok: false, error: "version: 8-64 lower-case hex characters" };
  }
  const value: AppGroups = { version: input.version, labels: {}, domains: {} };
  let count = 0;
  for (const field of ["labels", "domains"] as const) {
    const record = input[field] ?? {};
    if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false, error: `${field}: an object of name -> group` };
    for (const [name, group] of Object.entries(record as Record<string, unknown>)) {
      if (++count > MAX_APP_GROUP_ENTRIES) return { ok: false, error: `More than ${MAX_APP_GROUP_ENTRIES} entries` };
      if (!validName(name)) return { ok: false, error: `${field}: "${name.slice(0, 80)}" is not a lower-case host name` };
      if (field === "domains" && !name.includes(".")) return { ok: false, error: `domains: "${name.slice(0, 80)}" is not a full host` };
      if (typeof group !== "string" || !GROUP.test(group)) return { ok: false, error: `${field}: the group of "${name.slice(0, 80)}" is not 16-64 hex characters` };
      value[field][name] = group;
    }
  }
  return { ok: true, value };
}

/** The group of the app with this tunnel name, if KOOMPI Cloud said. */
export function groupOfLabel(label: string): string | undefined {
  return labels.get(label);
}

/** The group of the app on this custom domain, if KOOMPI Cloud said. */
export function groupOfDomain(host: string): string | undefined {
  return domains.get(host);
}

export function appGroupsStatus(): { loaded: boolean; version: string | null; labels: number; domains: number; loadedAt: string | null } {
  return {
    loaded: loadedAt !== null,
    version,
    labels: labels.size,
    domains: domains.size,
    loadedAt: loadedAt === null ? null : new Date(loadedAt).toISOString(),
  };
}

/** For tests: back to "never loaded". */
export function resetAppGroups(): void {
  labels = new Map();
  domains = new Map();
  version = null;
  loadedAt = null;
}
