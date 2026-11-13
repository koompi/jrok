/**
 * The edge cache leaves to jrok every request whose app has IP rules or a
 * suspension, or whose address is blocked by hand (services/edgeCacheRules.ts).
 * It used to answer them from its cache before jrok's checks ran: an internal
 * app limited to office addresses had its cached files served to anyone.
 *
 * The nginx side (the maps in the Ansible role's nginx.conf, template v5) was
 * checked with nginx 1.18; here, what jrok writes into the files nginx includes.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { mkdtemp, readFile, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as securityService from "../src/services/securityService";
import { resetSecuritySync } from "../src/services/securitySync";
import {
  blockedIpsGeo,
  cacheOffMap,
  handBlockedIps,
  hostsOfDomain,
  resetEdgeCacheRules,
  restrictedDomains,
  updateEdgeCacheRules,
  writeEdgeCacheFiles,
} from "../src/services/edgeCacheRules";
import { FLOOD_REASON_PREFIX } from "../src/services/floodGuard";

const BASES = ["public.koompi.cloud", "tunnel.koompi.cloud"];
const DIR = await mkdtemp(join(tmpdir(), "jrok-edge-cache-"));
const MAP = join(DIR, "jrok-cache-off.map");
const GEO = join(DIR, "jrok-blocked-ips.geo");

afterAll(async () => { await rm(DIR, { recursive: true, force: true }); });
beforeEach(() => resetEdgeCacheRules());

const lines = (content: string) => content.split("\n").filter((l) => l && !l.startsWith("#"));

test("an app is left to jrok on every base domain; a custom domain as itself", () => {
  expect(hostsOfDomain("office-app", BASES)).toEqual(["office-app.public.koompi.cloud", "office-app.tunnel.koompi.cloud"]);
  expect(hostsOfDomain("Shop.Example.com.", BASES)).toContain("shop.example.com");
});

test("a name that could change an nginx config line gives no host", () => {
  for (const bad of ["x; include /etc/passwd", "a b", "evil{", "$host", "a\nb", "x'y", "", "-lead.example.com"]) {
    expect(hostsOfDomain(bad, BASES)).toEqual([]);
  }
});

test("the cache-off map: one line per host, sorted, the same for the same rules", () => {
  const map = cacheOffMap(["zeta", "alpha", "shop.example.com", "alpha"], BASES);
  expect(lines(map)).toEqual([
    "alpha.public.koompi.cloud 1;",
    "alpha.tunnel.koompi.cloud 1;",
    "shop.example.com 1;",
    "shop.example.com.public.koompi.cloud 1;",
    "shop.example.com.tunnel.koompi.cloud 1;",
    "zeta.public.koompi.cloud 1;",
    "zeta.tunnel.koompi.cloud 1;",
  ]);
  expect(cacheOffMap(["alpha", "shop.example.com", "zeta"], BASES)).toBe(map);
});

test("the blocked-address list takes plain addresses only", () => {
  expect(lines(blockedIpsGeo(["203.0.113.9", "2001:DB8::1", "1.2.3.4; include /etc/passwd", "10.0.0.0/8", "nope"])))
    .toEqual(["2001:db8::1 1;", "203.0.113.9 1;"]);
});

test("addresses blocked by hand are left to jrok; flood blocks are not", () => {
  securityService.blockIp("198.51.100.7", "Scraping customer apps", 600);
  securityService.blockIp("198.51.100.8", `${FLOOD_REASON_PREFIX} over 3000 requests in 10 s`, 600);
  try {
    expect(handBlockedIps()).toContain("198.51.100.7");
    expect(handBlockedIps()).not.toContain("198.51.100.8");
  } finally {
    securityService.unblockIp("198.51.100.7");
    securityService.unblockIp("198.51.100.8");
  }
});

test("apps with an allowlist, a blocklist with addresses, or a suspension are left to jrok; open apps are not", async () => {
  securityService.holdTunnelIpSecurity("ec-office", { mode: "allowlist", allowedIps: ["203.0.113.0/24"] });
  securityService.holdTunnelIpSecurity("ec-nobody-yet", { mode: "allowlist", allowedIps: [] });
  securityService.holdTunnelIpSecurity("ec-blocks-one", { mode: "blocklist", blockedIps: ["198.51.100.1"] });
  securityService.holdTunnelIpSecurity("ec-empty-blocklist", { mode: "blocklist", blockedIps: [] });
  securityService.holdTunnelIpSecurity("ec-open", { mode: "allow-all" });
  securityService.suspendDomain("ec-unpaid");
  try {
    const domains = (await restrictedDomains())!;
    expect(domains).toEqual(expect.arrayContaining(["ec-office", "ec-nobody-yet", "ec-blocks-one", "ec-unpaid"]));
    expect(domains).not.toContain("ec-empty-blocklist");
    expect(domains).not.toContain("ec-open");
  } finally {
    for (const key of ["ec-office", "ec-nobody-yet", "ec-blocks-one", "ec-empty-blocklist", "ec-open"]) {
      securityService.holdTunnelIpSecurity(key, { mode: "allow-all" });
    }
    securityService.unsuspendDomain("ec-unpaid");
  }
});

test("a suspended organization's apps are left to jrok; while MongoDB can't say which they are, nothing changes", async () => {
  securityService.suspendOrganization("ec-org");
  try {
    let asked: string[] = [];
    const domains = await restrictedDomains(1_000, async (orgs) => { asked = orgs; return ["ec-org-app", "shop.ec-org.com", null]; });
    expect(asked).toEqual(["ec-org"]);
    expect(domains).toEqual(expect.arrayContaining(["ec-org-app", "shop.ec-org.com"]));

    // Asked again a minute later, MongoDB down: the last answer stands.
    const later = await restrictedDomains(70_000, async () => { throw new Error("MongoDB down"); });
    expect(later).toEqual(expect.arrayContaining(["ec-org-app"]));

    // Never answered: null, so the files on disk stay as they are.
    resetEdgeCacheRules();
    expect(await restrictedDomains(1_000, async () => { throw new Error("MongoDB down"); })).toBeNull();
  } finally {
    securityService.unsuspendOrganization("ec-org");
  }
});

const reloads: string[] = [];
const reloadOk = async () => { reloads.push("ok"); return "reloaded" as const; };
const reloadRefused = async () => { reloads.push("refused"); return "test-failed" as const; };

test("written once and nginx reloaded; the same rules again change nothing", async () => {
  await rm(MAP, { force: true });
  reloads.length = 0;
  const wanted = new Map([[MAP, cacheOffMap(["office"], BASES)]]);
  expect(await writeEdgeCacheFiles({ wanted, reload: reloadOk, now: 1_000_000 })).toBe("reloaded");
  expect(await readFile(MAP, "utf8")).toContain("office.public.koompi.cloud 1;");
  expect(await writeEdgeCacheFiles({ wanted, reload: reloadOk, now: 2_000_000 })).toBe("unchanged");
  expect(reloads).toEqual(["ok"]);
});

test("changes come at most one reload per 15 s", async () => {
  await writeFile(MAP, "# empty\n");
  expect(await writeEdgeCacheFiles({ wanted: new Map([[MAP, cacheOffMap(["a"], BASES)]]), reload: reloadOk, now: 3_000_000 })).toBe("reloaded");
  expect(await writeEdgeCacheFiles({ wanted: new Map([[MAP, cacheOffMap(["b"], BASES)]]), reload: reloadOk, now: 3_005_000 })).toBe("waiting");
  expect(await writeEdgeCacheFiles({ wanted: new Map([[MAP, cacheOffMap(["b"], BASES)]]), reload: reloadOk, now: 3_016_000 })).toBe("reloaded");
});

test("when nginx refuses the rules, the files are put back and the same rules aren't tried again soon", async () => {
  await writeFile(MAP, "# what nginx runs with\n");
  await rm(GEO, { force: true });
  reloads.length = 0;
  const wanted = new Map([[MAP, cacheOffMap(["office"], BASES)], [GEO, blockedIpsGeo(["203.0.113.9"])]]);
  expect(await writeEdgeCacheFiles({ wanted, reload: reloadRefused, now: 4_000_000 })).toBe("refused");
  expect(await readFile(MAP, "utf8")).toBe("# what nginx runs with\n");
  expect(await readFile(GEO, "utf8").catch(() => null)).toBeNull();
  expect(await writeEdgeCacheFiles({ wanted, reload: reloadRefused, now: 4_060_000 })).toBe("refused");
  expect(reloads).toEqual(["refused"]);
});

test("a reload that failed is tried again, though the files already say what is wanted", async () => {
  await writeFile(MAP, "# empty\n");
  reloads.length = 0;
  const reloadFailed = async () => { reloads.push("failed"); return "reload-failed" as const; };
  const wanted = new Map([[MAP, cacheOffMap(["office"], BASES)]]);
  // nginx -t passes but the reload doesn't happen: nginx still runs the old rules.
  expect(await writeEdgeCacheFiles({ wanted, reload: reloadFailed, now: 5_000_000 })).toBe("reload-failed");
  expect(await readFile(MAP, "utf8")).toContain("office.public.koompi.cloud 1;");
  // It used to count as done: "unchanged" from then on, never reloaded.
  expect(await writeEdgeCacheFiles({ wanted, reload: reloadOk, now: 5_030_000 })).toBe("waiting");
  expect(await writeEdgeCacheFiles({ wanted, reload: reloadOk, now: 5_061_000 })).toBe("reloaded");
  expect(await writeEdgeCacheFiles({ wanted, reload: reloadOk, now: 5_200_000 })).toBe("unchanged");
  expect(reloads).toEqual(["failed", "ok"]);
});

test("nothing is written where nginx.conf includes neither file, nor before this edge has loaded the rules", async () => {
  const conf = join(DIR, "nginx.conf");
  const saved = { conf: process.env.NGINX_CONF_PATH, map: process.env.JROK_CACHE_OFF_MAP, geo: process.env.JROK_BLOCKED_IPS_GEO };
  process.env.NGINX_CONF_PATH = conf;
  process.env.JROK_CACHE_OFF_MAP = MAP;
  process.env.JROK_BLOCKED_IPS_GEO = GEO;
  try {
    await writeFile(conf, "http { }\n");
    expect(await updateEdgeCacheRules()).toBe("off");

    await writeFile(conf, `http { map $host $x { include ${MAP}; } geo $y { include ${GEO}; } }\n`);
    resetSecuritySync(); // a server that hasn't read MongoDB yet: an empty map would lift every restriction
    await writeFile(MAP, "# from before the restart\nshop.example.com 1;\n");
    expect(await updateEdgeCacheRules()).toBe("not-ready");
    expect(await readFile(MAP, "utf8")).toContain("shop.example.com 1;");
  } finally {
    for (const [name, value] of [["NGINX_CONF_PATH", saved.conf], ["JROK_CACHE_OFF_MAP", saved.map], ["JROK_BLOCKED_IPS_GEO", saved.geo]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

describe("the nginx.conf the Ansible nginx role writes", () => {
  test("has map buckets for any host name: with nginx's default 64 bytes, a long one made nginx refuse every update of the map (2026-11-08 to 11-14)", () => {
    const role = readFileSync(join(import.meta.dir, "../ansible/roles/nginx/tasks/main.yml"), "utf8");
    const http = role.slice(role.indexOf("      http {"));
    expect(http.indexOf("map_hash_bucket_size 512;")).toBeGreaterThan(0);
    // Set once, in http, before the map that needs it
    expect(role.match(/map_hash_bucket_size/g)!.length).toBe(1);
    expect(http.indexOf("map_hash_bucket_size 512;")).toBeLessThan(http.indexOf("include /etc/nginx/jrok-cache-off.map;"));
  });
});
