import { test, expect } from "bun:test";
import {
  forwardRequest,
  buildCrossServerWsTarget,
  openCrossServerRelay,
  relayVisitorFrame,
  closeCrossServerRelay,
  type RelaySocket,
} from "../src/services/crossServerService";

// =============================================================================
// These cover the path taken when a visitor lands on a server that does NOT
// hold the agent — roughly half of all traffic once a second server exists,
// and a path that has never run in production. Both bugs covered here were
// silent: one corrupted uploads while returning 200, the other made every
// WebSocket fail.
// =============================================================================

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(" ");

/** A stub "peer server" that reports back exactly what it received. */
function startEchoServer() {
  const received: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      if (srv.upgrade(req, { data: { host: req.headers.get("host") } as any })) return;
      const body = new Uint8Array(await req.arrayBuffer());
      const info = {
        method: req.method,
        path: new URL(req.url).pathname + new URL(req.url).search,
        host: req.headers.get("host"),
        xff: req.headers.get("x-forwarded-for"),
        forwardedFrom: req.headers.get("x-forwarded-from"),
        bodyHex: hex(body),
        bodyLength: body.length,
      };
      received.push(info);
      return Response.json(info);
    },
    websocket: {
      open(ws: any) {
        received.push({ wsOpenHost: ws.data?.host });
        ws.send("peer:hello");
      },
      message(ws: any, data: any) {
        received.push({ wsMessage: typeof data === "string" ? data : hex(new Uint8Array(data)) });
        // Echo back so the test can assert the peer→visitor direction too.
        ws.send(typeof data === "string" ? `peer-echo:${data}` : data);
      },
      close(_ws: any, code: number) {
        received.push({ wsClosed: code });
      },
    },
  });
  return {
    server,
    received,
    target: { serverHost: "127.0.0.1", serverPort: server.port as number },
    stop: () => server.stop(true),
  };
}

// -----------------------------------------------------------------------------
// HTTP forwarding
// -----------------------------------------------------------------------------

test("a binary body survives the hop between servers", async () => {
  const peer = startEchoServer();
  try {
    // PNG magic, JPEG magic, and a lone 0xFF — none of it valid UTF-8.
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff, 0xe0]);
    const req = new Request("http://shop.customer.com/upload", {
      method: "POST",
      body: binary,
      headers: { host: "shop.customer.com" },
    });

    const res = await forwardRequest(peer.target, req, "/upload", "203.0.113.9");
    const got = await res.json() as any;

    // The old implementation used `.text()`, which turned this into
    // "ef bf bd 50 4e 47 ..." and grew it from 12 bytes to 22.
    expect(got.bodyHex).toBe(hex(binary));
    expect(got.bodyLength).toBe(binary.length);
  } finally {
    peer.stop();
  }
});

test("the Host header survives, so the peer knows which tunnel was asked for", async () => {
  const peer = startEchoServer();
  try {
    const req = new Request("http://shop.customer.com/", {
      method: "GET",
      headers: { host: "shop.customer.com" },
    });
    const res = await forwardRequest(peer.target, req, "/", "203.0.113.9");
    const got = await res.json() as any;

    // Without this the peer sees "127.0.0.1:PORT" and cannot resolve the domain.
    expect(got.host).toBe("shop.customer.com");
    expect(got.forwardedFrom).toBeTruthy();
  } finally {
    peer.stop();
  }
});

test("the visitor's IP reaches the peer, where IP rules are evaluated", async () => {
  const peer = startEchoServer();
  try {
    // No X-Forwarded-For on the way in: we supply what we worked out.
    const bare = new Request("http://shop.customer.com/", { headers: { host: "shop.customer.com" } });
    let got = await (await forwardRequest(peer.target, bare, "/", "203.0.113.9")).json() as any;
    expect(got.xff).toBe("203.0.113.9");

    // An X-Forwarded-For from the edge nginx already leads with the visitor.
    const viaNginx = new Request("http://shop.customer.com/", {
      headers: { host: "shop.customer.com", "x-forwarded-for": "198.51.100.7" },
    });
    got = await (await forwardRequest(peer.target, viaNginx, "/", "203.0.113.9")).json() as any;
    expect(got.xff).toBe("198.51.100.7");

    // Nothing known: send no header at all rather than the string "unknown",
    // which an allowlist would treat as a real (and never matching) address.
    const unknown = new Request("http://shop.customer.com/", { headers: { host: "shop.customer.com" } });
    got = await (await forwardRequest(peer.target, unknown, "/", undefined)).json() as any;
    expect(got.xff).toBeNull();
  } finally {
    peer.stop();
  }
});

test("method, path and query survive the hop", async () => {
  const peer = startEchoServer();
  try {
    const req = new Request("http://shop.customer.com/a/b?x=1&y=2", {
      method: "DELETE",
      headers: { host: "shop.customer.com" },
    });
    const got = await (await forwardRequest(peer.target, req, "/a/b?x=1&y=2", "203.0.113.9")).json() as any;
    expect(got.method).toBe("DELETE");
    expect(got.path).toBe("/a/b?x=1&y=2");
  } finally {
    peer.stop();
  }
});

test("an unreachable peer returns 502 rather than throwing", async () => {
  const req = new Request("http://shop.customer.com/", { headers: { host: "shop.customer.com" } });
  // Port 1 is not listening.
  const res = await forwardRequest({ serverHost: "127.0.0.1", serverPort: 1 }, req, "/", "203.0.113.9");
  expect(res.status).toBe(502);
});

// -----------------------------------------------------------------------------
// WebSocket relay
// -----------------------------------------------------------------------------

test("the WS target keeps Host and drops this hop's handshake headers", () => {
  const req = new Request("http://shop.customer.com/socket", {
    headers: {
      host: "shop.customer.com",
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "abc123",
      "sec-websocket-version": "13",
      cookie: "session=xyz",
    },
  });

  const { url, headers } = buildCrossServerWsTarget(
    { serverHost: "10.0.0.2", serverPort: 3000 }, req, "/socket", "203.0.113.9"
  );

  expect(url).toBe("ws://10.0.0.2:3000/socket");
  expect(headers["host"]).toBe("shop.customer.com");
  expect(headers["cookie"]).toBe("session=xyz");     // app headers cross
  expect(headers["X-Forwarded-For"]).toBe("203.0.113.9");
  // The outgoing socket generates its own handshake; reusing ours breaks it.
  expect(headers["upgrade"]).toBeUndefined();
  expect(headers["connection"]).toBeUndefined();
  expect(headers["sec-websocket-key"]).toBeUndefined();
});

/** A stand-in for Bun's ServerWebSocket, recording what the visitor would see. */
function fakeVisitorSocket(targetUrl: string, targetHeaders: Record<string, string> = {}) {
  const sent: any[] = [];
  type CloseInfo = { code?: number; reason?: string };
  let closed: CloseInfo | null = null;
  const ws: RelaySocket & { sent: any[]; closed: CloseInfo | null } = {
    data: { type: "cross-server", targetUrl, targetHeaders, subdomain: "shop" },
    send(d: any) { sent.push(typeof d === "string" ? d : hex(new Uint8Array(d))); return 1; },
    close(code?: number, reason?: string) { closed = { code, reason } as CloseInfo; return undefined; },
    get sent() { return sent; },
    get closed() { return closed; },
  } as any;
  return ws;
}

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
};

test("frames relay in both directions between visitor and peer", async () => {
  const peer = startEchoServer();
  try {
    const ws = fakeVisitorSocket(`ws://127.0.0.1:${peer.server.port}/socket`, { host: "shop.customer.com" });
    openCrossServerRelay(ws);

    // peer→visitor
    await waitFor(() => ws.sent.includes("peer:hello"));

    // visitor→peer
    await waitFor(() => ws.data.peerReady === true);
    relayVisitorFrame(ws, "from-visitor");
    await waitFor(() => peer.received.some((r) => r.wsMessage === "from-visitor"));

    // and the echo comes back
    await waitFor(() => ws.sent.includes("peer-echo:from-visitor"));

    closeCrossServerRelay(ws, 1000, "done");
  } finally {
    peer.stop();
  }
});

test("frames sent before the peer link opens are queued, not dropped", async () => {
  const peer = startEchoServer();
  try {
    const ws = fakeVisitorSocket(`ws://127.0.0.1:${peer.server.port}/socket`);
    openCrossServerRelay(ws);

    // Send immediately — the peer socket is still connecting. A browser doing
    // this is normal, and the first frame is usually auth or subscribe.
    expect(ws.data.peerReady).toBe(false);
    relayVisitorFrame(ws, "first-frame");
    relayVisitorFrame(ws, "second-frame");
    expect(ws.data.pending.length).toBe(2);

    await waitFor(() => peer.received.some((r) => r.wsMessage === "first-frame"));
    await waitFor(() => peer.received.some((r) => r.wsMessage === "second-frame"));
    expect(ws.data.pending.length).toBe(0);

    closeCrossServerRelay(ws, 1000, "done");
  } finally {
    peer.stop();
  }
});

test("binary frames relay without corruption", async () => {
  const peer = startEchoServer();
  try {
    const ws = fakeVisitorSocket(`ws://127.0.0.1:${peer.server.port}/socket`);
    openCrossServerRelay(ws);
    await waitFor(() => ws.data.peerReady === true);

    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8, 0x00, 0xfe]);
    relayVisitorFrame(ws, binary);

    await waitFor(() => peer.received.some((r) => r.wsMessage === hex(binary)));
    // And back the other way, as bytes rather than mangled text.
    await waitFor(() => ws.sent.includes(hex(binary)));

    closeCrossServerRelay(ws, 1000, "done");
  } finally {
    peer.stop();
  }
});

test("the visitor hanging up closes the peer link (no socket leak)", async () => {
  const peer = startEchoServer();
  try {
    const ws = fakeVisitorSocket(`ws://127.0.0.1:${peer.server.port}/socket`);
    openCrossServerRelay(ws);
    await waitFor(() => ws.data.peerReady === true);

    closeCrossServerRelay(ws, 1000, "visitor gone");

    await waitFor(() => peer.received.some((r) => r.wsClosed !== undefined));
    expect(ws.data.peer.readyState).toBeGreaterThan(1); // CLOSING or CLOSED
  } finally {
    peer.stop();
  }
});

test("an abnormal close code is translated to one that is legal to send", async () => {
  const peer = startEchoServer();
  try {
    const ws = fakeVisitorSocket(`ws://127.0.0.1:${peer.server.port}/socket`);
    openCrossServerRelay(ws);
    await waitFor(() => ws.data.peerReady === true);

    // 1006 is set by the runtime on an abnormal close and may never be SENT.
    // Passing it through would throw inside the close handler.
    expect(() => closeCrossServerRelay(ws, 1006, "abnormal")).not.toThrow();
    await waitFor(() => peer.received.some((r) => r.wsClosed === 1000));
  } finally {
    peer.stop();
  }
});

test("the peer going away closes the visitor's socket too", async () => {
  const peer = startEchoServer();
  const ws = fakeVisitorSocket(`ws://127.0.0.1:${peer.server.port}/socket`);
  openCrossServerRelay(ws);
  await waitFor(() => ws.data.peerReady === true);

  peer.stop(); // peer server dies mid-session

  await waitFor(() => ws.closed !== null);
  expect(ws.closed).not.toBeNull();
});

test("an unreachable peer closes the visitor's socket instead of hanging", async () => {
  const ws = fakeVisitorSocket("ws://127.0.0.1:1/socket"); // nothing listening
  openCrossServerRelay(ws);

  // The visitor must not be left hanging on a socket that will never carry
  // anything. Which handler gets there first is timing-dependent (onclose with
  // 1006 usually beats onerror), so assert the outcome, not the route: closed
  // promptly, with a code that is legal to put on the wire.
  await waitFor(() => ws.closed !== null);
  const code = ws.closed!.code!;
  expect(code === 1000 || (code >= 3000 && code <= 4999)).toBe(true);
});

// -----------------------------------------------------------------------------
// TCP endpoint host
// -----------------------------------------------------------------------------
// A TCP port listens on exactly one server and a raw TCP connection carries no
// hostname, so the address handed to the customer must name that server. This
// is the value that decides whether a customer's database is reachable.

import { tcpPublicHost } from "../src/services/tcpService";

test("the TCP endpoint host comes from per-server config", () => {
  const before = { tcp: process.env.TCP_PUBLIC_HOST, vps: process.env.VPS_HOST };
  try {
    process.env.TCP_PUBLIC_HOST = "sgp1.private.koompi.cloud";
    delete process.env.VPS_HOST;
    expect(tcpPublicHost()).toBe("sgp1.private.koompi.cloud");

    // VPS_HOST is accepted for servers provisioned before the split.
    delete process.env.TCP_PUBLIC_HOST;
    process.env.VPS_HOST = "sgp2.private.koompi.cloud";
    expect(tcpPublicHost()).toBe("sgp2.private.koompi.cloud");

    // "localhost" was the old ansible default. Handing it to a customer points
    // them at their own machine, so it must read as "not configured" and let
    // the caller fall back instead.
    process.env.VPS_HOST = "localhost";
    delete process.env.TCP_PUBLIC_HOST;
    expect(tcpPublicHost()).toBeNull();

    // Nothing configured at all.
    delete process.env.VPS_HOST;
    expect(tcpPublicHost()).toBeNull();
  } finally {
    if (before.tcp === undefined) delete process.env.TCP_PUBLIC_HOST; else process.env.TCP_PUBLIC_HOST = before.tcp;
    if (before.vps === undefined) delete process.env.VPS_HOST; else process.env.VPS_HOST = before.vps;
  }
});
