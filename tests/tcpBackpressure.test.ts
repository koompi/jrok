/**
 * Flow control for TCP tunnels.
 *
 * A TCP tunnel bridges two links with independent speeds. Without flow control
 * the faster side's bytes accumulate in this process's heap until the box runs
 * out of memory — and since the tunnel server is shared, one customer with a
 * slow client could take down every other customer's tunnel.
 *
 * These tests drive real sockets against a real listener, with a stand-in agent
 * WebSocket whose bufferedAmount the test controls.
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as net from "net";
import {
  startTcpServer,
  stopTcpServer,
  registerAgentConnection,
  handleAgentTcpConnected,
} from "../src/services/tcpService";
import type { TcpPortAllocation } from "../src/types/index";

/** A minimal stand-in for the agent's WebSocket, with a settable backlog. */
function makeFakeAgentWs() {
  const sent: any[] = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw));
    },
    /** Messages of a given type, e.g. "tcp_data". */
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

function makeAllocation(port: number, agentId: string): TcpPortAllocation {
  return {
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
}

/** Poll until `check` is true, or fail after `timeoutMs`. */
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

describe("TCP tunnel flow control", () => {
  test("drops a connection that floods before the agent confirms", async () => {
    // The agent is registered but never confirms this connection, so every byte
    // the client sends lands in the pre-connect buffer. That buffer used to be
    // unbounded: a client blasting at a tunnel whose agent never answers could
    // grow the heap without limit.
    const port = await freePort();
    const agentId = "agent-preconnect";
    const ws = makeFakeAgentWs();
    registerAgentConnection(agentId, ws as any);

    expect(startTcpServer(makeAllocation(port, agentId))).toBe(true);
    openPorts.push(port);

    const client = net.createConnection({ port, host: "127.0.0.1" });
    await new Promise((r) => client.once("connect", r));

    let closed = false;
    client.on("close", () => (closed = true));
    client.on("error", () => (closed = true)); // ECONNRESET on destroy()

    // Well past the 4MB pre-connect cap. handleAgentTcpConnected is never called.
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    for (let i = 0; i < 40 && !closed; i++) {
      client.write(chunk);
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(await waitFor(() => closed)).toBe(true);
    client.destroy();
  }, 20000);

  test("stops reading from the client while the agent socket is backed up", async () => {
    const port = await freePort();
    const agentId = "agent-backpressure";
    const ws = makeFakeAgentWs();
    registerAgentConnection(agentId, ws as any);

    expect(startTcpServer(makeAllocation(port, agentId))).toBe(true);
    openPorts.push(port);

    const client = net.createConnection({ port, host: "127.0.0.1" });
    await new Promise((r) => client.once("connect", r));

    // The server announces the new connection to the agent; that message
    // carries the id we need to mark it connected.
    expect(await waitFor(() => ws.ofType("tcp_connect").length > 0)).toBe(true);
    const connectionId = ws.ofType("tcp_connect")[0].connectionId;
    handleAgentTcpConnected(connectionId);

    // Agent socket is wedged: nothing is draining.
    ws.bufferedAmount = 64 * 1024 * 1024;

    const chunk = Buffer.alloc(128 * 1024, 0x62);
    for (let i = 0; i < 20; i++) {
      client.write(chunk);
      await new Promise((r) => setTimeout(r, 10));
    }

    // Once paused, the server stops reading, so forwarded messages plateau.
    const afterPause = ws.ofType("tcp_data").length;
    for (let i = 0; i < 10; i++) {
      client.write(chunk);
      await new Promise((r) => setTimeout(r, 10));
    }
    const later = ws.ofType("tcp_data").length;

    expect(later).toBe(afterPause);

    // And it recovers: drain the agent, and data flows again.
    ws.bufferedAmount = 0;
    client.write(chunk);
    expect(await waitFor(() => ws.ofType("tcp_data").length > later)).toBe(true);

    client.destroy();
  }, 20000);

  test("forwards normally when the agent keeps up", async () => {
    // Guards against the flow control being so eager it throttles healthy
    // tunnels — the failure mode that would be worse than the leak.
    const port = await freePort();
    const agentId = "agent-healthy";
    const ws = makeFakeAgentWs();
    registerAgentConnection(agentId, ws as any);

    expect(startTcpServer(makeAllocation(port, agentId))).toBe(true);
    openPorts.push(port);

    const client = net.createConnection({ port, host: "127.0.0.1" });
    await new Promise((r) => client.once("connect", r));

    expect(await waitFor(() => ws.ofType("tcp_connect").length > 0)).toBe(true);
    handleAgentTcpConnected(ws.ofType("tcp_connect")[0].connectionId);

    const chunk = Buffer.alloc(64 * 1024, 0x63);
    for (let i = 0; i < 10; i++) {
      client.write(chunk);
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(await waitFor(() => ws.ofType("tcp_data").length >= 10)).toBe(true);
    client.destroy();
  }, 20000);
});
