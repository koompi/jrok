/**
 * Stopping jrok (utils/shutdown.ts). systemd's SIGTERM used to kill it at once,
 * losing the usage counted since the last flush; only SIGINT was handled.
 */
import { test, expect } from "bun:test";
import { shutdownHandler } from "../src/utils/shutdown";

function steps(flush: () => Promise<void> = async () => {}) {
  const done: string[] = [];
  const handler = shutdownHandler({
    flush: async () => { done.push("flush"); await flush(); },
    stop: () => { done.push("stop"); },
    leave: async () => { done.push("leave"); },
    closeDatabase: async () => { done.push("close"); },
    exit: (code) => { done.push(`exit ${code}`); },
    flushTimeoutMs: 50,
    log: () => {},
  });
  return { handler, done };
}

test("SIGTERM (systemd: deploys, restarts) writes usage and stops, keeping this edge's TCP ports", async () => {
  const { handler, done } = steps();
  await handler("SIGTERM");
  expect(done).toEqual(["flush", "stop", "close", "exit 0"]);
});

test("SIGINT also leaves the cluster, as before", async () => {
  const { handler, done } = steps();
  await handler("SIGINT");
  expect(done).toEqual(["flush", "stop", "leave", "close", "exit 0"]);
});

test("a MongoDB that hangs or fails can't keep jrok from stopping", async () => {
  const hung = steps(() => new Promise(() => {}));
  const started = Date.now();
  await hung.handler("SIGTERM");
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(hung.done.at(-1)).toBe("exit 0");

  const failing = steps(async () => { throw new Error("Server selection timed out"); });
  await failing.handler("SIGTERM");
  expect(failing.done.at(-1)).toBe("exit 0");
});

test("a second signal while stopping does nothing", async () => {
  const { handler, done } = steps();
  await Promise.all([handler("SIGTERM"), handler("SIGTERM"), handler("SIGINT")]);
  expect(done.filter((d) => d.startsWith("exit"))).toEqual(["exit 0"]);
});
