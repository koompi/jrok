/**
 * StaleCache backs every lookup on the request path that used to wait on
 * MongoDB once a TTL ran out (P8 in docs/plans/jrok-scale-out-plan.md). The
 * rules pinned here are what keep traffic flowing through a MongoDB outage.
 */
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { StaleCache } from "../src/utils/staleCache";

const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => setSystemTime());

function counting<V>(answer: () => V | Promise<V>) {
  const calls: string[] = [];
  const load = async (key: string) => {
    calls.push(key);
    return answer();
  };
  return { calls, load };
}

describe("StaleCache", () => {
  test("a fresh answer is reused without loading again", async () => {
    const { calls, load } = counting(() => 1);
    const cache = new StaleCache("t", load, 1_000);
    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("a")).toBe(1);
    expect(calls).toEqual(["a"]);
  });

  test("an expired answer is returned at once while one reload runs", async () => {
    let value = 1;
    const slow = () => new Promise((r) => setTimeout(r, 30));
    const { calls, load } = counting(async () => { await slow(); return value; });
    const cache = new StaleCache("t", load, 1_000);
    await cache.get("a");

    setSystemTime(new Date(Date.now() + 5_000));
    value = 2;
    expect(await cache.get("a")).toBe(1); // stale, not waited for
    expect(await cache.get("a")).toBe(1); // the reload is still running
    await slow();
    await tick();
    expect(await cache.get("a")).toBe(2);
    expect(calls).toEqual(["a", "a"]);
  });

  test("a failed reload keeps the old answer and waits a TTL before retrying", async () => {
    let fail = false;
    const { calls, load } = counting(() => {
      if (fail) throw new Error("MongoDB unreachable");
      return "known";
    });
    const cache = new StaleCache("t", load, 1_000);
    await cache.get("a");

    fail = true;
    setSystemTime(new Date(Date.now() + 5_000));
    expect(await cache.get("a")).toBe("known");
    await tick();
    expect(await cache.get("a")).toBe("known");
    expect(calls.length).toBe(2); // not one reload per request

    setSystemTime(new Date(Date.now() + 2_000));
    expect(await cache.get("a")).toBe("known");
    await tick();
    expect(calls.length).toBe(3);
  });

  test("with no answer yet, get() waits for the load and passes its error on", async () => {
    const cache = new StaleCache("t", async () => { throw new Error("down"); }, 1_000);
    await expect(cache.get("a")).rejects.toThrow("down");
  });

  test("getNow() never waits: undefined at first, the answer once loaded", async () => {
    const { calls, load } = counting(() => 7);
    const cache = new StaleCache("t", load, 1_000);
    expect(cache.getNow("a")).toBeUndefined();
    await tick();
    expect(cache.getNow("a")).toBe(7);
    expect(calls).toEqual(["a"]);
  });

  test("concurrent first loads share one query", async () => {
    const { calls, load } = counting(async () => { await tick(); return 1; });
    const cache = new StaleCache("t", load, 1_000);
    const results = await Promise.all([cache.get("a"), cache.get("a"), cache.get("a")]);
    expect(results).toEqual([1, 1, 1]);
    expect(calls).toEqual(["a"]);
  });

  test("an answer set while a load runs is not overwritten by that load", async () => {
    const { load } = counting(async () => { await tick(); return "from db"; });
    const cache = new StaleCache("t", load, 1_000);
    const loading = cache.get("a");
    cache.set("a", "written here");
    expect(await loading).toBe("from db");
    expect(await cache.get("a")).toBe("written here");
  });

  test("delete() makes the next get() load again", async () => {
    const { calls, load } = counting(() => 1);
    const cache = new StaleCache("t", load, 1_000);
    await cache.get("a");
    cache.delete("a");
    await cache.get("a");
    expect(calls).toEqual(["a", "a"]);
  });

  test("entries are bounded, oldest dropped first", async () => {
    const cache = new StaleCache<string, number>("t", async () => 0, 1_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.getNow("a")).toBeUndefined();
    expect(cache.getNow("b")).toBe(2);
    expect(cache.getNow("c")).toBe(3);
  });
});
