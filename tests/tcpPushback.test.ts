/**
 * TCP push-back between the edge and an agent ("tcp_pushback").
 *
 * The edge pauses a TCP customer's socket while the agent's link is backed up.
 * It measured that with `ws.bufferedAmount`, which Bun's ServerWebSocket (the
 * real agent link) doesn't have: it has getBufferedAmount(). So the edge never
 * paused anyone, and past 16MB Bun silently dropped tcp_data. An agent that
 * stops reading to push back (jrok-connector, while a database stalls) then
 * left a hole in the customer's stream. The connector stops reading only when
 * the welcome lists "tcp_pushback".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as net from "net";
import { join } from "path";
import { handleAgentTcpConnected, registerAgentConnection, startTcpServer, stopTcpServer } from "../src/services/tcpService";
import type { TcpPortAllocation } from "../src/types/index";

const root = join(import.meta.dir, "..");

/** An agent link shaped like Bun's ServerWebSocket: getBufferedAmount(), no bufferedAmount. */
function bunShapedAgentWs() {
  const sent: any[] = [];
  let backlog = 0;
  return {
    readyState: 1,
    sent,
    getBufferedAmount: () => backlog,
    setBacklog(bytes: number) {
      backlog = bytes;
    },
    send(raw: string) {
      sent.push(JSON.parse(raw));
      return raw.length;
    },
    ofType(type: string) {
      return sent.filter((m) => m.type === type);
    },
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const openPorts: number[] = [];
afterEach(() => {
  for (const p of openPorts.splice(0)) stopTcpServer(p);
});

describe("TCP push-back", () => {
  test("Bun's agent link has getBufferedAmount() and no bufferedAmount", async () => {
    let shape: { hasProperty: boolean; method: string } | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 404 });
      },
      websocket: {
        open(ws: any) {
          shape = { hasProperty: "bufferedAmount" in ws, method: typeof ws.getBufferedAmount };
        },
        message() {},
      },
    });
    const client = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    try {
      expect(await waitFor(() => shape !== undefined)).toBe(true);
      expect(shape).toEqual({ hasProperty: false, method: "function" });
    } finally {
      client.close();
      server.stop(true);
    }
  });

  test("the customer is paused while a Bun agent link is backed up, and resumed after", async () => {
    const port = await freePort();
    const agentId = "agent-pushback";
    const ws = bunShapedAgentWs();
    registerAgentConnection(agentId, ws as any);
    const allocation = {
      id: `alloc-${port}`,
      tunnelId: `tunnel-${port}`,
      agentId,
      port,
      localPort: 5432,
      localHost: "localhost",
      organizationId: "org-test",
      serverId: "test-server",
      active: true,
      createdAt: new Date(),
    } as unknown as TcpPortAllocation;
    expect(startTcpServer(allocation)).toBe(true);
    openPorts.push(port);

    const client = net.createConnection({ port, host: "127.0.0.1" });
    await new Promise((r) => client.once("connect", r));
    expect(await waitFor(() => ws.ofType("tcp_connect").length > 0)).toBe(true);
    handleAgentTcpConnected(ws.ofType("tcp_connect")[0].connectionId);

    // The agent stopped reading (its local database stalls).
    ws.setBacklog(9 * 1024 * 1024);
    const chunk = Buffer.alloc(128 * 1024, 0x62);
    for (let i = 0; i < 20; i++) {
      client.write(chunk);
      await new Promise((r) => setTimeout(r, 10));
    }
    const paused = ws.ofType("tcp_data").length;
    for (let i = 0; i < 10; i++) {
      client.write(chunk);
      await new Promise((r) => setTimeout(r, 10));
    }
    // Not read while the link is backed up (before: forwarded, then dropped by Bun).
    expect(ws.ofType("tcp_data").length).toBe(paused);

    ws.setBacklog(0);
    expect(await waitFor(() => ws.ofType("tcp_data").length > paused)).toBe(true);
    client.destroy();
  }, 20000);

  test("the welcome advertises tcp_pushback, the word the connector waits for", () => {
    const serverIndex = readFileSync(join(root, "src/index.ts"), "utf8");
    const features = serverIndex.match(/features:\s*\[([^\]]+)\]/)?.[1] ?? "";
    expect(features).toContain('"tcp_pushback"');
    const connector = readFileSync(join(root, "connector/src/tcp.rs"), "utf8");
    expect(connector).toContain('pub const PUSHBACK: &str = "tcp_pushback";');
  });
});
