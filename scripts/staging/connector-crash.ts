// The connector is killed under the KConsole deploy worker's real JrokService:
// every tunnel it carried (an HTTP tunnel on both edges, a TCP tunnel) must
// come back on a new connector by itself, through JrokService's restart logic.
//
// On the test droplet, with the worker's source in WORKER_SRC (copy
// kconsole worker/deploy/src and its node_modules, never its .env) and the
// TCP echo on 18090 (`Bun.listen` echo, stg-tcp-echo):
//   systemd-run --unit conn-crash -p EnvironmentFile=/root/staging.env -p WorkingDirectory=/root/kconsole-deploy \
//     -E JROK_SERVER=https://jrok-staging.koompi.cloud -E JROK_EDGES=159.223.71.81,188.166.181.1 \
//     -E PATH=/usr/local/bin:/usr/bin:/bin bun connector-crash.ts
//   journalctl -u conn-crash -o cat | grep ^CHECK
const WORKER_SRC = process.env.WORKER_SRC || "/root/kconsole-deploy/src";
const { JrokService } = await import(`${WORKER_SRC}/services/JrokService`);
// No Docker here: the "container" is the test app on this droplet.
(JrokService as any).resolveTunnelContainer = async () => ({ containerId: "testbox-app-000000", ip: "127.0.0.1" });

const sh = (...cmd: string[]) => new TextDecoder().decode(Bun.spawnSync(cmd).stdout).trim();
const edges = ["159.223.71.81", "188.166.181.1"];
const host = "cn.jrok-staging.koompi.cloud";
const codes = () => edges.map((e) => sh("curl", "-s", "-o", "/dev/null", "--max-time", "5", "-w", "%{http_code}", "--resolve", `${host}:443:${e}`, `https://${host}/api/data`));
const connector = () => sh("pgrep", "-P", String(process.pid), "-x", "jrok-connector");

await JrokService.startTunnel({ serviceId: "svccn", instanceId: "svccn-0", domain: "cn", port: 18081, host: "127.0.0.1" });
await JrokService.startTcpTunnel({ serviceId: "svccn", instanceId: "svccn-0", port: 18090, host: "127.0.0.1" });
await Bun.sleep(8000);
const before = connector();
console.log(`CHECK before: connector pid ${before}, edges ${codes().join(" ")}, tracked ${JrokService.getStatus().length}`);

process.kill(Number(before), "SIGKILL");
const t0 = Date.now();
console.log(`CHECK killed connector ${before} (SIGKILL)`);
let back = 0;
for (let i = 0; i < 60; i++) {
  await Bun.sleep(1000);
  if (codes().every((x) => x === "200") && JrokService.getStatus().length === 3) { back = Date.now() - t0; break; }
}
console.log(`CHECK after: ${back ? `all back in ${(back / 1000).toFixed(1)} s` : "NOT back in 60 s"}; connector pid ${connector()} (was ${before}), edges ${codes().join(" ")}, tracked ${JrokService.getStatus().length}`);
const burst = Array.from({ length: 40 }, () => codes()).flat();
console.log(`CHECK ${burst.length} requests after recovery: ${burst.filter((x) => x === "200").length} x 200`);

await JrokService.stopTunnel("svccn", "svccn-0");
await Bun.sleep(3000);
console.log(`CHECK after stopTunnel: tracked ${JrokService.getStatus().length}, connector still running: ${connector() ? "yes (idle)" : "no"}`);
process.exit(0);
