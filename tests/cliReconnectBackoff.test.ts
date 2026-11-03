/**
 * The CLI's reconnect backoff starts over only once the server has welcomed
 * the agent. A server that takes the WebSocket and then refuses the tunnel (a
 * registration error: an error message, then close 1011) used to get it back
 * about every second forever, because the backoff also reset when the socket
 * opened. The connector (connector/src/tunnel.rs) follows the same rule.
 *
 * Runs the real CLI against a fake server on this machine. HOME is a temp dir
 * whose config skips the update check, so nothing leaves the machine.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const home = mkdtempSync(join(tmpdir(), "jrok-cli-backoff-"));
mkdirSync(join(home, ".jrok"));
writeFileSync(join(home, ".jrok", "config.json"), JSON.stringify({ skipUpdateCheck: true }));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The attempt numbers of the CLI's first `count` reconnects. */
async function reconnectAttempts(serverPort: number, count: number): Promise<number[]> {
  const cli = Bun.spawn(
    ["bun", join(import.meta.dir, "../cli/src/index.ts"), "--server", `http://127.0.0.1:${serverPort}`, "--port", "1", "--domain", "backoff-test", "--auth", "k"],
    { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "ignore" },
  );
  const reader = cli.stdout.getReader();
  const decoder = new TextDecoder();
  let printed = "";
  let attempts: number[] = [];
  try {
    while (attempts.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      printed += decoder.decode(value, { stream: true });
      attempts = [...printed.matchAll(/\(attempt (\d+)\)/g)].map((m) => Number(m[1]));
    }
  } finally {
    cli.kill();
  }
  return attempts.slice(0, count);
}

test("a server that refuses the tunnel gets it back ever more slowly", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "error", message: "Failed to register agent: belongs to a different organization" }));
        ws.close(1011, "Failed to register agent");
      },
      message() {},
    },
  });
  try {
    expect(await reconnectAttempts(server.port, 3)).toEqual([1, 2, 3]);
  } finally {
    server.stop(true);
  }
}, 20_000);
