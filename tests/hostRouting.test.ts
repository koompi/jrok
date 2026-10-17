import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  normalizeHostname,
  classifyHost,
  managementHosts,
  isOwnOAuthRedirect,
  looksLikeAgentHandshake,
  strictApiHosts,
} from "../src/utils/hostRouting";

// jrok used to answer its management routes by path alone, on every host — so
// /auth/callback on a customer's domain was jrok's, and the app's OAuth code
// went to jrok's dashboard. The host is classified first now.

const env = ["BASE_DOMAIN", "LEGACY_BASE_DOMAINS", "JROK_API_HOSTS", "JROK_STRICT_API_HOSTS", "KOOMPI_REDIRECT_URI"] as const;
const original = Object.fromEntries(env.map((k) => [k, process.env[k]]));

beforeEach(() => {
  process.env.BASE_DOMAIN = "public.koompi.cloud";
  process.env.LEGACY_BASE_DOMAINS = "tunnel.koompi.cloud";
  delete process.env.JROK_API_HOSTS;
  delete process.env.JROK_STRICT_API_HOSTS;
  delete process.env.KOOMPI_REDIRECT_URI;
});

afterAll(() => {
  for (const k of env) {
    if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k];
  }
});

describe("classifyHost", () => {
  test("tunnel subdomains under every base domain are tunnels", () => {
    expect(classifyHost("shop.public.koompi.cloud")).toEqual({ kind: "tunnel", name: "shop" });
    expect(classifyHost("shop.tunnel.koompi.cloud")).toEqual({ kind: "tunnel", name: "shop" });
  });

  test("the base domain apexes are the API", () => {
    expect(classifyHost("tunnel.koompi.cloud")).toEqual({ kind: "management", listed: true });
    expect(classifyHost("public.koompi.cloud")).toEqual({ kind: "management", listed: true });
  });

  test("localhost and IP literals are the API (health checks, certbot hook, peers)", () => {
    expect(classifyHost("localhost").kind).toBe("management");
    expect(classifyHost("152.42.226.37").kind).toBe("management");
    expect(classifyHost("[::1]").kind).toBe("management");
  });

  test("anything else needs the custom-domain lookup", () => {
    expect(classifyHost("shop.customer.com")).toEqual({ kind: "custom-candidate", host: "shop.customer.com" });
    // A lookalike of a base domain is not ours.
    expect(classifyHost("notpublic.koompi.cloud").kind).toBe("custom-candidate");
    // e.g. a dashboard host proxying /api to jrok — API unless it's a custom domain.
    expect(classifyHost("jrok.koompi.cloud").kind).toBe("custom-candidate");
  });

  test("JROK_API_HOSTS wins, even over a tunnel-looking name", () => {
    process.env.JROK_API_HOSTS = "api.tunnel.koompi.cloud, https://jrok.koompi.cloud/api, admin.example.com:8443";
    expect(classifyHost("api.tunnel.koompi.cloud")).toEqual({ kind: "management", listed: true });
    expect(classifyHost("jrok.koompi.cloud")).toEqual({ kind: "management", listed: true });
    expect(classifyHost("admin.example.com")).toEqual({ kind: "management", listed: true });
    // Other tunnels are untouched.
    expect(classifyHost("shop.tunnel.koompi.cloud")).toEqual({ kind: "tunnel", name: "shop" });
    expect([...managementHosts()].sort()).toEqual(["admin.example.com", "api.tunnel.koompi.cloud", "jrok.koompi.cloud"]);
  });

  test("strict mode is opt-in", () => {
    expect(strictApiHosts()).toBe(false);
    process.env.JROK_STRICT_API_HOSTS = "true";
    expect(strictApiHosts()).toBe(true);
  });
});

test("normalizeHostname: case, port and trailing dot can't dodge classification", () => {
  expect(normalizeHostname("SHOP.Public.Koompi.Cloud.")).toBe("shop.public.koompi.cloud");
  expect(normalizeHostname("shop.public.koompi.cloud:443")).toBe("shop.public.koompi.cloud");
  expect(normalizeHostname("[::1]")).toBe("[::1]");
  expect(classifyHost(normalizeHostname("Shop.Public.Koompi.Cloud.")).kind).toBe("tunnel");
});

describe("isOwnOAuthRedirect", () => {
  test("only jrok's configured redirect host and path", () => {
    process.env.KOOMPI_REDIRECT_URI = "https://tunnel.koompi.cloud/auth/callback";
    expect(isOwnOAuthRedirect("tunnel.koompi.cloud", "/auth/callback")).toBe(true);
    // A customer's app on its own host keeps its /auth/callback.
    expect(isOwnOAuthRedirect("shop.tunnel.koompi.cloud", "/auth/callback")).toBe(false);
    expect(isOwnOAuthRedirect("tunnel.koompi.cloud", "/auth/login")).toBe(false);
  });

  test("a redirect URI that isn't jrok's /auth/callback claims nothing", () => {
    process.env.KOOMPI_REDIRECT_URI = "https://dash.tunnel.koompi.cloud/callback";
    expect(isOwnOAuthRedirect("dash.tunnel.koompi.cloud", "/auth/callback")).toBe(false);
    delete process.env.KOOMPI_REDIRECT_URI;
    expect(isOwnOAuthRedirect("tunnel.koompi.cloud", "/auth/callback")).toBe(false);
  });
});

describe("looksLikeAgentHandshake (agent upgrade arriving on a tunnel host)", () => {
  const u = (q: string) => new URL(`https://shop.tunnel.koompi.cloud/ws/agent${q}`);

  test("an agent handshake, header or legacy query credential", () => {
    expect(looksLikeAgentHandshake(u("?domain=a&localPort=80"), new Headers({ authorization: "Bearer jrok_x" }))).toBe(true);
    expect(looksLikeAgentHandshake(u("?domain=a&localPort=80&auth=jrok_x"), new Headers())).toBe(true);
  });

  test("a customer app's own /ws/agent socket is left to the app", () => {
    expect(looksLikeAgentHandshake(u(""), new Headers())).toBe(false);
    expect(looksLikeAgentHandshake(u("?domain=a&localPort=80"), new Headers())).toBe(false);
    expect(looksLikeAgentHandshake(u("?domain=a&localPort=80"), new Headers({ authorization: "Bearer app-session" }))).toBe(false);
  });
});

// A source-level guard, in the style of capabilityNegotiation.test.ts: the
// failure this prevents (a management route added above the tunnel block) is
// silent until a customer's app loses a path to jrok.
test("index.ts routes tunnel hosts before any management route", () => {
  const src = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  const fetchStart = src.indexOf("async fetch(req: Request)");
  const tunnelBlock = src.indexOf("if (tunnelDomain) {", fetchStart);
  expect(fetchStart).toBeGreaterThan(0);
  expect(tunnelBlock).toBeGreaterThan(fetchStart);

  const routes = [...src.slice(fetchStart).matchAll(/path(?:\.startsWith\(|\.match\(| === )/g)].map((m) => m.index! + fetchStart);
  // The only path check allowed before the tunnel block is the agent upgrade,
  // which is itself gated on the host.
  const beforeTunnel = routes.filter((i) => i < tunnelBlock);
  expect(beforeTunnel.length).toBe(1);
  expect(src.slice(beforeTunnel[0]!, beforeTunnel[0]! + 40)).toContain('path === "/ws/agent"');
});
