/**
 * Many agents from one machine, as a busy worker has (plan 3.5): N agent
 * connections to one edge in a single process, each a group replica of one
 * domain, sending heartbeats and reconnecting with the CLI's backoff.
 * A real agent is ~62 MB; these are a few KB each.
 *
 *   JROK_AUTH=<key> bun scripts/staging/agent-swarm.ts EDGE_IP COUNT SECONDS [DOMAIN]
 *
 * Prints, every second, how many are connected and how many attempts were
 * refused so far. Host and TLS name: jrok-staging.koompi.cloud.
 * GONE_ON_DROP=1: agents whose connection drops never come back (a worker
 * that can't reconnect), for testing the deploy's wait for agents.
 */
const [edge, countArg, secondsArg, domain = "swarm"] = process.argv.slice(2);
const key = process.env.JROK_AUTH;
if (!edge || !countArg || !secondsArg || !key) {
  console.error("usage: JROK_AUTH=<key> bun scripts/staging/agent-swarm.ts EDGE_IP COUNT SECONDS [DOMAIN]");
  process.exit(2);
}
const HOST = "jrok-staging.koompi.cloud";
const count = Number(countArg);
const until = Date.now() + Number(secondsArg) * 1000;

let connected = 0;
let refused = 0;
let attempts = 0;

// The CLI's reconnect delay (cli/src/index.ts, nextReconnectDelayMs).
const delay = (attempt: number) => {
  const capped = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
};

function agent(i: number, attempt = 0) {
  if (Date.now() > until) return;
  attempts++;
  const url = new URL(`wss://${edge}/ws/agent`);
  for (const [k, v] of Object.entries({
    domain, serviceType: "port", protocol: "http", caps: "stream,b64body",
    groupMode: "true", instanceId: `swarm-${i}`, localPort: "18081",
  })) url.searchParams.set(k, v);
  const ws = new WebSocket(url.toString(), {
    headers: { Host: HOST, Authorization: `Bearer ${key}` },
    tls: { rejectUnauthorized: false },
  } as any);
  let open = false;
  let beat: ReturnType<typeof setInterval> | undefined;
  ws.onopen = () => {
    open = true;
    connected++;
    attempt = 0;
    beat = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "heartbeat" })), 15_000);
  };
  ws.onmessage = () => {};
  ws.onclose = () => {
    clearInterval(beat);
    if (open) connected--;
    else refused++;
    if (open && process.env.GONE_ON_DROP === "1") return;
    setTimeout(() => agent(i, attempt + 1), delay(attempt + 1));
  };
}

const start = Date.now();
for (let i = 0; i < count; i++) agent(i);
const timer = setInterval(() => {
  console.log(`${((Date.now() - start) / 1000).toFixed(0)}s connected ${connected}/${count} refused ${refused} attempts ${attempts}`);
  if (Date.now() > until) {
    clearInterval(timer);
    process.exit(0);
  }
}, 1000);
