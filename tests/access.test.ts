import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { AuthContext } from "../src/types/index";
import {
  isPrivileged,
  callerOrgIds,
  checkOrgAccess,
  checkTunnelAccess,
  filterOwned,
  resolveDomainOwner,
} from "../src/utils/access";
import { withoutNetworkDetails } from "../src/handlers/agentHandler";
import { safeEqual } from "../src/utils/helpers";
import { DEFAULT_IMPERSONATION_ORG_IDS } from "../src/config/impersonation";

// Resource endpoints used to check only "signed in". Any jrok account or org API
// key could delete another customer's domain or switch off its IP allowlist.

const env = ["JROK_IMPERSONATION_ORG_IDS", "JROK_IMPERSONATION_KEY_IDS"] as const;
const original = Object.fromEntries(env.map((k) => [k, process.env[k]]));
beforeEach(() => env.forEach((k) => delete process.env[k]));
afterAll(() => {
  for (const k of env) {
    if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k];
  }
});

const apiKey = (id: string, organizationId: string, permissions: string[] = ["tunnel:create"]) =>
  ({ id, organizationId, permissions, name: id, key: "h", keyPrefix: "jrok_", createdBy: "u", createdAt: 0, isActive: true }) as any;
const user = (id: string, role = "user") => ({ id, role }) as any;

const ctx = {
  serverKey: { isApiKeyAuth: true, isServerKey: true } as AuthContext,
  superAdmin: { user: user("admin", "super_admin"), isApiKeyAuth: false } as AuthContext,
  platformKey: { apiKey: apiKey("kconsole-key", DEFAULT_IMPERSONATION_ORG_IDS[0]!), isApiKeyAuth: true } as AuthContext,
  aliceKey: { apiKey: apiKey("alice-key", "org-alice"), organization: { id: "org-alice" } as any, isApiKeyAuth: true } as AuthContext,
  aliceUser: { user: user("alice"), organization: { id: "org-alice" } as any, isApiKeyAuth: false } as AuthContext,
  orgless: { user: user("nobody"), isApiKeyAuth: false } as AuthContext,
};

// alice is also a member of org-alice-2; nobody belongs nowhere.
const lookupUserOrgs = async (userId: string) =>
  userId === "alice" ? [{ id: "org-alice" }, { id: "org-alice-2" }] : [];

describe("who is privileged", () => {
  test("server key, super-admin and kconsole's platform key", () => {
    expect(isPrivileged(ctx.serverKey)).toBe(true);
    expect(isPrivileged(ctx.superAdmin)).toBe(true);
    expect(isPrivileged(ctx.platformKey)).toBe(true);
  });

  test("ordinary accounts and keys are not", () => {
    expect(isPrivileged(ctx.aliceKey)).toBe(false);
    expect(isPrivileged(ctx.aliceUser)).toBe(false);
    expect(isPrivileged(null)).toBe(false);
  });

  test("pinning JROK_IMPERSONATION_KEY_IDS narrows it to those keys", () => {
    process.env.JROK_IMPERSONATION_KEY_IDS = "some-other-key";
    expect(isPrivileged(ctx.platformKey)).toBe(false);
    // The server key and super-admins don't depend on it.
    expect(isPrivileged(ctx.serverKey)).toBe(true);
    expect(isPrivileged(ctx.superAdmin)).toBe(true);
  });
});

describe("callerOrgIds", () => {
  test("an API key acts for its own org only", async () => {
    expect([...await callerOrgIds(ctx.aliceKey, lookupUserOrgs)]).toEqual(["org-alice"]);
  });

  test("a user acts for every org they belong to", async () => {
    expect([...await callerOrgIds(ctx.aliceUser, lookupUserOrgs)].sort()).toEqual(["org-alice", "org-alice-2"]);
    expect([...await callerOrgIds(ctx.orgless, lookupUserOrgs)]).toEqual([]);
  });
});

describe("checkOrgAccess (/security/bandwidth/:org, /domains/:domain)", () => {
  test("own org yes, someone else's no, owner-less no", async () => {
    expect((await checkOrgAccess(ctx.aliceUser, "org-alice-2", { lookupUserOrgs })).allowed).toBe(true);
    const denied = await checkOrgAccess(ctx.aliceKey, "org-bob", { lookupUserOrgs });
    expect(denied).toEqual({ allowed: false, status: 404, message: "Not found" });
    expect((await checkOrgAccess(ctx.aliceKey, undefined, { lookupUserOrgs })).allowed).toBe(false);
  });

  test("privileged callers reach any org, kconsole's customers included", async () => {
    expect((await checkOrgAccess(ctx.platformKey, "65f0c0ffee", { lookupUserOrgs })).allowed).toBe(true);
    expect((await checkOrgAccess(ctx.serverKey, undefined, { lookupUserOrgs })).allowed).toBe(true);
  });
});

describe("checkTunnelAccess (/security/ip|allowlist|logs/:tunnel)", () => {
  const tunnels: Record<string, Array<{ organizationId?: string }>> = {
    "alice-shop": [{ organizationId: "org-alice" }],
    "bob-shop": [{ organizationId: "org-bob" }],
    "orphan": [{}],
    // A subdomain spelled like someone else's tunnel id matches BOTH tunnels.
    "6d0f1c1e-0000-4000-8000-000000000000": [{ organizationId: "org-alice" }, { organizationId: "org-bob" }],
  };
  const findTunnels = async (ref: string) => tunnels[ref] ?? [];
  const deps = { lookupUserOrgs, findTunnels };

  test("own tunnel yes, other tenant's no", async () => {
    expect((await checkTunnelAccess(ctx.aliceKey, "alice-shop", deps)).allowed).toBe(true);
    expect(await checkTunnelAccess(ctx.aliceKey, "bob-shop", deps)).toEqual({ allowed: false, status: 404, message: "Tunnel not found" });
  });

  test("unknown and owner-less tunnels are refused to ordinary callers", async () => {
    expect((await checkTunnelAccess(ctx.aliceKey, "nope", deps)).allowed).toBe(false);
    expect((await checkTunnelAccess(ctx.aliceKey, "orphan", deps)).allowed).toBe(false);
  });

  test("an id/domain collision can't be used to reach the other tenant's tunnel", async () => {
    expect((await checkTunnelAccess(ctx.aliceKey, "6d0f1c1e-0000-4000-8000-000000000000", deps)).allowed).toBe(false);
  });

  test("kconsole's platform key manages any tunnel (it sets IP rules by subdomain)", async () => {
    expect((await checkTunnelAccess(ctx.platformKey, "bob-shop", deps)).allowed).toBe(true);
    expect((await checkTunnelAccess(ctx.superAdmin, "nope", deps)).allowed).toBe(true);
  });
});

describe("filterOwned (GET /domains, /agents, /agents/enhanced)", () => {
  const items = [
    { name: "a", organizationId: "org-alice" },
    { name: "b", organizationId: "org-bob" },
    { name: "c", organizationId: "org-alice-2" },
    { name: "d" },
  ];
  test("ordinary callers see their orgs' items only", async () => {
    const seen = await filterOwned(ctx.aliceUser, items, (i: any) => i.organizationId, { lookupUserOrgs });
    expect(seen.map((i) => i.name)).toEqual(["a", "c"]);
    expect(await filterOwned(ctx.orgless, items, (i: any) => i.organizationId, { lookupUserOrgs })).toEqual([]);
  });
  test("privileged callers see everything", async () => {
    expect((await filterOwned(ctx.platformKey, items, (i: any) => i.organizationId, { lookupUserOrgs })).length).toBe(4);
  });
});

describe("resolveDomainOwner (POST /domains)", () => {
  test("kconsole names its customer's org", async () => {
    expect(await resolveDomainOwner(ctx.platformKey, "65f0c0ffee", { lookupUserOrgs })).toEqual({ ok: true, organizationId: "65f0c0ffee" });
  });

  test("an ordinary caller can't register into someone else's org", async () => {
    expect(await resolveDomainOwner(ctx.aliceKey, "org-bob", { lookupUserOrgs }))
      .toEqual({ ok: false, status: 403, message: "organizationId is not one of your organizations" });
  });

  test("an ordinary caller may name one of its own orgs", async () => {
    expect(await resolveDomainOwner(ctx.aliceUser, "org-alice-2", { lookupUserOrgs })).toEqual({ ok: true, organizationId: "org-alice-2" });
  });

  test("no organizationId (the CLI sends none): the caller's own org", async () => {
    expect(await resolveDomainOwner(ctx.aliceKey, undefined, { lookupUserOrgs })).toEqual({ ok: true, organizationId: "org-alice" });
    expect(await resolveDomainOwner(ctx.orgless, undefined, { lookupUserOrgs })).toEqual({ ok: true, organizationId: undefined });
  });
});

test("withoutNetworkDetails drops where an agent connects from and to", () => {
  const stripped = withoutNetworkDetails({
    id: "a1", domain: "shop", organizationId: "org-alice",
    clientIp: "203.0.113.9", localHost: "10.0.0.5", localPort: 8080, serverHost: "sgp1.internal", serverId: "vps-sgp1",
  } as any);
  expect(stripped).toEqual({ id: "a1", domain: "shop", organizationId: "org-alice" } as any);
});

test("safeEqual: constant-time comparison that also handles length mismatch", () => {
  expect(safeEqual("secret-admin-key", "secret-admin-key")).toBe(true);
  expect(safeEqual("secret-admin-kez", "secret-admin-key")).toBe(false);
  expect(safeEqual("short", "secret-admin-key")).toBe(false);
  expect(safeEqual("", "secret-admin-key")).toBe(false);
});

// Source-level guards (style of capabilityNegotiation.test.ts): these routes
// are wired in a 2,500-line handler where a missing check is silent.
describe("route wiring", () => {
  const index = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  const domains = readFileSync(join(import.meta.dir, "../src/handlers/domainHandler.ts"), "utf8");

  const routeBody = (header: string) => {
    const start = index.indexOf(header);
    expect(start).toBeGreaterThan(0);
    return index.slice(start, index.indexOf("\n        if (path", start + header.length));
  };

  test("/stats/tcp and /cluster/stats require the server key or a super-admin", () => {
    expect(routeBody('if (path === "/stats/tcp" && method === "GET")')).toContain("requireServerKeyOrSuperAdmin");
    expect(routeBody('if (path === "/cluster/stats" && method === "GET")')).toContain("requireServerKeyOrSuperAdmin");
  });

  test("every per-tunnel /security route checks tunnel ownership", () => {
    for (const header of [
      'if (path.startsWith("/security/allowlist/") && method === "GET")',
      'if (path.startsWith("/security/allowlist/") && method === "POST")',
      'if (path.startsWith("/security/ip/") && method === "GET")',
      'if (path.startsWith("/security/ip/") && method === "POST")',
      'if (path.startsWith("/security/logs/tunnel/") && method === "GET")',
    ]) {
      expect(routeBody(header)).toContain("checkTunnelAccess(authContext");
    }
    expect(routeBody('if (path.startsWith("/security/bandwidth/") && method === "GET")')).toContain("checkOrgAccess(authContext");
  });

  test("GET/DELETE /tunnels/:id check ownership for every caller, not only API keys", () => {
    const tunnels = readFileSync(join(import.meta.dir, "../src/handlers/tunnelHandler.ts"), "utf8");
    for (const name of ["handleGetTunnel", "handleDeleteTunnel"]) {
      const start = tunnels.indexOf(`export async function ${name}(`);
      const body = tunnels.slice(start, tunnels.indexOf("\n}", start));
      expect(body).toContain("checkOrgAccess(authContext, tunnel.organizationId)");
    }
    expect(index).toContain("tunnelHandler.handleGetTunnel(id, req, authContext)");
    expect(index).toContain("tunnelHandler.handleDeleteTunnel(id, req, authContext)");
  });

  test("/agents is scoped to the caller", () => {
    expect(index).toContain("agentHandler.handleListAgents(authContext)");
  });

  test("every exported domain handler gates on ownership", () => {
    const handlers = [...domains.matchAll(/export async function (handle\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/g)];
    expect(handlers.length).toBeGreaterThanOrEqual(11);
    for (const [, name, params, body] of handlers) {
      expect(`${name}: ${params}`).toContain("authContext: AuthContext");
      expect(/denyUnlessDomainOwner|filterOwned|resolveDomainOwner/.test(body!)).toBe(true);
    }
  });
});
