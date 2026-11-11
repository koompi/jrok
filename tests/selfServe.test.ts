/**
 * JROK_SELF_SERVE=off (audit 2026-11-11, finding 1). Anyone with a KOOMPI ID
 * could sign in to jrok, make an organization and an API key with
 * tunnel:create, and claim any free name under KOOMPI Cloud's domain, or a name
 * a customer was about to pick. Off, only KOOMPI Cloud makes organizations and
 * keys; existing ones keep working.
 *
 * No database: the collections are in memory (tests/helpers/fakeMongo.ts).
 */
import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { fakeCollections } from "./helpers/fakeMongo";

const fake = fakeCollections();
const realMongo = await import("../src/utils/mongodb");
mock.module("../src/utils/mongodb", () => ({ ...realMongo, getCollections: () => fake.collections }));

const authService = await import("../src/services/authService");
const organizationHandler = await import("../src/handlers/organizationHandler");
const { selfServeOpen, newAccountStatus, mayCreateOrganization, mayCreateApiKey, SELF_SERVE_CLOSED } = await import("../src/config/selfServe");
const { DEFAULT_IMPERSONATION_ORG_IDS } = await import("../src/config/impersonation");

const PLATFORM_ORG = DEFAULT_IMPERSONATION_ORG_IDS[0]!;
const env = ["JROK_SELF_SERVE", "JROK_IMPERSONATION_ORG_IDS", "JROK_IMPERSONATION_KEY_IDS"] as const;
const original = Object.fromEntries(env.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of env) {
    if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k];
  }
});

beforeEach(() => {
  fake.reset();
  for (const k of env) delete process.env[k];
  authService.invalidateUserOrgCache();
  authService.invalidateSessionCache();
  authService.invalidateApiKeyCache();
});

const koompiUser = (id: string) => ({ _id: id, fullname: `User ${id}`, username: id, email: `${id}@example.com` }) as any;

async function signedIn(id: string, role: "member" | "super_admin" = "member"): Promise<string> {
  await fake.collections.users.insertOne({ id, koompId: `k-${id}`, email: `${id}@example.com`, fullname: id, role, isActive: true, status: "active", createdAt: 0, updatedAt: 0 });
  return (await authService.createSession(id)).token;
}

async function org(id: string, ownerId: string) {
  await fake.collections.organizations.insertOne({
    id, name: id, slug: id, ownerId, isActive: true, createdAt: 0, updatedAt: 0,
    members: [{ userId: ownerId, role: "owner", joinedAt: 0 }],
  });
}

const post = (path: string, token: string, body: unknown) =>
  new Request(`https://public.koompi.cloud${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the setting", () => {
  test("open unless JROK_SELF_SERVE=off (self-hosted jrok keeps working as before)", () => {
    expect(selfServeOpen()).toBe(true);
    process.env.JROK_SELF_SERVE = "on";
    expect(selfServeOpen()).toBe(true);
    process.env.JROK_SELF_SERVE = "OFF";
    expect(selfServeOpen()).toBe(false);
  });

  test("closed: new accounts start pending; the first (the super-admin) is active", () => {
    expect(newAccountStatus(false, false)).toBe("active");
    process.env.JROK_SELF_SERVE = "off";
    expect(newAccountStatus(false, false)).toBe("pending");
    expect(newAccountStatus(true, false)).toBe("active");
  });

  test("closed: organizations by super-admins only; keys in the platform org, or by super-admins", () => {
    process.env.JROK_SELF_SERVE = "off";
    expect(mayCreateOrganization({ role: "member" })).toEqual({ allowed: false, message: SELF_SERVE_CLOSED });
    expect(mayCreateOrganization({ role: "super_admin" })).toEqual({ allowed: true });
    expect(mayCreateApiKey({ role: "member" }, "org-stranger").allowed).toBe(false);
    expect(mayCreateApiKey({ role: "member" }, PLATFORM_ORG).allowed).toBe(true);
    expect(mayCreateApiKey({ role: "super_admin" }, "org-stranger").allowed).toBe(true);
    // The platform org follows JROK_IMPERSONATION_ORG_IDS.
    process.env.JROK_IMPERSONATION_ORG_IDS = "org-koompi-staging";
    expect(mayCreateApiKey({ role: "member" }, "org-koompi-staging").allowed).toBe(true);
    expect(mayCreateApiKey({ role: "member" }, PLATFORM_ORG).allowed).toBe(false);
  });
});

describe("signing in with a KOOMPI ID", () => {
  test("closed: a new account is pending and can't make an organization", async () => {
    process.env.JROK_SELF_SERVE = "off";
    const first = await authService.findOrCreateUser(koompiUser("first"));
    expect(first).toMatchObject({ role: "super_admin", status: "active" });
    const stranger = await authService.findOrCreateUser(koompiUser("stranger"));
    expect(stranger).toMatchObject({ role: "member", status: "pending" });
  });

  test("open: a new account is active, as before", async () => {
    await authService.findOrCreateUser(koompiUser("first"));
    expect((await authService.findOrCreateUser(koompiUser("someone"))).status).toBe("active");
  });

  test("an existing account signs in unchanged", async () => {
    await authService.findOrCreateUser(koompiUser("first"));
    await authService.findOrCreateUser(koompiUser("staff"));
    process.env.JROK_SELF_SERVE = "off";
    expect((await authService.findOrCreateUser(koompiUser("staff"))).status).toBe("active");
  });
});

describe("POST /organizations", () => {
  test("closed: refused for an ordinary account, allowed for a super-admin", async () => {
    process.env.JROK_SELF_SERVE = "off";
    const member = await signedIn("member");
    const refused = await organizationHandler.handleCreateOrganization(post("/organizations", member, { name: "phish" }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toBe(SELF_SERVE_CLOSED);
    expect(await fake.collections.organizations.countDocuments()).toBe(0);

    const admin = await signedIn("admin", "super_admin");
    const made = await organizationHandler.handleCreateOrganization(post("/organizations", admin, { name: "Customer support" }));
    expect(made.status).toBe(200);
    expect(await fake.collections.organizations.countDocuments()).toBe(1);
  });

  test("open: anyone signed in, as before", async () => {
    const member = await signedIn("member");
    expect((await organizationHandler.handleCreateOrganization(post("/organizations", member, { name: "mine" }))).status).toBe(200);
  });
});

describe("POST /organizations/:id/api-keys", () => {
  test("closed: no new key in someone's own organization", async () => {
    process.env.JROK_SELF_SERVE = "off";
    const owner = await signedIn("owner");
    await org("org-stranger", "owner");
    const res = await organizationHandler.handleCreateApiKey(
      post("/organizations/org-stranger/api-keys", owner, { name: "cli", permissions: ["tunnel:create"] }), "org-stranger");
    expect(res.status).toBe(403);
    expect(await fake.collections.apiKeys.countDocuments()).toBe(0);
  });

  test("closed: KOOMPI Cloud's own organization still makes keys (kconsole, workers, staff)", async () => {
    process.env.JROK_SELF_SERVE = "off";
    const staff = await signedIn("staff");
    await org(PLATFORM_ORG, "staff");
    const res = await organizationHandler.handleCreateApiKey(
      post(`/organizations/${PLATFORM_ORG}/api-keys`, staff, { name: "deploy worker", permissions: ["tunnel:create"] }), PLATFORM_ORG);
    expect(res.status).toBe(200);
    const { apiKey } = await res.json();
    expect(apiKey.key.startsWith("jrok_")).toBe(true);
  });

  test("closed: a super-admin still makes keys in an organization they administer", async () => {
    process.env.JROK_SELF_SERVE = "off";
    const admin = await signedIn("admin", "super_admin");
    await org("org-customer", "admin");
    const res = await organizationHandler.handleCreateApiKey(
      post("/organizations/org-customer/api-keys", admin, { name: "support" }), "org-customer");
    expect(res.status).toBe(200);
  });

  test("closed: an existing key of another organization keeps working (rotation too)", async () => {
    const owner = await signedIn("owner");
    await org("org-stranger", "owner");
    const made = await organizationHandler.handleCreateApiKey(
      post("/organizations/org-stranger/api-keys", owner, { name: "cli", permissions: ["tunnel:create"] }), "org-stranger");
    const { apiKey } = await made.json();
    process.env.JROK_SELF_SERVE = "off";
    expect((await authService.validateApiKeyForAgent(apiKey.key)).valid).toBe(true);
    const rotated = await organizationHandler.handleRotateApiKey(
      post(`/organizations/org-stranger/api-keys/${apiKey.id}/rotate`, owner, {}), "org-stranger", apiKey.id);
    expect(rotated.status).toBe(200);
  });
});

test("Ansible closes self-serve by default and refuses a deploy that names no platform key", () => {
  const role = readFileSync(join(import.meta.dir, "../ansible/roles/app/tasks/main.yml"), "utf8");
  const playbook = readFileSync(join(import.meta.dir, "../ansible/playbook.yml"), "utf8");
  expect(playbook).toContain("jrok_self_serve_on: \"{{ (jrok_self_serve | default('off')");
  expect(role).toContain("Environment=JROK_SELF_SERVE={{ 'on' if (jrok_self_serve_on | bool) else 'off' }}");
  expect(role).toContain("Environment=JROK_IMPERSONATION_KEY_IDS={{ impersonation_key_ids | string | trim }}");
  expect(role).toMatch(/- name: The platform key is named \(impersonation_key_ids\) when self-serve is off\n  assert:/);
});
