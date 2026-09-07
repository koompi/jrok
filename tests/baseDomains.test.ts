import { test, expect, beforeEach, afterAll } from "bun:test";
import {
  allBaseDomains,
  primaryBaseDomain,
  matchBaseDomain,
  isTunnelSubdomain,
  extractSubdomain,
} from "../src/utils/baseDomains";

// Renaming the base domain is customer-visible: every deployed URL, every OAuth
// redirect URI registered with an identity provider, and every customer CNAME
// carries the old name. Accepting both names is what lets that rename happen
// gradually instead of breaking all of them on one day.

const original = { base: process.env.BASE_DOMAIN, legacy: process.env.LEGACY_BASE_DOMAINS };

beforeEach(() => {
  process.env.BASE_DOMAIN = "public.koompi.cloud";
  process.env.LEGACY_BASE_DOMAINS = "tunnel.koompi.cloud";
});

afterAll(() => {
  if (original.base === undefined) delete process.env.BASE_DOMAIN; else process.env.BASE_DOMAIN = original.base;
  if (original.legacy === undefined) delete process.env.LEGACY_BASE_DOMAINS; else process.env.LEGACY_BASE_DOMAINS = original.legacy;
});

test("new URLs use the primary name, but both names are served", () => {
  expect(primaryBaseDomain()).toBe("public.koompi.cloud");
  expect(allBaseDomains()).toEqual(["public.koompi.cloud", "tunnel.koompi.cloud"]);
});

test("a tunnel resolves under both the new and the old name", () => {
  // What a customer gets today.
  expect(extractSubdomain("shop.public.koompi.cloud")).toBe("shop");
  // The URL they were given last year, still in their bookmarks and their
  // OAuth provider's redirect-URI allowlist.
  expect(extractSubdomain("shop.tunnel.koompi.cloud")).toBe("shop");

  expect(isTunnelSubdomain("shop.public.koompi.cloud")).toBe(true);
  expect(isTunnelSubdomain("shop.tunnel.koompi.cloud")).toBe(true);
});

test("a lookalike domain does NOT match a base domain", () => {
  // The reason matching is on the label boundary rather than endsWith():
  // someone registering "notpublic.koompi.cloud" or "evilpublic.koompi.cloud"
  // would otherwise be routed as though they owned a tunnel here.
  expect(matchBaseDomain("notpublic.koompi.cloud")).toBeNull();
  expect(matchBaseDomain("evil-public.koompi.cloud")).toBeNull();
  expect(matchBaseDomain("publictunnel.koompi.cloud")).toBeNull();
  expect(extractSubdomain("notpublic.koompi.cloud")).toBeNull();
});

test("a customer's own domain is not mistaken for one of ours", () => {
  expect(matchBaseDomain("shop.customer.com")).toBeNull();
  expect(isTunnelSubdomain("shop.customer.com")).toBe(false);
  expect(extractSubdomain("shop.customer.com")).toBeNull();
});

test("the bare base domain is not a tunnel", () => {
  // public.koompi.cloud itself is the dashboard/API, not somebody's tunnel.
  expect(matchBaseDomain("public.koompi.cloud")).toBe("public.koompi.cloud");
  expect(isTunnelSubdomain("public.koompi.cloud")).toBe(false);
  expect(extractSubdomain("public.koompi.cloud")).toBeNull();
});

test("deep subdomains keep their full name", () => {
  expect(extractSubdomain("api.staging.shop.public.koompi.cloud")).toBe("api.staging.shop");
});

test("hostnames match case-insensitively", () => {
  expect(extractSubdomain("SHOP.Public.Koompi.Cloud")).toBe("shop");
  expect(matchBaseDomain("SHOP.TUNNEL.KOOMPI.CLOUD")).toBe("tunnel.koompi.cloud");
});

test("several legacy names are accepted, and duplicates collapse", () => {
  process.env.LEGACY_BASE_DOMAINS = "tunnel.koompi.cloud, old.koompi.cloud ,public.koompi.cloud";
  expect(allBaseDomains()).toEqual([
    "public.koompi.cloud",
    "tunnel.koompi.cloud",
    "old.koompi.cloud",
  ]);
  expect(extractSubdomain("shop.old.koompi.cloud")).toBe("shop");
});

test("with no legacy names configured, only the primary is served", () => {
  delete process.env.LEGACY_BASE_DOMAINS;
  expect(allBaseDomains()).toEqual(["public.koompi.cloud"]);
  expect(matchBaseDomain("shop.tunnel.koompi.cloud")).toBeNull();
});

test("before the rename, the old name alone still works", () => {
  // The configuration every existing server runs today: nothing changes for
  // them until BASE_DOMAIN is actually flipped.
  process.env.BASE_DOMAIN = "tunnel.koompi.cloud";
  delete process.env.LEGACY_BASE_DOMAINS;
  expect(primaryBaseDomain()).toBe("tunnel.koompi.cloud");
  expect(extractSubdomain("shop.tunnel.koompi.cloud")).toBe("shop");
});
