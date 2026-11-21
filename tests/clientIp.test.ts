import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  getClientIp,
  normalizeIp,
  parseForwardedFor,
  ipMatchesAny,
  trustedProxyHops,
  setForwardedClientHeaders,
  isCloudflareAddress,
  VISITOR_ONLY_IP_HEADERS,
  CLOUDFLARE_RANGES,
} from "../src/utils/clientIp";
import { readFileSync } from "fs";

// nginx forwards with `X-Forwarded-For $proxy_add_x_forwarded_for`, which
// APPENDS the address it saw. Everything to the left of that is whatever the
// visitor typed. These tests pin down that only our proxies' entries count.

const original = { hops: process.env.TRUSTED_PROXY_HOPS, ips: process.env.TRUSTED_PROXY_IPS };

beforeEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
  delete process.env.TRUSTED_PROXY_IPS;
});

afterAll(() => {
  if (original.hops === undefined) delete process.env.TRUSTED_PROXY_HOPS; else process.env.TRUSTED_PROXY_HOPS = original.hops;
  if (original.ips === undefined) delete process.env.TRUSTED_PROXY_IPS; else process.env.TRUSTED_PROXY_IPS = original.ips;
});

const req = (headers: Record<string, string>) => new Request("http://shop.example.com/", { headers });

describe("behind one nginx (the shipped topology)", () => {
  test("a forged first hop is ignored; the entry nginx appended wins", () => {
    // Visitor 203.0.113.9 sends `X-Forwarded-For: 10.0.0.1` hoping to match an
    // allowlist; nginx appends the real address.
    const r = req({ "x-forwarded-for": "10.0.0.1, 203.0.113.9", "x-real-ip": "203.0.113.9" });
    expect(getClientIp(r, "127.0.0.1")).toBe("203.0.113.9");
  });

  test("a long forged chain changes nothing", () => {
    const r = req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.7" });
    expect(getClientIp(r, "127.0.0.1")).toBe("198.51.100.7");
  });

  test("an honest single-entry chain is the visitor", () => {
    expect(getClientIp(req({ "x-forwarded-for": "198.51.100.7" }), "127.0.0.1")).toBe("198.51.100.7");
  });

  test("defaults to one trusted hop", () => {
    expect(trustedProxyHops()).toBe(1);
  });

  test("X-Real-IP is used when a proxy sets only that", () => {
    expect(getClientIp(req({ "x-real-ip": "198.51.100.7" }), "127.0.0.1")).toBe("198.51.100.7");
  });

  test("no forwarding headers at all: the socket address", () => {
    expect(getClientIp(req({}), "198.51.100.7")).toBe("198.51.100.7");
  });

  test("a malformed entry where nginx's should be falls back to the socket", () => {
    // nginx always writes a valid $remote_addr; this request didn't come through it.
    expect(getClientIp(req({ "x-forwarded-for": "1.2.3.4, <script>" }), "198.51.100.7")).toBe("198.51.100.7");
    expect(getClientIp(req({ "x-forwarded-for": "garbage" }), null)).toBe("unknown");
  });

  test("nothing known at all is 'unknown'", () => {
    expect(getClientIp(req({}), undefined)).toBe("unknown");
  });

  test("accepts bare Headers", () => {
    expect(getClientIp(new Headers({ "x-forwarded-for": "10.0.0.1, 203.0.113.9" }), null)).toBe("203.0.113.9");
  });
});

describe("TRUSTED_PROXY_HOPS", () => {
  test("0: headers are pure client input, only the socket counts", () => {
    process.env.TRUSTED_PROXY_HOPS = "0";
    const r = req({ "x-forwarded-for": "10.0.0.1", "x-real-ip": "10.0.0.1" });
    expect(getClientIp(r, "198.51.100.7")).toBe("198.51.100.7");
    expect(getClientIp(r, undefined)).toBe("unknown");
  });

  test("2 (e.g. Cloudflare -> nginx): second from the right", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    // forged, visitor (appended by Cloudflare), Cloudflare edge (appended by nginx)
    const r = req({ "x-forwarded-for": "10.0.0.1, 203.0.113.9, 172.70.1.1" });
    expect(getClientIp(r, "127.0.0.1")).toBe("203.0.113.9");
  });

  test("a chain shorter than the hop count yields its first entry", () => {
    expect(getClientIp(req({ "x-forwarded-for": "203.0.113.9" }), null, { trustedHops: 3 })).toBe("203.0.113.9");
  });

  test("a bad value falls back to the default", () => {
    process.env.TRUSTED_PROXY_HOPS = "lots";
    expect(trustedProxyHops()).toBe(1);
    process.env.TRUSTED_PROXY_HOPS = "-1";
    expect(trustedProxyHops()).toBe(1);
  });
});

describe("TRUSTED_PROXY_IPS", () => {
  test("a connection from a trusted proxy may name the client", () => {
    process.env.TRUSTED_PROXY_IPS = "127.0.0.1, 10.0.0.0/8";
    const r = req({ "x-forwarded-for": "10.9.9.9, 203.0.113.9" });
    expect(getClientIp(r, "127.0.0.1")).toBe("203.0.113.9");
    expect(getClientIp(r, "10.20.30.40")).toBe("203.0.113.9");
  });

  test("anyone else connecting straight to jrok's port can't", () => {
    process.env.TRUSTED_PROXY_IPS = "127.0.0.1";
    const r = req({ "x-forwarded-for": "10.0.0.1", "x-real-ip": "10.0.0.1" });
    expect(getClientIp(r, "198.51.100.7")).toBe("198.51.100.7");
  });

  test("an IPv4-mapped socket address matches its IPv4 entry", () => {
    process.env.TRUSTED_PROXY_IPS = "127.0.0.1";
    expect(getClientIp(req({ "x-forwarded-for": "203.0.113.9" }), "::ffff:127.0.0.1")).toBe("203.0.113.9");
  });
});

describe("normalizeIp", () => {
  test("canonical forms", () => {
    expect(normalizeIp(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(normalizeIp("203.0.113.9:51234")).toBe("203.0.113.9");
    expect(normalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIp("[2001:DB8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });

  test("rejects things that aren't addresses", () => {
    expect(normalizeIp("unknown")).toBeNull();
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("1.2.3")).toBeNull();
    expect(normalizeIp("<script>")).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});

test("parseForwardedFor splits and trims", () => {
  expect(parseForwardedFor(" a , b,,c ")).toEqual(["a", "b", "c"]);
  expect(parseForwardedFor(null)).toEqual([]);
});

test("ipMatchesAny: exact and IPv4 CIDR", () => {
  expect(ipMatchesAny("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
  expect(ipMatchesAny("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
  expect(ipMatchesAny("192.168.1.200", ["192.168.1.128/25"])).toBe(true);
  expect(ipMatchesAny("192.168.1.100", ["192.168.1.128/25"])).toBe(false);
  expect(ipMatchesAny("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
  expect(ipMatchesAny("::1", ["::1"])).toBe(true);
  expect(ipMatchesAny("::1", ["10.0.0.0/8"])).toBe(false);
  expect(ipMatchesAny("garbage", ["0.0.0.0/0"])).toBe(false);
});

test("ipMatchesAny: IPv6 ranges and exact matches in any spelling", () => {
  expect(ipMatchesAny("2606:4700:10::6816:1a3b", ["2606:4700::/32"])).toBe(true);
  expect(ipMatchesAny("2606:4701::1", ["2606:4700::/32"])).toBe(false);
  expect(ipMatchesAny("2a06:98c7:ffff::1", ["2a06:98c0::/29"])).toBe(true);
  expect(ipMatchesAny("2a06:98c8::1", ["2a06:98c0::/29"])).toBe(false);
  expect(ipMatchesAny("[2001:db8::1]:443", ["2001:0db8:0000:0000:0000:0000:0000:0001"])).toBe(true);
  expect(ipMatchesAny("2001:db8::1", ["::/0"])).toBe(true);
  expect(ipMatchesAny("64:ff9b::192.0.2.1", ["64:ff9b::c000:200/120"])).toBe(true);
  // Families never cross: a v4 range never holds a v6 address and back.
  expect(ipMatchesAny("2001:db8::1", ["0.0.0.0/0"])).toBe(false);
  expect(ipMatchesAny("8.8.8.8", ["::/0"])).toBe(false);
  // "::ffff:1.2.3.4" is the IPv4 client Bun reports on a dual-stack socket.
  expect(ipMatchesAny("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
});

test("ipMatchesAny: a malformed range matches nothing (\"10.0.0.0/\" used to read as /0)", () => {
  for (const entry of ["10.0.0.0/", "10.0.0.0/x", "10.0.0.0/33", "10.0.0.0/-1", "2606:4700::/129", "2606:4700::/", "1:2:3:4:5:6:7::8/64", ":::/0"]) {
    expect([entry, ipMatchesAny("10.1.2.3", [entry]) || ipMatchesAny("2606:4700::1", [entry])]).toEqual([entry, false]);
  }
});

describe("Cloudflare's addresses", () => {
  const saved = process.env.CLOUDFLARE_IPS;
  afterAll(() => { if (saved === undefined) delete process.env.CLOUDFLARE_IPS; else process.env.CLOUDFLARE_IPS = saved; });

  test("its published ranges, v4 and v6", () => {
    delete process.env.CLOUDFLARE_IPS;
    expect(isCloudflareAddress("172.70.1.2")).toBe(true);
    expect(isCloudflareAddress("162.158.200.1")).toBe(true);
    expect(isCloudflareAddress("2a06:98c1:3120::3")).toBe(true);
    expect(isCloudflareAddress("203.0.113.9")).toBe(false);
    expect(isCloudflareAddress("2001:db8::1")).toBe(false);
    expect(isCloudflareAddress(null)).toBe(false);
    expect(CLOUDFLARE_RANGES.length).toBe(22);
  });

  test("CLOUDFLARE_IPS replaces the list", () => {
    process.env.CLOUDFLARE_IPS = "198.51.100.0/24";
    expect(isCloudflareAddress("198.51.100.7")).toBe(true);
    expect(isCloudflareAddress("172.70.1.2")).toBe(false);
    delete process.env.CLOUDFLARE_IPS;
  });
});

describe("setForwardedClientHeaders (what the customer's app receives)", () => {
  test("the forged chain is replaced by the verified address", () => {
    const headers: Record<string, string> = {
      host: "shop.example.com",
      "x-forwarded-for": "10.0.0.1, 203.0.113.9",
      "x-real-ip": "203.0.113.9",
      forwarded: "for=10.0.0.1",
    };
    setForwardedClientHeaders(headers, "203.0.113.9");
    expect(headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(headers["x-real-ip"]).toBe("203.0.113.9");
    expect(headers["forwarded"]).toBeUndefined();
    expect(headers["host"]).toBe("shop.example.com");
  });

  test("unknown client: no address header at all, not the visitor's claim", () => {
    const headers: Record<string, string> = { "x-forwarded-for": "10.0.0.1", "x-real-ip": "10.0.0.1" };
    setForwardedClientHeaders(headers, "unknown");
    expect(headers["x-forwarded-for"]).toBeUndefined();
    expect(headers["x-real-ip"]).toBeUndefined();
  });

  // J4: a custom domain's vhost passes these through (the public wildcard blanks
  // them in nginx), and apps behind Cloudflare or a PaaS take them for the client.
  const forged = () => ({
    host: "shop.example.com",
    "x-client-ip": "10.0.0.1",
    "client-ip": "10.0.0.1",
    "cf-connecting-ip": "10.0.0.1",
    "true-client-ip": "10.0.0.1",
    "fastly-client-ip": "10.0.0.1",
    "x-cluster-client-ip": "10.0.0.1",
    "fly-client-ip": "10.0.0.1",
  } as Record<string, string>);

  test("a visitor's own client-IP headers never reach the app", () => {
    const headers = forged();
    setForwardedClientHeaders(headers, "203.0.113.9");
    expect(Object.keys(headers).sort()).toEqual(["host", "x-forwarded-for", "x-real-ip"]);
    expect(headers["x-forwarded-for"]).toBe("203.0.113.9");
  });

  test("nor when jrok knows no address", () => {
    const headers = forged();
    setForwardedClientHeaders(headers, "unknown");
    expect(Object.keys(headers)).toEqual(["host"]);
  });

  test("from Cloudflare (an orange-clouded custom domain) its own two stay: the app reads its visitor there", () => {
    for (const cloudflare of ["172.70.1.2", "2a06:98c1:3120::3"]) {
      const headers = forged();
      setForwardedClientHeaders(headers, cloudflare);
      expect(Object.keys(headers).sort()).toEqual(["cf-connecting-ip", "host", "true-client-ip", "x-forwarded-for", "x-real-ip"]);
      expect(headers["cf-connecting-ip"]).toBe("10.0.0.1");
      expect(headers["x-forwarded-for"]).toBe(cloudflare);
    }
  });

  test("the list is the public entry's in nginx (ansible jrok_visitor_only_headers), less the peer key peerLink.ts strips", () => {
    const role = readFileSync(new URL("../ansible/roles/nginx/tasks/main.yml", import.meta.url), "utf8");
    const list = role.match(/\{% set jrok_visitor_only_headers = \[([^\]]*)\] %\}/)?.[1] ?? "";
    const nginx = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!.toLowerCase()).filter((h) => h !== "x-jrok-peer-key");
    // A header added on one side only: add it to the other (clientIp.ts VISITOR_ONLY_IP_HEADERS or the role's list).
    expect([...VISITOR_ONLY_IP_HEADERS].sort()).toEqual(nginx.sort());
  });
});
