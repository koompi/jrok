/**
 * Staging test app: one endpoint per behaviour phase0-check.ts verifies.
 *
 *   bun scripts/staging/test-app.ts            # listens on 18081 (PORT to change)
 *   LABEL=app2 PORT=18082 bun scripts/staging/test-app.ts   # a second app
 *   jrok --port 18081 --domain app --group --instance-id staging-a --server https://<edge>
 *
 * See docs/plans/staging-runbook.md.
 */
import { gzipSync } from "zlib";

const json = JSON.stringify({
  items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, tags: ["a", "b", "c"] })),
});
const js = "/* bundle */\n" + Array.from({ length: 400 }, (_, i) => `export function f${i}(x){return x*${i}+1;}`).join("\n");
const jsGz = gzipSync(js);
const LABEL = process.env.LABEL || "app";

// Edge cache checks (phase05-check.sh): how each Cache-Control is treated.
// Every response says which app served it and how many times the app itself
// was asked, so a cached answer is visible as a count that didn't move.
const CACHE_CASES: Record<string, Record<string, string>> = {
  "/cache/public": { "cache-control": "public, max-age=60" },
  "/cache/smaxage": { "cache-control": "s-maxage=60" },
  "/cache/maxage": { "cache-control": "max-age=60" }, // browser-only: not shared
  "/cache/private": { "cache-control": "private, max-age=60" },
  "/cache/cookie": { "cache-control": "public, max-age=60", "set-cookie": "session=abc; Path=/; HttpOnly" },
  "/cache/none": {},
};
const hits: Record<string, number> = {};

Bun.serve({
  port: Number(process.env.PORT || 18081),
  // Bun closes connections quiet for 10 s by default, which would cut the
  // slow-response check off inside this app rather than testing the tunnel.
  idleTimeout: 255,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws-echo" && server.upgrade(req)) return;

    if (url.pathname in CACHE_CASES) {
      hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
      return new Response(`${LABEL} ${url.pathname} hit ${hits[url.pathname]}\n`, {
        headers: { "content-type": "text/plain", ...CACHE_CASES[url.pathname] },
      });
    }
    if (url.pathname === "/hits") {
      return Response.json(hits, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/data") {
      return new Response(json, { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/app.js") {
      return new Response(js, { headers: { "content-type": "application/javascript; charset=UTF-8" } });
    }
    // Compressed by the app itself, as Next.js does.
    if (url.pathname === "/app-gz.js") {
      return new Response(jsGz, {
        headers: { "content-type": "application/javascript; charset=UTF-8", "content-encoding": "gzip" },
      });
    }
    if (url.pathname === "/slow") {
      const ms = Number(url.searchParams.get("ms") || 1000);
      return new Promise((resolve) => setTimeout(() => resolve(new Response(`slept ${ms}ms\n`)), ms));
    }
    // Six events, half a second apart.
    if (url.pathname === "/sse") {
      let n = 0;
      const stream = new ReadableStream({
        start(controller) {
          const timer = setInterval(() => {
            controller.enqueue(new TextEncoder().encode(`data: event ${n} at ${Date.now()}\n\n`));
            if (++n === 6) {
              clearInterval(timer);
              controller.close();
            }
          }, 500);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    return new Response("ok\n");
  },
  websocket: {
    message(ws, message) {
      ws.send(`echo: ${message}`);
    },
  },
});

console.log(`staging test app on ${process.env.PORT || 18081}`);
