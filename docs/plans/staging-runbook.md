# Staging Runbook: Phase 0 and Multi-Edge Tests

**For:** [jrok scale-out plan](jrok-scale-out-plan.md), Phase 0 and Phase 2.1
**Branch:** `feat/phase0-edge-fixes` (jrok repo)
**Goal:** prove the Phase 0 changes on real servers with real TLS before production, and record how today's code behaves with several edges (the baseline Phase 1 must improve on).

**Status:** built 2026-10-31 and **kept running** for the later phases (2 edges + 1 test droplet, DigitalOcean tag `jrok-staging`). Results are in the plan, section 2. Section 0 covers day-to-day use; sections 1–7 cover building it from scratch.

---

## 0. Working with the running staging

- **Hosts** are in `ansible/inventory.staging.ini` (not in git). The test droplet runs MongoDB (Docker `mongo`, private network, only the edges allowed by `mongo-firewall.service`), the test app (`stg-app.service`) and the same group-mode replica for `app` connected to each edge, as a worker will run it (`stg-agent@<edge-ip>.service`, with `--edge`; secrets in `/root/staging.env`). All of it comes back after a reboot.
- **Deploy a branch to the edges:** `scripts/staging/deploy-edges.sh [tags]` (default `app`: rebuild and restart jrok; `nginx` for the nginx config). It copies the working tree to each edge and runs the playbook with the secrets from `~/.config/jrok-staging/secrets.env`. Done by hand, export the section 3 variables with the same values as before, or the playbook rewrites `jrok.service` with empty ones.
- **Update the agent:** rsync the repo to `/root/jrok/` on the test droplet (excluding `cli/dist`), run `npm install` in `/root/jrok/cli` (it builds `dist/index.js`, as workers do), then `systemctl restart stg-agent`.
- **Logs:** `journalctl -u jrok -f` on an edge; `journalctl -u stg-agent -f` on the test droplet.
- **Edge cache:** `scripts/staging/phase05-check.sh EDGE_IP` (needs the second test app, `stg-app2` + `stg-agent2@<edge-ip>`, for the collision check).
- **Edges reaching each other over HTTPS (plan step 1.5):** `scripts/staging/peer-tls-check.sh` (15 checks, about 1 minute; restores the agent, jrok and the allowlist when done). For the Phase 0 checks with every request crossing edges, stop `stg-agent@<edge1-ip>` and pin the test droplet to edge1 before running `phase0-check.ts`.
- **Health-checked DNS (plan 3.1):** `jrok-dns-health.service` on each edge keeps `jrok-staging.koompi.cloud` and `*.jrok-staging.koompi.cloud` pointing at healthy edges only (`dns_health_records` in the inventory; logs: `journalctl -u jrok-dns-health`). It re-creates a missing record for a healthy edge. Drill: run `scripts/staging/dns-probe.sh SECONDS URL` on the test droplet (real DNS, no pinning) and power an edge off and on with the DigitalOcean API (`POST /v2/droplets/<id>/actions`, `power_off` / `power_on`).
- **Custom-domain certificates (plan 2.3):** `jrok-cd-test.koompi.cloud` and `jrok-cd-test2.koompi.cloud` are CNAMEs to the staging app, registered in staging jrok. Certificates there come from Let's Encrypt's staging service (`certbot_test_cert=true` in the inventory), so browsers don't trust them; check with `openssl s_client -connect <edge-ip>:443 -servername <domain>`. Force a renewal on the edge that issued one with `certbot renew --force-renewal --cert-name <domain>`. For the app itself, run an agent with `--domain <domain>` (kconsole runs one per custom domain).
- **Many agents from one machine (plan 3.5):** on the test droplet, `set -a; . /root/staging.env; set +a; bun /root/jrok/scripts/staging/agent-swarm.ts EDGE_IP COUNT SECONDS [DOMAIN]` (`GONE_ON_DROP=1`: agents that never reconnect). Stop it with `pkill -f "[a]gent-swarm.ts"` (the brackets keep pkill from matching its own shell). Test domains are named `swarm*`; delete their records afterwards. A deploy with a shorter agent wait: `JROK_ANSIBLE_ARGS="-e jrok_agent_wait_seconds=40" scripts/staging/deploy-edges.sh app`.
- **Rust connector (plan Phase 5):**
  - **Running:** `app` is served through it: `stg-conn@<edge-ip>.service` runs `jrok-connector run … --edge %i --domain app --group --instance-id stg-a`, with `Restart=always`. `stg-agent@` is the Node agent for the same replica; run one of the two, not both. `app2` stays on Node agents (`stg-agent2@`) for comparison.
  - **Update:** build with `docker run --rm -v "$PWD":/src -w /src -e CARGO_TARGET_DIR=/src/target-bullseye rust:1.93-bullseye cargo build --release` in `connector/`, copy `target-bullseye/release/jrok-connector` to `/usr/local/bin/` on the test droplet, then restart `stg-conn@*`.
  - **Checks:**
    - `phase0-check.ts` and `phase05-check.sh` as usual;
    - `AGENT_UNIT=stg-conn scripts/staging/peer-tls-check.sh`;
    - `connector-scale.ts COUNT HOLD` (many tunnels in one process; delete the `cscale` records afterwards);
    - `connector-crash.ts` (kills the connector under the worker's real `JrokService`; needs the worker source in `/root/kconsole-deploy` and the TCP echo `stg-tcp-echo`);
    - `cpu-per-request.sh` (connector against Node agents).
  - **WebSocket subprotocols (P32):** start `ws-protocol-app.cjs`; give it an agent each (connector and Node CLI) for 18083 (requires a protocol) and 18084 (ignores them); run `ws-protocol-client.cjs DOMAIN EDGE PROTOCOLS` through each edge with `graphql-transport-ws`, `graphql-transport-ws,graphql-ws` and `-`.
  - **Edges from DNS (workers' `JROK_EDGES_DNS`):** `jrok-edges.jrok-staging.koompi.cloud` lists the healthy edges. To drain an edge, `touch /etc/jrok/drain` on it; `rm` brings it back. On the test droplet, `/root/edge-discovery-check.ts` runs the worker's real `JrokService` with `JROK_EDGES_DNS` and logs every 5 s which edges it uses, its agents per edge, and the app through each edge.
    - Short timings for tests: `JROK_EDGES_DNS_INTERVAL_S=10`, `JROK_EDGES_DNS_REMOVE_AFTER_S=40`.
    - 2026-11-01 results:
      - drain: out of DNS after about 95 s, agent stopped 40 s later;
      - undrain: back after 71 s;
      - jrok stopped on edge2 for 75 s: kept in DNS (its nginx served through edge1), 68 of 68 requests OK.
  - **Flood protection (plan 3.6):** staging sets `flood_block_seconds=120` and `app_max_waiting=200` (inventory) so tests finish quickly.
    - Flood: `autocannon -c 50 -d 20` from the test droplet; it gets blocked, on both edges.
    - App cap: 400 parallel requests to `/slow?ms=8000`, from one Bun process (400 curl processes overload the droplet).
    - Connections: 1,200 WebSockets to `/ws-echo` (`/root/connflood.ts`, the app pinned to edge1 in `/etc/hosts`).
    - Slow clients: half-sent headers (`slowloris.py`).
    - The test droplet is also where the agents run; a block never affects agents.
  - **IP rules (P33):** use a new domain each time, so the tunnel record doesn't exist yet. Pass `--allow-ip <test droplet>` and check from elsewhere: 403, or a reset for `--tcp`.
  - **Start test processes with `systemd-run`:** anything started in the background over SSH dies when the session closes. Transient units disappear when stopped, so `stg-cd-<edge>` (the custom-domain agents) must be started again with `systemd-run` and the same command line.
- **Server key (plan 3.4):** staging accepts it only from the edges and the operator's address in `server_key_sources` (inventory); from anywhere else jrok answers 401 and logs it. Update the address if yours changes.
- **GeoIP and alerts:** `deploy-edges.sh geoip` reads production's MaxMind account (`/etc/GeoIP.conf` there) for the `geoip` role. Alerts go to Telegram once `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are in the staging env file; until then they only log.
- **Measure:** `scripts/staging/edge-sample.sh SECONDS` on an edge (CPU split into jrok and nginx, plus connection states on port 3000); `box-sample.sh` on the test droplet (agent, app, autocannon); `probe.sh SECONDS URL EDGE_IP…` for availability through each edge during a failure test.
- **Pinning:** the agent uses real DNS (either edge). To aim a test at one edge, use `curl --resolve`, or `/etc/hosts` on the test droplet, and remove the pin afterwards: the agent reconnects through whatever `/etc/hosts` says.

---

## 1. What you need

| Item | Notes |
|---|---|
| 2–3 edge droplets | Ubuntu 22.04 (same as production), 2 vCPU / 2–4 GB, region SGP1. |
| 1 test droplet | Runs the test app, the jrok agent and the load tests. Ubuntu, 2 vCPU. |
| **A MongoDB of its own** | A separate Atlas cluster (the free tier is enough) or `mongo:7` in Docker on the test droplet. **Never the production cluster:** jrok always uses the database named `jrok` whatever the URI says, so staging edges on the production cluster would join production. |
| A test domain on Cloudflare | Examples below use `jrok-staging.koompi.cloud`, so apps live at `<name>.jrok-staging.koompi.cloud`. The certbot role needs a Cloudflare API token that can edit that zone's DNS. A token for `koompi.cloud` can also change production records, so prefer a separate zone for staging, or limit the token to *Zone → DNS → Edit* on that one zone and delete it afterwards. |
| Ansible | Nothing to install: `uvx --from ansible ansible-playbook …` works. |

---

## 2. DNS (Cloudflare, DNS only, TTL 60)

| Name | Points to |
|---|---|
| `jrok-staging.koompi.cloud` | One A record per edge (round robin) |
| `*.jrok-staging.koompi.cloud` | One A record per edge (round robin) |
| `stg-edge1.jrok-staging.koompi.cloud`, `stg-edge2.…` | That edge alone: its `forward_host`, where the other edges forward to (plan step 1.5) |

(`staging.koompi.cloud` is already taken by another server. `koompi.cloud` has a `*.koompi.cloud` wildcard; these explicit records take precedence over it for the staging names only.)

To aim a test at one edge, pin the names on the test droplet in `/etc/hosts`:

```
<edge1-ip>  jrok-staging.koompi.cloud app.jrok-staging.koompi.cloud
```

---

## 3. Inventory and secrets

Create `ansible/inventory.staging.ini` and keep it out of git (it names your servers):

```ini
[jrok_servers]
edge1 ansible_host=<edge1-ip> ansible_user=root vps_id=edge1 vps_region=sgp1 tcp_port_min=10000 tcp_port_max=13333 tcp_public_host=<edge1-ip> forward_host=stg-edge1.jrok-staging.koompi.cloud
edge2 ansible_host=<edge2-ip> ansible_user=root vps_id=edge2 vps_region=sgp1 tcp_port_min=13334 tcp_port_max=16666 tcp_public_host=<edge2-ip> forward_host=stg-edge2.jrok-staging.koompi.cloud

[jrok_servers:vars]
domain_name=jrok-staging.koompi.cloud
app_dir=/opt/jrok
ansible_become=yes
```

The playbook reads its secrets from the environment:

```bash
export CERTBOT_EMAIL=you@koompi.com                  # optional: unset registers without one, like production
export CLOUDFLARE_TOKEN=...                          # DNS edit on the staging zone
export MONGODB_URI='mongodb+srv://…/'                # the STAGING MongoDB
export CERT_SYNC_API_KEY=$(openssl rand -hex 32)     # same value for every edge
export JWT_SECRET=$(openssl rand -hex 32)            # at least 32 characters
export JROK_PEER_KEY=$(openssl rand -hex 32)         # same for every edge; needed once every edge has a forward_host
# jrok refuses to start in production mode without these; tunnel tests don't log in, so placeholders are fine.
export KOOMPI_CLIENT_ID=staging KOOMPI_CLIENT_SECRET=staging
export KOOMPI_REDIRECT_URI=https://jrok-staging.koompi.cloud/auth/callback DASHBOARD_URL=https://jrok-staging.koompi.cloud
```

Write down `CERT_SYNC_API_KEY`. It is also the server's admin key, and section 7 uses it.

---

## 4. Deploy the edges

```bash
# From the jrok repo on feat/phase0-edge-fixes: copy the code to each edge.
for ip in <edge1-ip> <edge2-ip>; do
  rsync -az --delete --exclude node_modules --exclude .git --exclude .env ./ root@$ip:/root/jrok-staging/
done

cd ansible
uvx --from ansible ansible-playbook -i inventory.staging.ini playbook.yml
```

Check every edge answers. Expect `{"success":true,…}`:

```bash
for ip in <edge1-ip> <edge2-ip>; do curl -s --resolve jrok-staging.koompi.cloud:443:$ip https://jrok-staging.koompi.cloud/health; echo; done
```

---

## 5. Test app and agent (on the test droplet)

1. Install Bun and Node 18+, then copy the jrok repo over.
2. Create an API key in the **staging** MongoDB (normally made through the dashboard, which needs a login):

   ```bash
   RAW=jrok_$(openssl rand -hex 24)
   HASH=$(printf %s "$RAW" | sha256sum | cut -d' ' -f1)
   mongosh "$MONGODB_URI" --eval "db.getSiblingDB('jrok').apiKeys.insertOne({id:'staging-key', key:'$HASH', name:'staging', organizationId:'staging-org', permissions:['*'], isActive:true, createdAt:Date.now()})"
   echo "$RAW"   # the agent's key
   ```

3. Start the test app and an agent built from this branch, the way the deploy workers run it:

   ```bash
   bun scripts/staging/test-app.ts &
   bun build cli/src/index.ts --target node --outfile /opt/jrok-cli.js
   JROK_AUTH=$RAW node /opt/jrok-cli.js --server https://jrok-staging.koompi.cloud \
     --port 18081 --domain app --group --instance-id staging-a
   ```

   The agent connects to whichever edge DNS gives it. The edge's log (`journalctl -u jrok`) shows the connection.

---

## 6. Phase 0 checks

Run once per edge, pinning that edge in `/etc/hosts` (section 2). Every line must say PASS:

```bash
bun scripts/staging/phase0-check.ts --app https://app.jrok-staging.koompi.cloud --api https://jrok-staging.koompi.cloud
```

| Check | Today's production | Expected now |
|---|---|---|
| JSON, JavaScript and app-gzipped JavaScript arrive compressed | Uncompressed, even when the app compresses (the agent unpacks it) | `encoding gzip` |
| 60 requests at once from one IP to an app | 21 succeed, 39 get 503 | All 60 succeed |
| jrok's own host is still rate limited | Limited | Some 503s (protection kept) |
| Event stream to an HTTP/1.1 client | Arrives all at once when it ends | Live, 0.5 s apart |
| 70-second response | 504 (jrok gives up at 30 s, nginx at 60 s) | 200 |
| WebSocket: message sent on open, then 75 s idle | First message can be lost; idle socket closed at 60 s | Both echoed |

**Connection reuse (on an edge, during a load run):**

```bash
# on the test droplet
autocannon -c 50 -d 30 https://app.jrok-staging.koompi.cloud/
# on the edge, while it runs
ss -tan '( sport = :3000 or dport = :3000 )' | awk 'NR>1{print $1}' | sort | uniq -c
```

Expect a few hundred `ESTAB` and almost no `TIME-WAIT`. Production today opens and closes one connection per request.

**Capacity with TLS:** run `autocannon -c 100 -d 60` against `/app.js` and `/api/data`, and record requests/s alongside the edge's CPU (`top`: nginx and bun). Compare with the local numbers in the plan, which had no TLS.

---

## 7. Multi-edge baseline (today's code)

These record how the current code behaves with several edges. Expect some to fail: that is the evidence for Phase 1. Note the results in the plan.

Run `probe.sh` on the test droplet during tests 3 and 4: `bash probe.sh 150 https://app.jrok-staging.koompi.cloud/api/data <edge1-ip> <edge2-ip>`.

| # | Do | Result on 2026-10-31 (today's code) |
|---|---|---|
| 1 | Request the app through the edge **without** the agent (`curl --resolve`), and run `phase0-check.ts` through it | Works, forwarded over plain HTTP; 8 of 8 checks pass |
| 2 | Set an allowlist through the edge without the agent. The API takes the tunnel's **id**, not its name: get it with `docker exec mongo mongosh … --eval "db.getSiblingDB('jrok').tunnels.findOne({domain:'app',active:true}).id"`, then `curl -X POST https://jrok-staging.koompi.cloud/security/ip/<id> -H "Authorization: Bearer $CERT_SYNC_API_KEY" -H 'Content-Type: application/json' -d '{"mode":"allowlist","allowedIps":["203.0.113.1"]}'`. Request the app through both edges, then set `{"mode":"allow-all"}` through both. | Served through both edges: the rule reached only the edge that took the call, and that edge forwards without checking it (P4) |
| 3 | `systemctl stop jrok` on the edge holding the agent | Agent on the other edge in 0.6 s; through it, down under 1 s. Through the stopped edge, 502 until jrok is back (P15). Start it again afterwards. |
| 4 | On the edge holding the agent, block MongoDB: `iptables -I OUTPUT -p tcp -d <testbox-private-ip> --dport 27017 -j DROP` | App down through **both** edges within about 5 s, for as long as the block lasts; back as soon as it is removed (P8) |

Always undo step 4's firewall rule (`iptables -D` with the same arguments) when you're done.

---

## 8. Promoting to production (after staging passes)

1. **Back up first,** on the production edge: `tar czf /root/nginx-before-phase0.tgz /etc/nginx` and keep the current `dist/index.js` (see the jrok deploy notes).
2. **Deploy the jrok server** the usual way. On startup it upgrades the custom-domain vhosts that are still exactly what jrok generated (66 of today's 73) and reloads nginx. If `nginx -t` rejects the result, it puts every file back and doesn't reload. It only visits domains whose certificate is in MongoDB, so a domain whose certificate isn't there keeps its old vhost.
3. **Check the upgrade.** `grep -L 'jrok-vhost-template: 2' /etc/nginx/sites-enabled/*.conf` lists the vhosts not upgraded. Expect the 7 hand-edited ISI vhosts (`isiec`, `isigroup`, `isiland`, `isibds`, with and without `www`), plus any domain whose certificate isn't in MongoDB.
4. **Apply `nginx.conf`** with the nginx role and production's values (`base_domains=public.koompi.cloud,tunnel.koompi.cloud`, `ssl_cert_name=tunnel.koompi.cloud`), e.g. `--tags nginx --limit <prod host>`. The role validates the file before installing it and reloads nginx only when it changed.
5. **Update the CLI on workers.** Merge into `v2.6.5`, rebuild `cli/dist`, and reinstall on each worker. Until a worker is updated, its agents keep the old 30 s limit and the old WebSocket bugs. Nothing breaks: the shorter timeout wins.
6. **Run `phase0-check.ts`** against a test app deployed on production.

**Rollback:** restore `/root/nginx-before-phase0.tgz`, put back the previous `dist/index.js`, run `systemctl restart jrok`, then `nginx -t && systemctl reload nginx`.

---

## 9. Clean up

**Not yet:** staging stays up while the plan's phases are built and tested on it.

When it is no longer needed: destroy the droplets tagged `jrok-staging` (DigitalOcean bills by the hour) **first**: while the edges run, their health-checked DNS service re-creates deleted records. Then delete every A record named `jrok-staging.koompi.cloud`, `*.jrok-staging.koompi.cloud`, `stg-edge1.jrok-staging.koompi.cloud` or `stg-edge2.jrok-staging.koompi.cloud`, and the CNAMEs `jrok-cd-test.koompi.cloud` and `jrok-cd-test2.koompi.cloud` (eight while both edges are healthy; their comments vary, as the DNS service re-creates records as "jrok dns-health"), and revoke the DigitalOcean API token used to build it. The MongoDB goes with the test droplet. The edges hold a copy of production's Cloudflare token (`/etc/letsencrypt/secrets/cloudflare.ini`), which also goes with them.
