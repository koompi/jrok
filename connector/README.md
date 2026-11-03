# jrok-connector

One process per KOOMPI Cloud deploy-worker host carrying every jrok tunnel on it ([scale-out plan](../docs/plans/jrok-scale-out-plan.md), Phase 5). Without it, the worker runs one `jrok` CLI process per tunnel per edge, each a Node process of about 62 MB. In the connector, a tunnel is a connection: 300 tunnels took 24 MB.

Each tunnel speaks the same agent protocol as the CLI (binary frames, compression, streaming, WebSocket, TCP, `@jrok:req` events), so jrok servers need no change and the two can run side by side.

## Modes

- `jrok-connector`: control mode, for the deploy worker. Commands come in on stdin as JSON lines: `{"op":"open","id":"t1","args":[…jrok CLI arguments…]}` and `{"op":"close","id":"t1"}`. Output goes to stdout as `{"id","out"}`, `{"id","err"}` and `{"id","exit"}` lines; each `out` is what the CLI would have printed for that tunnel. The connector stops every tunnel and exits when stdin closes, so it never outlives the worker.
- Health, in control mode: `{"op":"ping","id":…}` is answered `{"pong":…,"tunnels":N}` from the loop that opens tunnels, so no pong means a wedged connector; and every 30 s it prints `{"stats":{"tunnels","connected","reconnecting","queuedBytes","rssKb","openFds"}}`. Neither line has a tunnel `id`, so workers that don't use them ignore them.
- `jrok-connector run <jrok CLI arguments>`: one tunnel, like `jrok`. For testing (the staging `stg-conn@<edge>` units).
- `jrok-connector --version`.

Supported arguments: `--server`, `--edge`, `--port`, `--host`, `--domain`, `--tcp`, `--group`, `--instance-id`, `--org`, `--force-new`, `--auth`, `--restrict`, `--allow-ip` and `--block-ip`. These are all the arguments the worker passes. The key can also come from `JROK_AUTH` or `JROK_API_KEY`.

## Install

`install.sh` at the repo root builds it after the CLI: with `cargo` if present, otherwise in Docker (`rust:1.93-slim-bullseye`, a few minutes the first time). It installs the binary next to `jrok`, but only if it runs on that machine (`jrok-connector --version`; a wrong architecture or an older glibc doesn't). Otherwise it says why and leaves the connector out, and removes an installed one that doesn't run either, so workers use a `jrok` process per tunnel. With `JROK_CONNECTOR=skip`, it leaves the connector out.

To build by hand, run `cargo build --release --locked`. The binary is `target/release/jrok-connector`. A build in the bullseye image needs glibc 2.30, so it runs on Ubuntu 20.04 and later.

## In the deploy worker

`worker/deploy/src/lib/jrokConnector.ts` (the KOOMPI Cloud deploy worker) uses the connector when it finds it: at `JROK_CONNECTOR_BIN`, else as `jrok-connector` on PATH. With `JROK_CONNECTOR=false`, the worker goes back to one `jrok` process per tunnel; that change only needs a worker restart.

If the connector dies, every tunnel it carried reports an exit, and the worker's restart logic opens them again on a new connector. That took 9.7 s on staging.

## Tests

- **Unit tests:** `cargo test`.
- **Staging** (see [runbook](../docs/plans/staging-runbook.md), section 0):
  - `phase0-check.ts` and `phase05-check.sh` through the `stg-conn` agents;
  - `peer-tls-check.sh` with `AGENT_UNIT=stg-conn`;
  - `connector-scale.ts` (many tunnels);
  - `connector-crash.ts` (kill it under the worker);
  - `cpu-per-request.sh` (against the Node agent).
