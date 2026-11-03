/**
 * Custom-domain verification accepts only the target issued for that
 * registration. Any CNAME under a base domain used to pass, so another
 * organization could claim a hostname whose DNS was left pointing at KOOMPI
 * Cloud (a removed domain, or DNS set up before adding it) and get its
 * certificate. Targets were also the hostname's own name, so a new
 * registration of a removed hostname got the old owner's target.
 */
import { test, expect, mock } from "bun:test";

process.env.BASE_DOMAIN = "public.koompi.cloud";
process.env.LEGACY_BASE_DOMAINS = "tunnel.koompi.cloud";

// What public DNS answers: no network in tests.
let cnames: string[] = [];
mock.module("dns/promises", () => {
  class Resolver {
    setServers() {}
    async resolveCname() { return cnames; }
    async resolveTxt() { return []; }
  }
  return { default: { Resolver }, Resolver };
});

const { verifyCname, newTargetSubdomain, cnameMatchesTarget } = await import("../src/services/domainService");

const ISSUED = "shop-example-com-3f9c01ab.public.koompi.cloud";

test("a CNAME to another app's name under the base domain fails", async () => {
  cnames = ["their-app.public.koompi.cloud"];
  const result = await verifyCname("shop.example.com", ISSUED);
  expect(result.verified).toBe(false);
  expect(result.error).toContain(ISSUED);

  // The name this hostname's target had before targets were random.
  cnames = ["shop-example-com.public.koompi.cloud."];
  expect((await verifyCname("shop.example.com", ISSUED)).verified).toBe(false);
});

test("the target issued for this registration passes, under the primary base domain or a legacy one", async () => {
  cnames = [`${ISSUED}.`];
  expect((await verifyCname("shop.example.com", ISSUED)).verified).toBe(true);
  cnames = ["Shop-Example-Com-3F9C01AB.tunnel.koompi.cloud"];
  expect((await verifyCname("shop.example.com", ISSUED)).verified).toBe(true);
  expect(cnameMatchesTarget("shop-example-com-3f9c01ab.elsewhere.example", ISSUED)).toBe(false);
});

test("each registration gets a target no other has, that fits a DNS label", () => {
  const a = newTargetSubdomain("shop-example-com");
  const b = newTargetSubdomain("shop-example-com");
  expect(a).toMatch(/^shop-example-com-[0-9a-f]{8}$/);
  expect(b).not.toBe(a);
  const long = newTargetSubdomain("a".repeat(80));
  expect(long.length).toBeLessThanOrEqual(63);
  expect(newTargetSubdomain("x-".repeat(40))).not.toMatch(/--[0-9a-f]{8}$/);
});
