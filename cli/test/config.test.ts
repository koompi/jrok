import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate from the real ~/.kproxy by pointing HOME at a fresh temp dir BEFORE importing.
let resolveContext: typeof import("../src/config").resolveContext;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "kproxy-test-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  ({ resolveContext } = await import("../src/config"));
});

afterEach(() => {
  for (const k of ["KPROXY_SERVER", "KPROXY_AUTH", "KPROXY_ORG"]) delete process.env[k];
});

describe("resolveContext", () => {
  it("prefers explicit flags over env over default", () => {
    process.env.KPROXY_SERVER = "https://env.example";
    expect(resolveContext({ server: "https://flag.example" }).serverUrl).toBe("https://flag.example");
    expect(resolveContext({}).serverUrl).toBe("https://env.example");
    delete process.env.KPROXY_SERVER;
    expect(resolveContext({}).serverUrl).toBe("https://tunnel.koompi.cloud");
  });

  it("reads the auth token from KPROXY_AUTH, with flags taking precedence", () => {
    process.env.KPROXY_AUTH = "env-key";
    expect(resolveContext({}).authToken).toBe("env-key");
    expect(resolveContext({ auth: "flag-key" }).authToken).toBe("flag-key");
  });
});
