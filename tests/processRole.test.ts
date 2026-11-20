import { test, expect, afterEach } from "bun:test";
import { edgeId, processIndex, isPrimaryProcess, TARGET_SERVER_HEADER } from "../src/utils/processRole";
import { addressPeerRequest, stripPeerHeaders } from "../src/utils/peerLink";
import { targetFor, currentServerId } from "../src/services/crossServerService";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["JROK_EDGE_ID", "JROK_PROCESS_INDEX", "VPS_ID"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("edgeId: JROK_EDGE_ID, else VPS_ID", () => {
  process.env.VPS_ID = "vps-sgp2-p1";
  process.env.JROK_EDGE_ID = "vps-sgp2";
  expect(edgeId()).toBe("vps-sgp2");
  delete process.env.JROK_EDGE_ID;
  expect(edgeId()).toBe("vps-sgp2-p1");
});

test("processIndex: default 0, garbage 0, integers kept", () => {
  delete process.env.JROK_PROCESS_INDEX;
  expect(processIndex()).toBe(0);
  expect(isPrimaryProcess()).toBe(true);
  process.env.JROK_PROCESS_INDEX = "2";
  expect(processIndex()).toBe(2);
  expect(isPrimaryProcess()).toBe(false);
  for (const bad of ["-1", "1.5", "x"]) {
    process.env.JROK_PROCESS_INDEX = bad;
    expect(processIndex()).toBe(0);
  }
});

function collect() {
  const h: Record<string, string> = { [TARGET_SERVER_HEADER.toLowerCase()]: "spoofed" };
  return {
    h,
    set: (n: string, v: string) => (h[n.toLowerCase()] = v),
    remove: (n: string) => delete h[n.toLowerCase()],
  };
}

test("target header: set for another edge, dropped for a sibling, never passed through", () => {
  const remote = collect();
  addressPeerRequest({ forwardUrl: "https://edge-b.example", serverId: "vps-b-p2" }, "app.example", remote.set, remote.remove);
  expect(remote.h[TARGET_SERVER_HEADER.toLowerCase()]).toBe("vps-b-p2");

  const sibling = collect();
  addressPeerRequest({ serverId: "vps-a-p1" }, "app.example", sibling.set, sibling.remove);
  expect(sibling.h[TARGET_SERVER_HEADER.toLowerCase()]).toBeUndefined();
  expect(sibling.h.host).toBe("app.example");

  const out = { [TARGET_SERVER_HEADER.toLowerCase()]: "x", other: "y" };
  stripPeerHeaders(out);
  expect(out).toEqual({ other: "y" });
});

test("targetFor: a sibling on this edge is reached over 127.0.0.1 without its forwardUrl", () => {
  const thisEdge = edgeId();
  const sib = targetFor({
    serverId: `${currentServerId}-sibling`, edgeId: thisEdge, serverHost: "10.0.0.5", serverPort: 3010,
    forwardUrl: "https://edge-a.example", healthy: true,
  } as any);
  expect(sib).toEqual({ serverId: `${currentServerId}-sibling`, serverHost: "127.0.0.1", serverPort: 3010 });

  const other = targetFor({
    serverId: "vps-b", edgeId: "vps-b", serverHost: "10.0.0.9", serverPort: 3000,
    forwardUrl: "https://edge-b.example", healthy: true,
  } as any);
  expect(other.forwardUrl).toBe("https://edge-b.example");
  expect(other.serverHost).toBe("10.0.0.9");
});
