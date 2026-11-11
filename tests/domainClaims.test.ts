/**
 * Custom-domain registrations and the organizations they belong to (audit
 * 2026-11-11, findings 1 and 3):
 *   - a pending (never verified) registration used to hold its hostname from
 *     everyone else forever, so anyone could pre-register a customer's domain.
 *     Now it holds it for DOMAIN_PENDING_TTL_HOURS (72), and another
 *     organization that proves it runs the domain's DNS takes it over at once;
 *   - a registration needs an owner organization;
 *   - a request acting for an organization (kconsole's platform key sends
 *     ?organizationId=) deletes or verifies only that organization's domain.
 *
 * No database and no DNS: in-memory collections, and TXT answers set here.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { fakeCollections } from "./helpers/fakeMongo";
import type { AuthContext } from "../src/types/index";

process.env.BASE_DOMAIN = "public.koompi.cloud";

let txt: Record<string, string[][]> = {};
let cname: Record<string, string[]> = {};
mock.module("dns/promises", () => {
  class Resolver {
    setServers() {}
    async resolveCname(name: string) {
      if (!cname[name]) throw Object.assign(new Error("no data"), { code: "ENODATA" });
      return cname[name];
    }
    async resolveTxt(name: string) {
      if (!txt[name]) throw Object.assign(new Error("no data"), { code: "ENODATA" });
      return txt[name];
    }
  }
  return { default: { Resolver }, Resolver };
});

const fake = fakeCollections();
const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({ ...realMongo, getCollections: () => fake.collections }));

const db = await import("../src/utils/database");
const domainService = await import("../src/services/domainService");
const domainHandler = await import("../src/handlers/domainHandler");
const { resolveDomainOwner } = await import("../src/utils/access");
const { DEFAULT_IMPERSONATION_ORG_IDS } = await import("../src/config/impersonation");

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-11T00:00:00Z");

// kconsole's platform key: privileged, registers for its customers' orgs.
const platformKey = {
  apiKey: { id: "kconsole-key", organizationId: DEFAULT_IMPERSONATION_ORG_IDS[0], permissions: ["tunnel:create"] },
  isApiKeyAuth: true,
} as unknown as AuthContext;

beforeEach(() => {
  fake.reset();
  db.invalidateCustomDomainCache();
  txt = {};
  cname = {};
  delete process.env.DOMAIN_PENDING_TTL_HOURS;
  delete process.env.JROK_IMPERSONATION_KEY_IDS;
  delete process.env.JROK_IMPERSONATION_ORG_IDS;
});

const register = (domain: string, organizationId: string, now = T0, verifyTxt?: typeof domainService.verifyTxt) =>
  domainService.registerCustomDomain({ domain, certbotEmail: "", organizationId }, { now: () => now, ...(verifyTxt ? { verifyTxt } : {}) });

async function squat(domain: string, organizationId: string, createdAt = T0, extra: Record<string, unknown> = {}) {
  const record = await register(domain, organizationId, createdAt);
  await fake.collections.customDomains.updateOne({ domain }, { $set: { createdAt, ...extra } });
  db.invalidateCustomDomainCache(domain);
  return record;
}

describe("a pending registration of another organization", () => {
  test("is refused, with the TXT record that would prove the domain is the caller's", async () => {
    await squat("shop.example.com", "org-squatter");
    const claim = domainService.domainClaimToken("shop.example.com", "org-customer");
    const err = await register("shop.example.com", "org-customer", T0 + HOUR).catch((e) => e);
    expect(err).toBeInstanceOf(domainService.DomainClaimRequiredError);
    expect(err.txtValue).toBe(`jrok-verify=${claim}`);
    expect(err.message).toContain(`TXT record shop.example.com -> jrok-verify=${claim}`);
    expect((await db.getCustomDomainByName("shop.example.com"))?.organizationId).toBe("org-squatter");
  });

  test("is taken over at once by the organization that publishes that TXT record", async () => {
    await squat("shop.example.com", "org-squatter");
    const claim = domainService.domainClaimToken("shop.example.com", "org-customer");
    txt["shop.example.com"] = [[`jrok-verify=${claim}`]];
    const record = await register("shop.example.com", "org-customer", T0 + HOUR);
    expect(record.organizationId).toBe("org-customer");
    // The record already in DNS verifies the new registration too.
    expect(record.verificationToken).toBe(claim);
    expect(fake.collections.customDomains.docs.filter((d) => d.domain === "shop.example.com")).toHaveLength(1);
  });

  test("another organization's TXT record proves nothing for the caller", async () => {
    await squat("shop.example.com", "org-squatter");
    txt["shop.example.com"] = [[`jrok-verify=${domainService.domainClaimToken("shop.example.com", "org-someone-else")}`]];
    expect(await register("shop.example.com", "org-customer", T0 + HOUR).catch((e) => e)).toBeInstanceOf(domainService.DomainClaimRequiredError);
  });

  test("stops holding the name after 72 h: the next organization gets it without proof", async () => {
    await squat("shop.example.com", "org-squatter");
    expect(await register("shop.example.com", "org-customer", T0 + 71 * HOUR).catch((e) => e)).toBeInstanceOf(domainService.DomainClaimRequiredError);
    const record = await register("shop.example.com", "org-customer", T0 + 72 * HOUR);
    expect(record.organizationId).toBe("org-customer");
    expect(record.verificationToken).not.toBe(domainService.domainClaimToken("shop.example.com", "org-customer"));
  });

  test("DOMAIN_PENDING_TTL_HOURS sets how long", async () => {
    process.env.DOMAIN_PENDING_TTL_HOURS = "24";
    await squat("shop.example.com", "org-squatter");
    expect((await register("shop.example.com", "org-customer", T0 + 24 * HOUR)).organizationId).toBe("org-customer");
  });

  test("whose DNS was verified for its owner (the certificate then failed) is not freed by time alone", async () => {
    await squat("shop.example.com", "org-owner", T0, { cnameVerified: true });
    expect(await register("shop.example.com", "org-other", T0 + 1000 * HOUR).catch((e) => e)).toBeInstanceOf(domainService.DomainClaimRequiredError);
    expect(domainService.pendingRegistrationExpired({ createdAt: T0, active: false, txtVerified: true } as any, T0 + 1000 * HOUR)).toBe(false);
  });

  test("expired, its owner may still verify it while nobody has taken it (kconsole checks for 7 days)", async () => {
    await squat("shop.example.com", "org-owner");
    expect(domainService.pendingRegistrationExpired((await db.getCustomDomainByName("shop.example.com"))!, T0 + 100 * HOUR)).toBe(true);
    expect((await register("shop.example.com", "org-owner", T0 + 100 * HOUR)).organizationId).toBe("org-owner");
  });
});

describe("what doesn't change", () => {
  test("an active domain of another organization is never taken over, TXT or not", async () => {
    await squat("live.example.com", "org-owner", T0, { active: true });
    txt["live.example.com"] = [[`jrok-verify=${domainService.domainClaimToken("live.example.com", "org-other")}`]];
    await expect(register("live.example.com", "org-other", T0 + 1000 * HOUR)).rejects.toThrow("already registered");
  });

  test("the same organization registering again gets its own record back", async () => {
    const first = await register("mine.example.com", "org-a");
    const again = await register("mine.example.com", "org-a", T0 + 1000 * HOUR);
    expect(again.id).toBe(first.id);
  });

  test("a pending record that became active meanwhile (another edge verified it) is not removed", async () => {
    const pending = await squat("race.example.com", "org-owner");
    await fake.collections.customDomains.updateOne({ domain: "race.example.com" }, { $set: { active: true } });
    expect(await db.deletePendingCustomDomain("race.example.com", { ...pending, active: false } as any)).toBe(false);
    expect(fake.collections.customDomains.docs).toHaveLength(1);
  });
});

describe("a domain deleted and registered again by another organization", () => {
  // The first owner's DNS records, still in place, must not verify the second.
  test("gets a new CNAME target and TXT token, and the old records verify nothing", async () => {
    const first = await register("reused.example.com", "org-first");
    cname["reused.example.com"] = [`${first.cnameTarget}.`];
    txt["reused.example.com"] = [[`jrok-verify=${first.verificationToken}`]];
    expect((await domainService.verifyCname("reused.example.com", first.cnameTarget!)).verified).toBe(true);

    await domainHandler.handleDeleteDomain("reused.example.com", platformKey, "org-first");
    const second = await register("reused.example.com", "org-second");
    expect(second.organizationId).toBe("org-second");
    expect(second.cnameTarget).not.toBe(first.cnameTarget);
    expect(second.targetSubdomain).toMatch(/^reused-example-com-[0-9a-f]{8}$/);
    expect(second.verificationToken).not.toBe(first.verificationToken);

    expect((await domainService.verifyCname("reused.example.com", second.cnameTarget!)).verified).toBe(false);
    expect((await domainService.verifyTxt("reused.example.com", second.verificationToken!)).verified).toBe(false);
    await expect(domainService.verifyAndIssueCertificate("reused.example.com")).rejects.toThrow("verification failed");
    expect((await db.getCustomDomainByName("reused.example.com"))?.active).toBe(false);
  });
});

describe("POST /domains", () => {
  const registerRequest = (body: unknown) => new Request("https://public.koompi.cloud/domains", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  test("answers 409 with the claim when another organization's pending registration holds the name", async () => {
    await squat("shop.example.com", "org-squatter", Date.now());
    const res = await domainHandler.handleRegisterDomain(
      registerRequest({ domain: "shop.example.com", certbotEmail: "a@example.com", organizationId: "org-customer" }), "203.0.113.1", platformKey);
    expect(res.status).toBe(409);
    const body = await res.json();
    const value = `jrok-verify=${domainService.domainClaimToken("shop.example.com", "org-customer")}`;
    expect(body.claim).toEqual({ type: "TXT", name: "shop.example.com", value });
    expect(body.message).toContain(value); // kconsole shows `message`
  });

  test("a signed-in account with no organization can't register (it only held the name from others)", async () => {
    const orgless = { user: { id: "nobody", role: "member" }, isApiKeyAuth: false } as unknown as AuthContext;
    expect(await resolveDomainOwner(orgless, undefined, { lookupUserOrgs: async () => [] }))
      .toEqual({ ok: false, status: 403, message: "You must be part of an organization to register custom domains" });
    // A member of an organization still registers under it.
    expect(await resolveDomainOwner(orgless, undefined, { lookupUserOrgs: async () => [{ id: "org-m" }] }))
      .toEqual({ ok: true, organizationId: "org-m" });
  });
});

describe("a request acting for an organization", () => {
  const del = (domain: string, query = "", init: RequestInit = {}) =>
    new Request(`https://public.koompi.cloud/domains/${domain}${query}`, { method: "DELETE", ...init });

  test("requestedOrganization: ?organizationId=, or organizationId in a JSON body; none otherwise", async () => {
    expect(await domainHandler.requestedOrganization(del("a.example.com", "?organizationId=org-a"))).toBe("org-a");
    expect(await domainHandler.requestedOrganization(del("a.example.com", "", {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: "org-b" }),
    }))).toBe("org-b");
    expect(await domainHandler.requestedOrganization(del("a.example.com"))).toBeNull();
    // kconsole's verify sends a JSON content type and no body.
    expect(await domainHandler.requestedOrganization(new Request("https://x/domains/a.example.com/verify", {
      method: "POST", headers: { "Content-Type": "application/json" },
    }))).toBeNull();
  });

  test("the platform key deletes only that organization's domain", async () => {
    await squat("theirs.example.com", "org-victim");
    const refused = await domainHandler.handleDeleteDomain("theirs.example.com", platformKey, "org-attacker");
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toBe("Domain theirs.example.com belongs to another organization");
    expect(await db.getCustomDomainByName("theirs.example.com")).not.toBeNull();

    const done = await domainHandler.handleDeleteDomain("theirs.example.com", platformKey, "org-victim");
    expect(done.status).toBe(200);
    expect(await db.getCustomDomainByName("theirs.example.com")).toBeNull();
  });

  test("without an organizationId, KOOMPI Cloud's admin rights are unchanged", async () => {
    await squat("any.example.com", "org-anyone");
    expect((await domainHandler.handleDeleteDomain("any.example.com", platformKey, null)).status).toBe(200);
  });

  test("verify, re-sync, transfer and restore, too", async () => {
    await squat("theirs.example.com", "org-victim");
    expect((await domainHandler.handleVerifyAndIssueCertificate("theirs.example.com", platformKey, "org-attacker")).status).toBe(403);
    expect((await domainHandler.handleResyncDomain("theirs.example.com", platformKey, "org-attacker")).status).toBe(403);
    const transfer = new Request("https://public.koompi.cloud/domains/theirs.example.com/transfer?organizationId=org-attacker", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetVpsId: "vps-sgp2" }),
    });
    expect((await domainHandler.handleTransferDomain("theirs.example.com", transfer, platformKey, await domainHandler.requestedOrganization(transfer))).status).toBe(403);
    expect((await domainHandler.handleRestoreDomain("theirs.example.com", "backup-1", platformKey, "org-attacker")).status).toBe(403);
    expect((await db.getCustomDomainByName("theirs.example.com"))?.organizationId).toBe("org-victim");
  });

  test("an ordinary key still can't touch another organization's domain at all", async () => {
    await squat("theirs.example.com", "org-victim");
    const aliceKey = { apiKey: { id: "alice-key", organizationId: "org-alice", permissions: ["tunnel:create"] }, isApiKeyAuth: true } as unknown as AuthContext;
    expect((await domainHandler.handleDeleteDomain("theirs.example.com", aliceKey, "org-victim")).status).toBe(404);
  });
});
