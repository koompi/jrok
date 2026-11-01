import { afterEach, describe, expect, test } from "bun:test";
import { isReservedTunnelName } from "../src/utils/hostRouting";
import { fromTrustedProxy } from "../src/utils/clientIp";

afterEach(() => {
  delete process.env.TRUSTED_PROXY_IPS;
  delete process.env.JROK_RESERVED_NAMES;
});

describe("names no tunnel may take", () => {
  test("the edges' own names and jrok's", () => {
    for (const name of ["edge-sgp1", "edge-sgp12", "EDGE-PNH2", "jrok-peer", "jrok-edges"]) expect(isReservedTunnelName(name)).toBe(true);
  });
  test("ordinary names, including ones that merely start with edge-", () => {
    for (const name of ["shop", "edge-ai", "edge-ai-4f2k", "edgesgp1", "my-jrok-peer"]) expect(isReservedTunnelName(name)).toBe(false);
  });
  test("JROK_RESERVED_NAMES adds more", () => {
    process.env.JROK_RESERVED_NAMES = "status, admin";
    expect(isReservedTunnelName("admin")).toBe(true);
  });
});

describe("headers only our proxies may set", () => {
  test("with TRUSTED_PROXY_IPS, only those addresses are trusted", () => {
    process.env.TRUSTED_PROXY_IPS = "127.0.0.1,::1,159.65.8.153";
    expect(fromTrustedProxy("127.0.0.1")).toBe(true);
    expect(fromTrustedProxy("::ffff:127.0.0.1")).toBe(true);
    expect(fromTrustedProxy("159.65.8.153")).toBe(true);
    expect(fromTrustedProxy("203.0.113.9")).toBe(false);
    expect(fromTrustedProxy(undefined)).toBe(false);
  });
  test("without it, everyone (the setup before it)", () => {
    expect(fromTrustedProxy("203.0.113.9")).toBe(true);
  });
});
