/**
 * Edges reaching each other (P10, utils/peerLink.ts): over FORWARD_URL with the
 * peer key, the visitor's Host and address surviving the hop, and the key never
 * sent in the clear nor passed to a customer's app.
 *
 * The stub peers here are plain http: what is pinned is what each edge sends
 * and believes. TLS itself is nginx's and Bun's, checked on staging.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  PEER_KEY_HEADER,
  FORWARDED_HOST_HEADER,
  isFromPeer,
  ownForwardUrl,
  peerKey,
  peerOrigin,
  stripPeerHeaders,
} from "../src/utils/peerLink";
import { getClientIp } from "../src/utils/clientIp";
import { forwardRequest, buildCrossServerWsTarget } from "../src/services/crossServerService";

const KEY = "k".repeat(40);
const saved = { key: process.env.JROK_PEER_KEY, url: process.env.FORWARD_URL, hops: process.env.TRUSTED_PROXY_HOPS };

beforeEach(() => {
  process.env.JROK_PEER_KEY = KEY;
  delete process.env.FORWARD_URL;
  delete process.env.TRUSTED_PROXY_HOPS;
});

afterEach(() => {
  for (const [name, value] of [["JROK_PEER_KEY", saved.key], ["FORWARD_URL", saved.url], ["TRUSTED_PROXY_HOPS", saved.hops]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A stub edge that records the headers of what it receives. */
function stubPeer() {
  const received: Headers[] = [];
  const server = Bun.serve({ port: 0, fetch(req) { received.push(req.headers); return new Response("ok"); } });
  return { port: server.port as number, received, stop: () => server.stop(true) };
}

function visitorRequest() {
  return new Request("http://app.example.test/page?x=1", {
    headers: {
      host: "app.example.test",
      // What a visitor might try: claim to be an edge, and pick its own address.
      [PEER_KEY_HEADER]: "guess",
      [FORWARDED_HOST_HEADER]: "other-app.example.test",
      "x-forwarded-for": "10.9.9.9",
    },
  });
}

describe("the peer key", () => {
  test("only a key of 32 characters or more is used", () => {
    process.env.JROK_PEER_KEY = "short";
    expect(peerKey()).toBeNull();
    process.env.JROK_PEER_KEY = KEY;
    expect(peerKey()).toBe(KEY);
  });

  test("a request is from a peer only with exactly this edge's key", () => {
    expect(isFromPeer(new Headers({ [PEER_KEY_HEADER]: KEY }))).toBe(true);
    expect(isFromPeer(new Headers({ [PEER_KEY_HEADER]: KEY + "x" }))).toBe(false);
    expect(isFromPeer(new Headers())).toBe(false);
    delete process.env.JROK_PEER_KEY; // a receiver without a key trusts no one
    expect(isFromPeer(new Headers({ [PEER_KEY_HEADER]: KEY }))).toBe(false);
  });
});

describe("visitor address on the receiving edge", () => {
  // The sending edge wrote the visitor; this edge's nginx appended the sender.
  const forwarded = (key?: string) =>
    new Headers({ "x-forwarded-for": "203.0.113.7, 198.51.100.2", ...(key ? { [PEER_KEY_HEADER]: key } : {}) });

  test("with the key: the visitor the sending edge verified", () => {
    expect(getClientIp(forwarded(KEY), "127.0.0.1")).toBe("203.0.113.7");
  });

  test("without it, or with a wrong one: whoever connected to nginx, as for any visitor", () => {
    expect(getClientIp(forwarded(), "127.0.0.1")).toBe("198.51.100.2");
    expect(getClientIp(forwarded("guess"), "127.0.0.1")).toBe("198.51.100.2");
  });
});

describe("forwarding to an edge with a FORWARD_URL", () => {
  test("goes to that URL with the visitor's Host, address and the key, replacing the visitor's own claims", async () => {
    const peer = stubPeer();
    try {
      const target = { serverHost: "203.0.113.50", serverPort: 3000, forwardUrl: `http://127.0.0.1:${peer.port}` };
      const res = await forwardRequest(target, visitorRequest(), "/page?x=1", "203.0.113.7");
      expect(res.status).toBe(200);

      const got = peer.received[0];
      expect(got.get("host")).toBe(`127.0.0.1:${peer.port}`); // the edge's name, for its nginx
      expect(got.get(FORWARDED_HOST_HEADER)).toBe("app.example.test");
      expect(got.get(PEER_KEY_HEADER)).toBe(KEY);
      expect(got.get("x-forwarded-for")).toBe("203.0.113.7");
      expect(got.get("x-forwarded-from")).toBeTruthy();
    } finally {
      peer.stop();
    }
  });

  test("a WebSocket goes to the same place, wss:// for https", () => {
    const target = { serverHost: "203.0.113.50", serverPort: 3000, forwardUrl: "https://edge-b.example.test" };
    const { url, headers } = buildCrossServerWsTarget(target, visitorRequest(), "/socket", "203.0.113.7");
    expect(url).toBe("wss://edge-b.example.test/socket");
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower.host).toBeUndefined(); // set from the URL
    expect(lower[FORWARDED_HOST_HEADER.toLowerCase()]).toBe("app.example.test");
    expect(lower[PEER_KEY_HEADER.toLowerCase()]).toBe(KEY);
  });
});

test("a compressed response is passed on exactly as the peer sent it", async () => {
  const gzipped = Bun.gzipSync(new TextEncoder().encode("x".repeat(5000)));
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(gzipped, { headers: { "content-type": "text/plain", "content-encoding": "gzip" } }),
  });
  try {
    const res = await forwardRequest({ serverHost: "127.0.0.1", serverPort: server.port as number }, visitorRequest(), "/", "203.0.113.7");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    // The visitor unzips it; fetch must not have done so already.
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(gzipped))).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("an app's redirect reaches the visitor as it is, cookie included (P34)", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/login"
        ? new Response("the login page")
        : new Response(null, { status: 307, headers: { location: "/login?callbackUrl=%2F", "set-cookie": "csrf=1; Path=/" } }),
  });
  try {
    const res = await forwardRequest({ serverHost: "127.0.0.1", serverPort: server.port as number }, visitorRequest(), "/", "203.0.113.7");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/login?callbackUrl=%2F");
    expect(res.headers.get("set-cookie")).toBe("csrf=1; Path=/");
  } finally {
    server.stop(true);
  }
});

describe("forwarding to an edge without one (one edge, or not yet upgraded)", () => {
  test("plain http to its jrok port, as before, and the key is never sent in the clear", async () => {
    const peer = stubPeer();
    try {
      const res = await forwardRequest({ serverHost: "127.0.0.1", serverPort: peer.port }, visitorRequest(), "/", "203.0.113.7");
      expect(res.status).toBe(200);
      const got = peer.received[0];
      expect(got.get("host")).toBe("app.example.test");
      expect(got.get(PEER_KEY_HEADER)).toBeNull();
      expect(got.get(FORWARDED_HOST_HEADER)).toBeNull();
    } finally {
      peer.stop();
    }
  });

  test("its WebSocket stays ws:// to the jrok port", () => {
    const { url, headers } = buildCrossServerWsTarget({ serverHost: "10.0.0.2", serverPort: 3000 }, visitorRequest(), "/s");
    expect(url).toBe("ws://10.0.0.2:3000/s");
    expect(headers.host).toBe("app.example.test");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(PEER_KEY_HEADER.toLowerCase());
  });
});

describe("FORWARD_URL", () => {
  test("is recorded as an origin; anything that isn't an http(s) URL is ignored", () => {
    expect(ownForwardUrl()).toBeNull();
    process.env.FORWARD_URL = "https://edge-a.example.test/";
    expect(ownForwardUrl()).toBe("https://edge-a.example.test");
    process.env.FORWARD_URL = "edge-a.example.test";
    expect(ownForwardUrl()).toBeNull();
    process.env.FORWARD_URL = "ftp://edge-a.example.test";
    expect(ownForwardUrl()).toBeNull();
  });

  test("peerOrigin prefers it over the jrok port", () => {
    expect(peerOrigin({ serverHost: "10.0.0.2", serverPort: 3000, forwardUrl: "https://edge-b.example.test" })).toBe("https://edge-b.example.test");
    expect(peerOrigin({ serverHost: "10.0.0.2", serverPort: 3000 })).toBe("http://10.0.0.2:3000");
  });
});

test("the key and forwarded host never reach a customer's app", () => {
  const headers: Record<string, string> = {
    "x-jrok-peer-key": KEY,
    "x-jrok-forwarded-host": "app.example.test",
    "accept": "text/html",
  };
  stripPeerHeaders(headers);
  expect(headers).toEqual({ accept: "text/html" });
});
