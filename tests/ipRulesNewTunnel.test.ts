import { describe, expect, test } from "bun:test";
import { checkIpSecurity, holdTunnelIpSecurity } from "../src/services/securityService";

// P33: rules an agent brings are in force under its domain before its tunnel
// record (and id) exists; requests check the tunnel id, then the domain.
describe("IP rules of a new tunnel", () => {
  test("the domain's rules count while the tunnel id has none", () => {
    holdTunnelIpSecurity("p33-allow", { mode: "allowlist", allowedIps: ["174.138.17.236"], blockedIps: [] });
    expect(checkIpSecurity("tunnel-id-not-filed-yet", "203.0.113.9", "p33-allow").allowed).toBe(false);
    expect(checkIpSecurity("tunnel-id-not-filed-yet", "174.138.17.236", "p33-allow").allowed).toBe(true);

    holdTunnelIpSecurity("p33-block", { mode: "blocklist", allowedIps: [], blockedIps: ["203.0.113.9"] });
    expect(checkIpSecurity("another-id", "203.0.113.9", "p33-block").allowed).toBe(false);
    expect(checkIpSecurity("another-id", "198.51.100.1", "p33-block").allowed).toBe(true);
  });

  test("rules filed under the tunnel id win", () => {
    holdTunnelIpSecurity("p33-domain", { mode: "allowlist", allowedIps: ["174.138.17.236"], blockedIps: [] });
    holdTunnelIpSecurity("p33-id", { mode: "allow-all" });
    expect(checkIpSecurity("p33-id", "203.0.113.9", "p33-domain").allowed).toBe(true);
  });

  test("no rules anywhere: allowed", () => {
    expect(checkIpSecurity("p33-none-id", "203.0.113.9", "p33-none").allowed).toBe(true);
  });
});
