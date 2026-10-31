/**
 * Phase 0 checks against a jrok edge, through nginx and TLS, as a visitor sees it.
 *
 *   bun scripts/staging/phase0-check.ts --app https://app.<base-domain> --api https://<base-domain> [--insecure]
 *
 * --app is the test app's tunnel (scripts/staging/test-app.ts), --api jrok's own
 * host. --insecure accepts self-signed certificates (local runs only). Takes
 * about 80 s: the slow-response and idle-WebSocket checks wait on purpose.
 * Exits 1 if any check fails. See docs/plans/staging-runbook.md.
 */

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const APP = arg("app");
const API = arg("api");
const INSECURE = args.includes("--insecure");
if (!APP || !API) {
  console.error("usage: bun scripts/staging/phase0-check.ts --app https://app.<base> --api https://<base> [--insecure]");
  process.exit(2);
}
if (INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const tls = INSECURE ? { tls: { rejectUnauthorized: false } } : {};

type Result = { check: string; ok: boolean; detail: string };
const results: Result[] = [];
const record = (check: string, ok: boolean, detail: string) => results.push({ check, ok, detail });

/** Visitors get JSON and JavaScript compressed, including what the app compressed itself. */
async function compression() {
  for (const path of ["/api/data", "/app.js", "/app-gz.js"]) {
    const res = await fetch(`${APP}${path}`, {
      headers: { "accept-encoding": "gzip" },
      decompress: false,
      ...tls,
    } as any);
    const bytes = (await res.arrayBuffer()).byteLength;
    const encoding = res.headers.get("content-encoding") ?? "none";
    record(`compressed ${path}`, encoding === "gzip", `HTTP ${res.status}, ${bytes} bytes, encoding ${encoding}`);
  }
}

/** A page load's worth of requests from one IP all succeed; jrok's own host stays rate limited. */
async function burst() {
  const count = async (url: string) => {
    const codes = await Promise.all(Array.from({ length: 60 }, () => fetch(url, tls as any).then((r) => r.status, () => 0)));
    return codes.reduce<Record<number, number>>((acc, c) => ((acc[c] = (acc[c] ?? 0) + 1), acc), {});
  };
  const app = await count(`${APP}/app.js`);
  record("60 requests at once to an app", app[200] === 60, JSON.stringify(app));
  await Bun.sleep(3000);
  const api = await count(`${API}/health`);
  record("jrok's own host still rate limited", (api[503] ?? 0) > 0, JSON.stringify(api));
}

/** Server-Sent Events reach an HTTP/1.1 client (Bun's fetch) live, not at the end. */
async function sse() {
  const start = performance.now();
  const times: number[] = [];
  const res = await fetch(`${APP}/sse`, tls as any);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    let i;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      buffer = buffer.slice(i + 2);
      times.push((performance.now() - start) / 1000);
    }
  }
  record("events stream live (HTTP/1.1)", times.length === 6 && times[0]! < 1.5,
    times.map((t) => `${t.toFixed(1)}s`).join(" "));
}

/** A response that takes 70 s (past the old 30 s and 60 s limits) still arrives. */
async function slow() {
  const start = performance.now();
  const res = await fetch(`${APP}/slow?ms=70000`, tls as any);
  const body = (await res.text()).trim();
  record("70 s response", res.status === 200,
    `HTTP ${res.status} after ${((performance.now() - start) / 1000).toFixed(0)}s: ${body.slice(0, 40)}`);
}

/** A message sent the moment the socket opens is delivered, and the socket survives 75 s of silence. */
function websocket(): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const ws = new WebSocket(`${APP.replace(/^http/, "ws")}/ws-echo`, tls as any);
    const got: string[] = [];
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      record("WebSocket: send on open, then 75 s idle", ok, detail);
      resolve();
    };
    ws.onopen = () => {
      ws.send("on open");
      setTimeout(() => {
        try {
          ws.send("after 75 s idle");
        } catch {
          // Closed already; onclose reports it.
        }
      }, 75000);
    };
    ws.onmessage = (m) => {
      // Text the app sent must arrive as text: a browser hands binary over as
      // a Blob, and JSON.parse(event.data) fails.
      got.push(typeof m.data === "string" ? m.data : `(binary) ${Buffer.from(m.data as ArrayBuffer).toString()}`);
      if (got.length === 2) {
        // Record first: close() can fire onclose synchronously.
        finish(!got.some((g) => g.startsWith("(binary)")), got.join(" | "));
        ws.close();
      }
    };
    ws.onclose = () => finish(false, `closed after ${((performance.now() - start) / 1000).toFixed(0)}s, got: ${got.join(" | ") || "nothing"}`);
    setTimeout(() => finish(false, `no reply within 90 s, got: ${got.join(" | ") || "nothing"}`), 90000);
  });
}

// A check that throws (a broken body, say) is a failure, not the end of the run.
const guard = (name: string, check: () => Promise<void>) =>
  check().catch((error) => record(name, false, `threw: ${error?.message ?? error}`));

await guard("compression", compression);
await guard("60 requests at once", burst);
await guard("events stream", sse);
await Promise.all([guard("70 s response", slow), guard("WebSocket", websocket)]);

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check.padEnd(42)} ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
