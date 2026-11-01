import { describe, expect, test } from "bun:test";
import { FloodGuard, FLOOD_REASON_PREFIX, blockedResponse } from "../src/services/floodGuard";

function guard(overrides: Partial<ConstructorParameters<typeof FloodGuard>[0]> = {}) {
  let clock = 1_000_000;
  const blocks: Array<{ ip: string; reason: string; seconds: number }> = [];
  const notes: string[] = [];
  const g = new FloodGuard({
    enabled: true,
    requests: 100,
    windowMs: 10_000,
    blockMs: 600_000,
    maxBlockMs: 86_400_000,
    exempt: ["198.51.100.7", "203.0.113.0/24"],
    appMaxWaiting: 3,
    now: () => clock,
    block: (ip, reason, seconds) => blocks.push({ ip, reason, seconds }),
    notify: (m) => notes.push(m),
    ...overrides,
  });
  return { g, blocks, notes, advance: (ms: number) => (clock += ms) };
}

const send = (g: FloodGuard, ip: string, n: number, app = "app", forwarded = false) => {
  let blocked = false;
  for (let i = 0; i < n; i++) blocked = g.count(ip, app, forwarded) || blocked;
  return blocked;
};

describe("blocking floods", () => {
  test("up to the threshold in the window is fine; one more blocks the address, once", () => {
    const { g, blocks, notes } = guard();
    expect(send(g, "192.0.2.1", 100)).toBe(false);
    expect(blocks).toEqual([]);
    expect(send(g, "192.0.2.1", 1, "shop")).toBe(true);
    expect(blocks).toEqual([{ ip: "192.0.2.1", reason: `${FLOOD_REASON_PREFIX} over 100 requests in 10 s`, seconds: 600 }]);
    expect(notes[0]).toContain("192.0.2.1");
    expect(notes[0]).toContain("<code>app</code>"); // the app it hit most
  });

  test("the same rate spread over more than a window is never blocked", () => {
    const { g, blocks, advance } = guard();
    for (let s = 0; s < 6; s++) {
      expect(send(g, "192.0.2.2", 90)).toBe(false);
      advance(10_000);
    }
    expect(blocks).toEqual([]);
  });

  test("addresses are counted apart (a page load from many people is fine)", () => {
    const { g, blocks } = guard();
    for (let i = 1; i <= 50; i++) send(g, `192.0.2.${i}`, 60);
    expect(blocks).toEqual([]);
  });

  test("exempt, private, unknown and forwarded requests are never counted", () => {
    const { g, blocks } = guard();
    send(g, "198.51.100.7", 500);
    send(g, "203.0.113.99", 500);
    send(g, "10.130.0.15", 500);
    send(g, "127.0.0.1", 500);
    send(g, "unknown", 500);
    send(g, "192.0.2.3", 500, "app", true);
    expect(blocks).toEqual([]);
  });

  test("an address that comes back the same day is blocked twice as long each time, up to the cap", () => {
    const { g, blocks, advance } = guard({ maxBlockMs: 2_000_000 });
    for (let i = 0; i < 3; i++) {
      send(g, "192.0.2.4", 101);
      advance(700_000);
    }
    expect(blocks.map((b) => b.seconds)).toEqual([600, 1200, 2000]);
  });

  test("off: nothing is counted or blocked", () => {
    const { g, blocks } = guard({ enabled: false });
    send(g, "192.0.2.5", 1000);
    expect(blocks).toEqual([]);
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
