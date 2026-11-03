import { describe, expect, test } from "bun:test";
import { FloodGuard, FLOOD_REASON_PREFIX, blockedResponse, floodKey } from "../src/services/floodGuard";

function guard(overrides: Partial<ConstructorParameters<typeof FloodGuard>[0]> = {}) {
  let clock = 1_000_000;
  const blocks: Array<{ address: string; app: string; reason: string; seconds: number }> = [];
  const notes: string[] = [];
  const g = new FloodGuard({
    enabled: true,
    requests: 100,
    windowMs: 10_000,
    blockMs: 600_000,
    maxBlockMs: 3_600_000,
    repeatMs: 3_600_000,
    names: 50,
    exempt: ["198.51.100.7", "203.0.113.0/24"],
    appMaxWaiting: 3,
    now: () => clock,
    block: (address, app, reason, seconds) => blocks.push({ address, app, reason, seconds }),
    notify: (m) => notes.push(m),
    ...overrides,
  });
  return { g, blocks, notes, advance: (ms: number) => (clock += ms) };
}

/** Send n requests; how many were refused. */
const send = (g: FloodGuard, ip: string, n: number, app = "app", forwarded = false) => {
  let refused = 0;
  for (let i = 0; i < n; i++) if (g.count(ip, app, forwarded)) refused++;
  return refused;
};

describe("one address flooding one app", () => {
  test("up to the threshold is fine; beyond it the rest of the window is refused, and nothing is blocked yet", () => {
    const { g, blocks, notes, advance } = guard();
    expect(send(g, "192.0.2.1", 100)).toBe(0);
    const refusal = g.count("192.0.2.1", "app", false);
    expect(refusal?.reason.startsWith(FLOOD_REASON_PREFIX)).toBe(true);
    expect(refusal?.secondsLeft).toBeLessThanOrEqual(10);
    expect(send(g, "192.0.2.1", 50)).toBe(50);
    expect(blocks).toEqual([]);
    expect(notes).toEqual([]);
    advance(10_000);
    expect(send(g, "192.0.2.1", 100)).toBe(0); // the next window is open again
  });

  test("3,001 requests to app A never refuse the same address on app B", () => {
    const { g } = guard({ requests: 3000 });
    send(g, "192.0.2.10", 3001, "app-a");
    expect(g.count("192.0.2.10", "app-b", false)).toBeNull();
    expect(send(g, "192.0.2.10", 500, "app-b")).toBe(0);
  });

  test("flooding the same app again within the hour blocks it, for that app only, on every edge", () => {
    const { g, blocks, notes, advance } = guard();
    send(g, "192.0.2.2", 101, "shop");
    advance(10_000);
    expect(send(g, "192.0.2.2", 101, "shop")).toBe(1);
    expect(blocks).toEqual([{ address: "192.0.2.2", app: "shop", reason: `${FLOOD_REASON_PREFIX} over 100 requests to shop in 10 s`, seconds: 600 }]);
    expect(notes[0]).toContain("<code>shop</code>");
    expect(notes[0]).toContain("other apps are served");
    expect(g.count("192.0.2.2", "blog", false)).toBeNull();
  });

  test("each further flood within the hour doubles the block, up to an hour; an hour later it starts over", () => {
    const { g, blocks, advance } = guard();
    for (let i = 0; i < 6; i++) {
      send(g, "192.0.2.4", 101);
      advance(10_000);
    }
    expect(blocks.map((b) => b.seconds)).toEqual([600, 1200, 2400, 3600, 3600]);
    advance(3_600_000);
    send(g, "192.0.2.4", 101);
    expect(blocks).toHaveLength(5); // a first flood again: refused for the window, not blocked
  });

  test("the same rate spread over more than a window is never refused", () => {
    const { g, blocks, advance } = guard();
    for (let s = 0; s < 6; s++) {
      expect(send(g, "192.0.2.3", 90)).toBe(0);
      advance(10_000);
    }
    expect(blocks).toEqual([]);
  });

  test("addresses are counted apart (a page load from many people is fine)", () => {
    const { g, blocks } = guard();
    for (let i = 1; i <= 50; i++) expect(send(g, `192.0.2.${i}`, 60)).toBe(0);
    expect(blocks).toEqual([]);
  });

  test("an IPv6 /64 counts as one address", () => {
    expect(floodKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(floodKey("[2001:DB8:1:2::bbbb]")).toBe("2001:db8:1:2::/64");
    expect(floodKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(floodKey("::ffff:192.0.2.9")).toBe("192.0.2.9");
    const { g } = guard();
    send(g, "2001:db8:1:2::1", 60);
    expect(send(g, "2001:db8:1:2::2", 60)).toBe(20);
    expect(send(g, "2001:db8:1:3::1", 60)).toBe(0);
  });

  test("exempt, private, unknown and forwarded requests are never counted", () => {
    const { g, blocks } = guard();
    expect(send(g, "198.51.100.7", 500)).toBe(0);
    expect(send(g, "203.0.113.99", 500)).toBe(0);
    expect(send(g, "10.130.0.15", 500)).toBe(0);
    expect(send(g, "127.0.0.1", 500)).toBe(0);
    expect(send(g, "unknown", 500)).toBe(0);
    expect(send(g, "192.0.2.5", 500, "app", true)).toBe(0);
    expect(blocks).toEqual([]);
  });

  test("off: nothing is counted or refused", () => {
    const { g, blocks } = guard({ enabled: false });
    expect(send(g, "192.0.2.6", 1000)).toBe(0);
    expect(blocks).toEqual([]);
  });
});

describe("one address asking for names at random", () => {
  test("over the limit of different names, it is refused every app on this edge alone", () => {
    const { g, blocks, notes, advance } = guard();
    for (let i = 0; i < 50; i++) expect(g.count("192.0.2.7", `random-${i}`, false)).toBeNull();
    expect(g.count("192.0.2.7", "random-50", false)?.secondsLeft).toBe(600);
    expect(g.count("192.0.2.7", "real-app", false)).not.toBeNull();
    expect(blocks).toEqual([]); // not saved for the other edges
    expect(notes[0]).toContain("this edge");
    advance(600_000);
    expect(g.count("192.0.2.7", "real-app", false)).toBeNull();
  });

  test("a crowd behind one address using a few apps a lot is not that", () => {
    const { g } = guard();
    for (let i = 0; i < 90; i++) for (const app of ["exam", "school-site", "live-0123456789"]) g.count("192.0.2.8", app, false);
    expect(g.count("192.0.2.8", "exam", false)).toBeNull();
  });
});

describe("one app can't take an edge over", () => {
  test("at most appMaxWaiting of an app's requests wait; other apps are unaffected", () => {
    const { g } = guard();
    expect([g.startWaiting("busy"), g.startWaiting("busy"), g.startWaiting("busy")]).toEqual([true, true, true]);
    expect(g.startWaiting("busy")).toBe(false);
    expect(g.startWaiting("other")).toBe(true);
    g.stopWaiting("busy");
    expect(g.startWaiting("busy")).toBe(true);
    expect(g.waitingFor("busy")).toBe(3);
  });
});

test("a flood block is answered 429 with Retry-After; any other block 403", () => {
  const flood = blockedResponse({ reason: `${FLOOD_REASON_PREFIX} over 3000 requests in 10 s`, secondsLeft: 540 });
  expect(flood.status).toBe(429);
  expect(flood.headers.get("retry-after")).toBe("540");
  expect(blockedResponse({ reason: "Blocked by admin", secondsLeft: 60 }).status).toBe(403);
});
