import { test, expect } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { join } from "path";

// =============================================================================
// What machines run is cli/dist/index.js (`npm run build` in cli/: esbuild,
// Node 18, CommonJS), not cli/src. Until 2026-11-10 the dist was a build from
// 2026-10-23: the WebSocket fixes made to src on 2026-10-31 and 11-01 never
// reached it. So every text message an app sent reached the browser as binary
// (ws 8 hands every message over as a Buffer), and a message the browser sent
// before the agent's own socket to the app was open was dropped. Next.js's hot
// reload ignores binary messages: KOOMPI Cloud's live previews never followed
// an edit (kconsole Fix-238). This runs the dist itself, under Node, between a
// stand-in jrok server and a stand-in app. After changing cli/src, rebuild.
// =============================================================================

const DIST = join(import.meta.dir, "..", "cli", "dist", "index.js");
const node = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;

test.skipIf(!node)("cli/dist forwards an app's text messages as text, its binary as binary, and the browser's first message sent before it reached the app", async () => {
  const toBrowser: Array<{ isBinary: boolean; data: string }> = [];
  const appGot: string[] = [];

  // The app: says hello in text and in binary as the socket opens (as Next.js's hot reload does).
  const app = Bun.serve({
    port: 0,
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { ws.send('{"type":"turbopack-connected"}'); ws.send(new Uint8Array([1, 2, 3])); },
      message(_ws, m) { appGot.push(typeof m === "string" ? m : "binary"); },
    },
  });
  // jrok: welcomes the agent, then a visitor's socket opens and sends at once (before the agent's socket to the app is open).
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "welcome", agentId: "test-agent" }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "ws_connect", wsId: "w1", path: "/_next/hmr", headers: {} }));
          ws.send(JSON.stringify({ type: "ws_message", wsId: "w1", data: '{"type":"turbopack-subscribe"}', isBinary: false }));
        }, 200);
      },
      message(_ws, m) {
        const msg = JSON.parse(String(m));
        if (msg.type !== "ws_message_response") return;
        toBrowser.push({ isBinary: msg.isBinary, data: msg.isBinary ? Buffer.from(msg.data, "base64").toString("hex") : msg.data });
      },
    },
  });

  const agent = spawn("node", [DIST, "--server", `http://127.0.0.1:${server.port}`, "--port", String(app.port), "--host", "127.0.0.1", "--domain", "live-0000000000"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", JROK_AUTH: "test" },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 100 && (toBrowser.length < 2 || appGot.length < 1); i++) await Bun.sleep(50);
    expect(toBrowser).toEqual([
      { isBinary: false, data: '{"type":"turbopack-connected"}' },
      { isBinary: true, data: "010203" },
    ]);
    expect(appGot).toEqual(['{"type":"turbopack-subscribe"}']);
  } finally {
    agent.kill("SIGKILL");
    server.stop(true);
    app.stop(true);
  }
}, 15_000);
