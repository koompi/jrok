import { describe, it, expect } from "vitest";
import { buildAgentUrl, getBaseDomain } from "../src/protocol";

describe("buildAgentUrl", () => {
  it("builds an HTTP port tunnel URL over wss", () => {
    const u = new URL(
      buildAgentUrl({
        serverUrl: "https://tunnel.koompi.cloud",
        domain: "app",
        protocol: "http",
        serviceType: "port",
        port: 3000,
        localHost: "localhost",
        authToken: "k",
      }),
    );
    expect(u.protocol).toBe("wss:");
    expect(u.pathname).toBe("/ws/agent");
    expect(u.searchParams.get("domain")).toBe("app");
    expect(u.searchParams.get("protocol")).toBe("http");
    expect(u.searchParams.get("localPort")).toBe("3000");
    expect(u.searchParams.get("localHost")).toBe("localhost");
    expect(u.searchParams.get("auth")).toBe("k");
  });

  it("uses ws for an http server, omits domain when not requested, sets tcp", () => {
    const u = new URL(
      buildAgentUrl({
        serverUrl: "http://localhost:3000",
        protocol: "tcp",
        serviceType: "port",
        port: 22,
        localHost: "localhost",
        authToken: "k",
      }),
    );
    expect(u.protocol).toBe("ws:");
    expect(u.searchParams.get("protocol")).toBe("tcp");
    expect(u.searchParams.has("domain")).toBe(false);
  });

  it("encodes IP security and docker service", () => {
    const u = new URL(
      buildAgentUrl({
        serverUrl: "https://t.co",
        protocol: "http",
        serviceType: "docker-swarm",
        serviceName: "web",
        localHost: "localhost",
        authToken: "k",
        ipSecurity: { mode: "allowlist", allowedIps: ["1.2.3.4", "5.6.7.8"] },
      }),
    );
    expect(u.searchParams.get("dockerService")).toBe("web");
    expect(u.searchParams.get("ipSecurityMode")).toBe("allowlist");
    expect(u.searchParams.get("allowedIps")).toBe("1.2.3.4,5.6.7.8");
  });
});

describe("getBaseDomain", () => {
  it("strips tunnel./api. prefixes", () => {
    expect(getBaseDomain("https://tunnel.koompi.cloud")).toBe("koompi.cloud");
    expect(getBaseDomain("https://api.example.com")).toBe("example.com");
    expect(getBaseDomain("https://example.com")).toBe("example.com");
  });
});
