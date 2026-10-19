import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { extractAgentToken } from "../src/handlers/agentHandler";
import {
  canImpersonate,
  resolveAgentOrg,
  DEFAULT_IMPERSONATION_ORG_IDS,
} from "../src/config/impersonation";

const upgrade = (query: string, headers: Record<string, string> = {}) =>
  new Request(`https://tunnel.koompi.cloud/ws/agent${query}`, { headers });

describe("agent API key transport", () => {
  test("Authorization: Bearer is read first", () => {
    expect(extractAgentToken(upgrade("?domain=a", { authorization: "Bearer jrok_header" })))
      .toEqual({ token: "jrok_header", fromQuery: false });
    // Header wins over a query key when both are sent.
    expect(extractAgentToken(upgrade("?auth=jrok_query", { authorization: "Bearer jrok_header" })))
      .toEqual({ token: "jrok_header", fromQuery: false });
  });

  test("old CLIs' ?auth= still works, flagged for the deprecation warning", () => {
    expect(extractAgentToken(upgrade("?domain=a&auth=jrok_query")))
      .toEqual({ token: "jrok_query", fromQuery: true });
  });

  test("a non-jrok Authorization header doesn't shadow an old CLI's query key", () => {
    expect(extractAgentToken(upgrade("?auth=jrok_query", { authorization: "Bearer something-a-proxy-added" })))
      .toEqual({ token: "jrok_query", fromQuery: true });
  });

  test("nothing usable", () => {
    expect(extractAgentToken(upgrade("?domain=a")).token).toBeNull();
    expect(extractAgentToken(upgrade("?domain=a", { authorization: "Basic abc" })).token).toBeNull();
  });

  test("the CLI sends the key as a header and keeps it out of the URL by default", () => {
    const cli = readFileSync(join(import.meta.dir, "../cli/src/index.ts"), "utf8");
    const connect = cli.slice(cli.indexOf("async function connectAgent"));
    expect(connect).toContain("Authorization: `Bearer ${config.authToken}`");
    // The only ?auth= left is behind the legacy opt-in.
    const queryAuth = [...connect.matchAll(/searchParams\.set\("auth"/g)];
    expect(queryAuth.length).toBe(1);
    expect(connect).toMatch(/if \(useLegacyQueryAuth\(\)\) \{\s*wsUrl\.searchParams\.set\("auth"/);
  });

  test("the built CLI bundle carries the header change too", () => {
    const dist = readFileSync(join(import.meta.dir, "../cli/dist/index.js"), "utf8");
    expect(dist).toContain("JROK_LEGACY_QUERY_AUTH");
  });
});

describe("organization impersonation", () => {
  const env = ["JROK_IMPERSONATION_ORG_IDS", "JROK_IMPERSONATION_KEY_IDS"] as const;
  const original = Object.fromEntries(env.map((k) => [k, process.env[k]]));
  beforeEach(() => env.forEach((k) => delete process.env[k]));
  afterAll(() => {
    for (const k of env) {
      if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k];
    }
  });

  const platformKey = { organizationId: DEFAULT_IMPERSONATION_ORG_IDS[0], apiKeyId: "kconsole-key", permissions: ["tunnel:create"] };
  const customerKey = { organizationId: "org-customer", apiKeyId: "customer-key", permissions: ["tunnel:create"] };

  test("kconsole's case: platform key, customer org, custom domain", () => {
    expect(resolveAgentOrg(platformKey, "65f0c0ffee", true)).toEqual({ action: "impersonate", organizationId: "65f0c0ffee" });
  });

  test("kconsole's other case: no org passed, tunnel runs as the key's org", () => {
    expect(resolveAgentOrg(platformKey, null, false)).toEqual({ action: "own-org", organizationId: platformKey.organizationId });
    expect(resolveAgentOrg(customerKey, "org-customer", true)).toEqual({ action: "own-org", organizationId: "org-customer" });
  });

  test("a privileged key can't act as another org on a subdomain or TCP tunnel", () => {
    // That would let it take over the other org's existing subdomain.
    expect(resolveAgentOrg(platformKey, "org-victim", false)).toEqual({ action: "ignore", organizationId: platformKey.organizationId });
  });

  test("an ordinary key can't impersonate at all", () => {
    expect(resolveAgentOrg(customerKey, "org-victim", true)).toEqual({ action: "deny" });
    expect(resolveAgentOrg(customerKey, "org-victim", false)).toEqual({ action: "deny" });
  });

  test("operator-provisioned '*'/'sudo' keys keep working when no key ids are pinned", () => {
    expect(canImpersonate({ organizationId: "x", apiKeyId: "k", permissions: ["*"] })).toBe(true);
    expect(canImpersonate({ organizationId: "x", apiKeyId: "k", permissions: ["sudo"] })).toBe(true);
  });

  test("JROK_IMPERSONATION_KEY_IDS pins it to kconsole's key alone", () => {
    process.env.JROK_IMPERSONATION_KEY_IDS = "kconsole-key";
    expect(canImpersonate(platformKey)).toBe(true);
    // Another key of the same org, or a '*' key, no longer qualifies.
    expect(canImpersonate({ ...platformKey, apiKeyId: "someone-elses-key" })).toBe(false);
    expect(canImpersonate({ organizationId: "x", apiKeyId: "k", permissions: ["*"] })).toBe(false);
  });

  test("JROK_IMPERSONATION_ORG_IDS replaces the default org; 'none' disables", () => {
    process.env.JROK_IMPERSONATION_ORG_IDS = "org-ops";
    expect(canImpersonate({ organizationId: "org-ops", apiKeyId: "k" })).toBe(true);
    expect(canImpersonate(platformKey)).toBe(false);
    process.env.JROK_IMPERSONATION_ORG_IDS = "none";
    expect(canImpersonate({ organizationId: "org-ops", apiKeyId: "k" })).toBe(false);
  });
});
