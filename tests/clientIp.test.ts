import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  getClientIp,
  normalizeIp,
  parseForwardedFor,
  ipMatchesAny,
  trustedProxyHops,
  setForwardedClientHeaders,
} from "../src/utils/clientIp";

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
});
