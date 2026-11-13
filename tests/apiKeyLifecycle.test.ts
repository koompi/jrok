/**
 * A key stops working when it should (audit 2026-11-11, finding 4):
 *   - an agent's key of a disabled (or deleted) organization used to keep
 *     connecting agents: validateApiKeyForAgent never looked at the org;
 *   - a revoked key kept working for up to 5 minutes on the REST API, on every
 *     edge, from the key cache nothing ever invalidated.
 *
 * No database: the collections are in memory (tests/helpers/fakeMongo.ts).
 */
import { describe, test, expect, beforeEach, afterEach, mock, setSystemTime, spyOn } from "bun:test";
import crypto from "crypto";
import { fakeCollections } from "./helpers/fakeMongo";

const fake = fakeCollections();
const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({ ...realMongo, getCollections: () => fake.collections }));

const authService = await import("../src/services/authService");
const organizationHandler = await import("../src/handlers/organizationHandler");

const hash = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");

async function key(raw: string, organizationId: string, extra: Record<string, unknown> = {}) {
  await fake.collections.apiKeys.insertOne({
    id: `id-${raw}`, name: raw, key: hash(raw), keyPrefix: raw.slice(0, 14), organizationId,
    createdBy: "owner", permissions: ["tunnel:create"], createdAt: 0, isActive: true, ...extra,
  });
}

async function org(id: string, extra: Record<string, unknown> = {}) {
  await fake.collections.organizations.insertOne({
    id, name: id, slug: id, ownerId: "owner", isActive: true, createdAt: 0, updatedAt: 0,
    members: [{ userId: "owner", role: "owner", joinedAt: 0 }], ...extra,
  });
}

beforeEach(() => {
  fake.reset();
  authService.invalidateApiKeyCache();
  authService.invalidateUserOrgCache();
  authService.invalidateSessionCache();
});
afterEach(() => setSystemTime());

describe("an agent's key and its organization", () => {
  test("an active organization's key connects", async () => {
    await org("org-a");
    await key("jrok_aaaaaaaaaaaaaaaa", "org-a");
    expect(await authService.validateApiKeyForAgent("jrok_aaaaaaaaaaaaaaaa")).toMatchObject({ valid: true, organizationId: "org-a" });
  });

  test("a disabled organization's key is refused (Super Admin status, or isActive false)", async () => {
    await org("org-disabled", { isActive: false, status: "disabled" });
    await key("jrok_disabled00000000", "org-disabled");
    expect(await authService.validateApiKeyForAgent("jrok_disabled00000000"))
      .toEqual({ valid: false, reason: "API key's organization is disabled" });

    await org("org-off", { isActive: false });
    await key("jrok_off0000000000000", "org-off");
    expect((await authService.validateApiKeyForAgent("jrok_off0000000000000")).valid).toBe(false);
  });

  test("a key whose organization is gone is refused", async () => {
    await key("jrok_orphan000000000", "org-gone");
    expect((await authService.validateApiKeyForAgent("jrok_orphan000000000")).valid).toBe(false);
  });

  test("an organization from before isActive existed still counts as active", async () => {
    await fake.collections.organizations.insertOne({ id: "org-old", name: "old", slug: "old", ownerId: "owner", members: [] });
    await key("jrok_old000000000000", "org-old");
    expect((await authService.validateApiKeyForAgent("jrok_old000000000000")).valid).toBe(true);
  });

  test("organizationIsActive", () => {
    expect(authService.organizationIsActive({ isActive: true })).toBe(true);
    expect(authService.organizationIsActive({} as any)).toBe(true);
    expect(authService.organizationIsActive({ isActive: true, status: "disabled" })).toBe(false);
    expect(authService.organizationIsActive({ isActive: false })).toBe(false);
    expect(authService.organizationIsActive(null)).toBe(false);
  });
});

describe("the REST key cache", () => {
  test("a cached key lasts 30 s, not 5 minutes, after it is revoked elsewhere", async () => {
    setSystemTime(new Date("2026-11-11T00:00:00Z"));
    await org("org-a");
    await key("jrok_cached0000000000", "org-a");
    expect(await authService.validateApiKey("jrok_cached0000000000")).not.toBeNull();
    // Another edge revokes it: this edge's cache doesn't hear of it.
    await fake.collections.apiKeys.updateOne({ id: "id-jrok_cached0000000000" }, { $set: { isActive: false } });
    setSystemTime(new Date("2026-11-11T00:00:20Z"));
    expect(await authService.validateApiKey("jrok_cached0000000000")).not.toBeNull();
    setSystemTime(new Date("2026-11-11T00:00:31Z"));
    expect(await authService.validateApiKey("jrok_cached0000000000")).toBeNull();
    expect(authService.API_KEY_CACHE_TTL).toBe(30_000);
  });

  test("a cached key is never served past its own expiry", async () => {
    setSystemTime(new Date("2026-11-11T00:00:00Z"));
    await org("org-a");
    await key("jrok_expiring00000000", "org-a", { expiresAt: Date.parse("2026-11-11T00:00:10Z") });
    expect(await authService.validateApiKey("jrok_expiring00000000")).not.toBeNull();
    setSystemTime(new Date("2026-11-11T00:00:11Z"));
    expect(await authService.validateApiKey("jrok_expiring00000000")).toBeNull();
  });

  test("revoking a key through this edge stops it here at once", async () => {
    await fake.collections.users.insertOne({ id: "owner", koompId: "k-owner", email: "o@example.com", fullname: "owner", role: "member", isActive: true, status: "active" });
    const session = await authService.createSession("owner");
    await org("org-a");
    await key("jrok_revoked00000000", "org-a");
    expect(await authService.validateApiKey("jrok_revoked00000000")).not.toBeNull();

    const res = await organizationHandler.handleRevokeApiKey(
      new Request("https://public.koompi.cloud/organizations/org-a/api-keys/id-jrok_revoked00000000", {
        method: "DELETE", headers: { Authorization: `Bearer ${session.token}` },
      }), "org-a", "id-jrok_revoked00000000");
    expect(res.status).toBe(200);
    expect(await authService.validateApiKey("jrok_revoked00000000")).toBeNull();
  });

  test("invalidateApiKeyCacheWhere forgets one key, or every key of an organization", async () => {
    await org("org-a");
    await org("org-b");
    await key("jrok_a1000000000000", "org-a");
    await key("jrok_a2000000000000", "org-a");
    await key("jrok_b1000000000000", "org-b");
    for (const k of ["jrok_a1000000000000", "jrok_a2000000000000", "jrok_b1000000000000"]) await authService.validateApiKey(k);
    // Disabled in the database; only the cache still says otherwise.
    await fake.collections.organizations.updateOne({ id: "org-a" }, { $set: { isActive: false, status: "disabled" } });
    await fake.collections.apiKeys.updateOne({ id: "id-jrok_b1000000000000" }, { $set: { isActive: false } });
    expect(await authService.validateApiKey("jrok_a1000000000000")).not.toBeNull();

    authService.invalidateApiKeyCacheWhere({ organizationId: "org-a" });
    expect(await authService.validateApiKey("jrok_a1000000000000")).toBeNull();
    expect(await authService.validateApiKey("jrok_a2000000000000")).toBeNull();
    expect(await authService.validateApiKey("jrok_b1000000000000")).not.toBeNull(); // not touched
    authService.invalidateApiKeyCacheWhere({ keyId: "id-jrok_b1000000000000" });
    expect(await authService.validateApiKey("jrok_b1000000000000")).toBeNull();
  });
});

describe("the agent key cache (every replica connects with the platform key)", () => {
  const spyKeys = () => ({
    find: spyOn(fake.collections.apiKeys, "findOne"),
    orgs: spyOn(fake.collections.organizations, "findOne"),
    touch: spyOn(fake.collections.apiKeys, "updateOne"),
  });

  test("a key that passed costs no lookup for 30 s; revoked elsewhere, it stops after them", async () => {
    setSystemTime(new Date("2026-11-14T00:00:00Z"));
    await org("org-a");
    await key("jrok_agent00000000000", "org-a");
    const s = spyKeys();
    expect(await authService.validateApiKeyForAgent("jrok_agent00000000000")).toMatchObject({ valid: true, organizationId: "org-a", apiKeyId: "id-jrok_agent00000000000" });
    for (let i = 0; i < 20; i++) expect((await authService.validateApiKeyForAgent("jrok_agent00000000000")).valid).toBe(true);
    expect(s.find).toHaveBeenCalledTimes(1);
    expect(s.orgs).toHaveBeenCalledTimes(1);
    await fake.collections.apiKeys.updateOne({ id: "id-jrok_agent00000000000" }, { $set: { isActive: false } });
    setSystemTime(new Date("2026-11-14T00:00:20Z"));
    expect((await authService.validateApiKeyForAgent("jrok_agent00000000000")).valid).toBe(true);
    setSystemTime(new Date("2026-11-14T00:00:31Z"));
    expect(await authService.validateApiKeyForAgent("jrok_agent00000000000")).toEqual({ valid: false, reason: "Invalid or revoked API key" });
  });

  test("200 agents at once share one lookup", async () => {
    await org("org-a");
    await key("jrok_burst00000000000", "org-a");
    const s = spyKeys();
    const all = await Promise.all(Array.from({ length: 200 }, () => authService.validateApiKeyForAgent("jrok_burst00000000000")));
    expect(all.every((r) => r.valid && r.organizationId === "org-a")).toBe(true);
    expect(s.find).toHaveBeenCalledTimes(1);
    expect(s.orgs).toHaveBeenCalledTimes(1);
  });

  test("revoked or rotated through this edge, or its organization disabled here: refused at once", async () => {
    await org("org-a");
    await org("org-b");
    await key("jrok_revokehere000000", "org-a");
    await key("jrok_disablehere00000", "org-b");
    for (const k of ["jrok_revokehere000000", "jrok_disablehere00000"]) expect((await authService.validateApiKeyForAgent(k)).valid).toBe(true);
    await fake.collections.apiKeys.updateOne({ id: "id-jrok_revokehere000000" }, { $set: { isActive: false } });
    authService.invalidateApiKeyCacheWhere({ keyId: "id-jrok_revokehere000000" });
    expect((await authService.validateApiKeyForAgent("jrok_revokehere000000")).valid).toBe(false);
    await fake.collections.organizations.updateOne({ id: "org-b" }, { $set: { isActive: false, status: "disabled" } });
    authService.invalidateApiKeyCacheWhere({ organizationId: "org-b" });
    expect(await authService.validateApiKeyForAgent("jrok_disablehere00000")).toEqual({ valid: false, reason: "API key's organization is disabled" });
  });

  test("a lookup that a revocation overtook is not kept", async () => {
    await org("org-a");
    await key("jrok_racing0000000000", "org-a");
    const pending = authService.validateApiKeyForAgent("jrok_racing0000000000");
    // Revoked here while that lookup is on its way
    await fake.collections.apiKeys.updateOne({ id: "id-jrok_racing0000000000" }, { $set: { isActive: false } });
    authService.invalidateApiKeyCacheWhere({ keyId: "id-jrok_racing0000000000" });
    await pending;
    expect((await authService.validateApiKeyForAgent("jrok_racing0000000000")).valid).toBe(false);
  });

  test("never past the key's own expiry; a refused key isn't kept", async () => {
    setSystemTime(new Date("2026-11-14T00:00:00Z"));
    await org("org-a");
    await key("jrok_expires000000000", "org-a", { expiresAt: Date.parse("2026-11-14T00:00:10Z") });
    expect((await authService.validateApiKeyForAgent("jrok_expires000000000")).valid).toBe(true);
    setSystemTime(new Date("2026-11-14T00:00:11Z"));
    expect(await authService.validateApiKeyForAgent("jrok_expires000000000")).toEqual({ valid: false, reason: "API key has expired" });
    // Refused (no tunnel permission), then given it: allowed at once
    await key("jrok_noperm0000000000", "org-a", { permissions: ["read"] });
    expect((await authService.validateApiKeyForAgent("jrok_noperm0000000000")).valid).toBe(false);
    await fake.collections.apiKeys.updateOne({ id: "id-jrok_noperm0000000000" }, { $set: { permissions: ["tunnel:create"] } });
    expect((await authService.validateApiKeyForAgent("jrok_noperm0000000000")).valid).toBe(true);
  });

  test("lastUsedAt at most once a minute, and a connect never waits for it", async () => {
    setSystemTime(new Date("2026-11-14T00:00:00Z"));
    await org("org-a");
    await key("jrok_touched000000000", "org-a");
    const s = spyKeys();
    s.touch.mockImplementation((() => new Promise(() => {})) as any); // a write that never answers
    for (let i = 0; i < 10; i++) expect((await authService.validateApiKeyForAgent("jrok_touched000000000")).valid).toBe(true);
    expect(s.touch).toHaveBeenCalledTimes(1);
    setSystemTime(new Date("2026-11-14T00:01:05Z"));
    expect((await authService.validateApiKeyForAgent("jrok_touched000000000")).valid).toBe(true);
    expect(s.touch).toHaveBeenCalledTimes(2);
  });

  test("a caller changing what it got changes no one else's answer", async () => {
    await org("org-a");
    await key("jrok_shared000000000", "org-a");
    const first = await authService.validateApiKeyForAgent("jrok_shared000000000");
    first.permissions!.push("*");
    expect((await authService.validateApiKeyForAgent("jrok_shared000000000")).permissions).toEqual(["tunnel:create"]);
  });
});
