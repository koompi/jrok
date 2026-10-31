// Many tunnels in one jrok-connector (control mode), as a big worker runs them:
// COUNT replicas of one app (domain `cscale`), each on both edges. Prints how
// long they took to connect, memory and idle CPU, holds them HOLD seconds
// (requests, an edge deploy), then closes them all.
//
// On the test droplet: set -a; . /root/staging.env; set +a
//   systemd-run --unit conn-scale -p EnvironmentFile=/root/staging.env bun connector-scale.ts [COUNT] [HOLD]
// (systemd-run: a process started over SSH dies with the session.) Touches
// /root/scale-ready once the numbers are printed. Delete `cscale` afterwards.
import { readFileSync } from "fs";

const COUNT = Number(process.argv[2] || 150);
const HOLD_MS = Number(process.argv[3] || 90) * 1000;
const edges = ["159.223.71.81", "188.166.181.1"];
const proc = Bun.spawn(["/usr/local/bin/jrok-connector"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env });

let connected = 0;
(async () => {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      if (buf.slice(0, i).includes("Agent ID")) connected++;
      buf = buf.slice(i + 1);
    }
  }
})();
const send = (o: object) => { proc.stdin.write(JSON.stringify(o) + "\n"); proc.stdin.flush(); };
const cpuTicks = () => { const f = readFileSync(`/proc/${proc.pid}/stat`, "utf8").split(") ")[1].split(" "); return Number(f[11]) + Number(f[12]); };
const rssMb = () => Number(readFileSync(`/proc/${proc.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)![1]) / 1024;

const t0 = Date.now();
let n = 0;
for (let r = 0; r < COUNT; r++) {
  for (const e of edges) {
    send({ op: "open", id: `t${n++}`, args: ["--server", "https://jrok-staging.koompi.cloud", "--edge", e, "--port", "18081", "--domain", "cscale", "--group", "--instance-id", `cs-${r}`] });
  }
}
while (connected < n && Date.now() - t0 < 120_000) await Bun.sleep(250);
console.log(`${connected} of ${n} tunnels connected in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

await Bun.sleep(5000);
const c1 = cpuTicks();
await Bun.sleep(30_000);
const c2 = cpuTicks();
console.log(`connector RSS ${rssMb().toFixed(1)} MB for ${n} tunnels; idle CPU (heartbeats) ${((c2 - c1) / 100 / 30 * 100).toFixed(1)}% of one core`);
await Bun.write("/root/scale-ready", "1");

await Bun.sleep(HOLD_MS);
for (let i = 0; i < n; i++) send({ op: "close", id: `t${i}` });
await Bun.sleep(3000);
console.log(`after closing all: connector RSS ${rssMb().toFixed(1)} MB`);
proc.stdin.end();
await proc.exited;
process.exit(0);
