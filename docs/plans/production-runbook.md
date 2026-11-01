# Production Runbook: jrok Edges

**For:** [jrok scale-out plan](jrok-scale-out-plan.md); built and tested on staging first ([staging runbook](staging-runbook.md)).

**Status (2026-11-01):** three edges in DigitalOcean Singapore serve app traffic, all on `v2.6.5` (`f677e66`). The deploy workers have not been changed yet, so every agent is still on edge1 (see [Workers](#workers-still-to-do)).

---

## Edges

| | Address | Size | Server id | TCP ports | TCP name | Edge name (`forward_host`) |
|---|---|---|---|---|---|---|
| edge1 (the original server) | 152.42.241.139 | 1 vCPU / 1 GB | `vps-sgp1` | 10000–13333 | `sgp1.private.koompi.cloud` | `edge-sgp1.public.koompi.cloud` |
| edge2 `jrok-edge-sgp2` | 201.79.98.49 | 2 vCPU / 4 GB | `vps-sgp2` | 13334–16666 | `sgp2.private.koompi.cloud` | `edge-sgp2.public.koompi.cloud` |
| edge3 `jrok-edge-sgp3` | 159.65.8.153 | 2 vCPU / 4 GB | `vps-sgp3` | 16667–19999 | `sgp3.private.koompi.cloud` | `edge-sgp3.public.koompi.cloud` |

The two new droplets carry the DigitalOcean tag `jrok-production`.

- **Managed by Ansible:** `ansible/inventory.production.ini`, not committed because it names real servers. Every edge runs nginx, jrok, `jrok-dns-health`, certbot (the wildcard certificate is issued on each edge) and GeoIP, with UFW on.
- **Port 3000:** still open on edge1 (`jrok_port_public=true`) until we know whether kconsole's OpenResty (116.212.132.113, which serves `jrok.koompi.cloud`) reaches jrok there directly. The new edges accept port 3000 only from each other.
- **Database:** every edge uses production's MongoDB Atlas cluster.

## DNS (Cloudflare, `koompi.cloud`)

- **On every healthy edge:** `*.public.koompi.cloud` and `*.tunnel.koompi.cloud`. This is all app traffic, plus custom domains that CNAME to an app's name. `jrok-dns-health` on each edge keeps these two records pointing at healthy edges only (`dns_health_records`). `*.tunnel` used to be a CNAME to `tunnel.koompi.cloud`; it was changed in place to A records.
- **Edge1 only:**
  - `public.koompi.cloud` and `tunnel.koompi.cloud`, which agents may connect through;
  - `sgp1.private.koompi.cloud` (TCP).

  Agents of the old worker code don't know `tcp_port_elsewhere`, so the names they connect through must not change until the workers are updated.
- **One edge each:** `edge-sgp1/2/3.public.koompi.cloud` (used between edges) and `sgp2/3.private.koompi.cloud` (TCP).
- **`jrok-edges.koompi.cloud`:** every healthy edge, kept by `jrok-dns-health` like the app records. Deploy workers read their edge list from it (`JROK_EDGES_DNS`), so edges come and go without touching a worker. Nobody connects to this name.
- **Custom domains** pointed at 152.42.241.139 by an A record reach edge1 only. `scripts/custom-domain-dns-audit.ts` lists them.

## Deploy

```bash
scripts/deploy-production.sh                       # tag "app": rebuild and restart jrok, one edge at a time
scripts/deploy-production.sh nginx                 # nginx only (reload, nothing dropped)
JROK_LIMIT=edge2,edge3 scripts/deploy-production.sh all   # a full build of some edges
JROK_LIMIT=edge1 JROK_ANSIBLE_ARGS="--check --diff" JROK_LOG=<file> scripts/deploy-production.sh all   # preview, secrets redacted
```

- **What it deploys:** exactly `origin/v2.6.5`, which is what workers' `install.sh` installs too, so merge to `v2.6.5` first.
- **Secrets:** read from edge1 at run time (its `jrok.service`, certbot and GeoIP files) and never printed. `JROK_PEER_KEY` is in `~/.config/jrok-production/secrets.env` (mode 600).
- **Impact:**
  - Restarting jrok on edge1 cost 13–15 s of 502/503 for every app while all agents are on edge1. Edges 2 and 3 restart with no effect.
  - Once workers connect to every edge, a restart drops nothing (staging: 0 of 404).
  - The playbook stops if an edge's agents don't come back.
- **nginx refusing a reload:** if nginx refuses a reload, the deploy now fails. It used to carry on with the old config running (Fix-126).

## Rollback

- **One edge's code:** redeploy an earlier commit with `JROK_REF=<commit> JROK_LIMIT=edgeN scripts/deploy-production.sh`.
- **Everything, back to the single server as it was before 2026-11-01:**
  1. On all three edges: `systemctl stop jrok-dns-health`. Nothing writes DNS after this.
  2. In Cloudflare: delete the 201.79.98.49 and 159.65.8.153 A records from `*.public` and `*.tunnel.koompi.cloud`.
  3. On edge1: `/root/rollback-multi-edge.sh`. It restores `/root/pre-multi-edge-20261101-0017.tgz`: nginx, `jrok.service`, renewal hooks, GeoIP, `/opt/jrok`. It also turns UFW off and restarts jrok.
  4. Power off edges 2 and 3.

## Workers (still to do)

On each deploy-worker host (no access from here), one worker first, then the rest:

1. Run jrok's `install.sh` (branch `v2.6.5`): it installs the new CLI and builds `jrok-connector` in Docker.
2. Deploy the worker from kconsole `main`.
3. In the worker's env:
   - `JROK_SERVER=https://tunnel.koompi.cloud`. The edges have no certificate for `jrok.koompi.cloud`, so agents connecting to an edge by address with that name fail TLS.
   - `JROK_EDGES_DNS=jrok-edges.koompi.cloud`. The worker looks it up every 30 s: a new edge gets agents at once, and one missing for 3 minutes loses them. A failed lookup changes nothing. A fixed `JROK_EDGES=<ip>,<ip>` wins if set (for tests or an emergency).
   - `JROK_TCP_EDGE=152.42.241.139`: production's TCP ports are on edge1, and TCP tunnels must not follow DNS.
4. Restart the worker.
5. Check:
   - `agentCount` in `/cluster/stats` on any edge rises on edges 2 and 3;
   - the worker logs `tunnels run in one jrok connector`;
   - an app keeps answering through each edge (`curl --resolve`).
6. **Fallback:** `JROK_CONNECTOR=false` plus a restart gives one `jrok` process per tunnel. Removing `JROK_EDGES_DNS` (and `JROK_EDGES`) puts agents back on one edge.

## Adding, draining and removing edges

Workers follow `jrok-edges.koompi.cloud`, so none of this touches them.

**Add an edge:**
1. Create the droplet (2 vCPU / 4 GB, tag `jrok-production`).
2. Add its line to the inventory: next `vps_id`, an unused TCP range, `tcp_public_host` and `forward_host`.
3. Create its two A records: `edge-sgpN.public.koompi.cloud` and `sgpN.private.koompi.cloud`.
4. `JROK_LIMIT=edgeN scripts/deploy-production.sh all`.
5. `scripts/deploy-production.sh nginx,dns-health`: the other edges learn about it. This reloads nginx and restarts only the checkers, never jrok.
6. Result: the checkers add it to the app records and `jrok-edges` once it passes 3 checks, and workers start agents on it within about a minute.

**Drain an edge** (before maintenance or removal):
1. On the edge: `touch /etc/jrok/drain`.
2. The other checkers take it out of every record (about 30 s, plus up to 60 s of DNS caching).
3. Workers stop their agents there 3 minutes later. jrok on it keeps serving meanwhile.
4. `rm /etc/jrok/drain` puts it back. The last healthy edge is never taken out.

**Remove an edge:**
1. Drain it, and wait until `/cluster/stats` shows it with no agents (about 5 minutes).
2. Delete its inventory line, then `scripts/deploy-production.sh nginx,dns-health`.
3. Destroy the droplet and delete its two A records.

An edge that dies without warning leaves DNS in about 35 s, and workers stop using it 3 minutes later, while the other edges carry its traffic.

**After the workers:**
- resize edge1 (it needs a power-off; agents on the other edges cover it);
- close port 3000 on edge1 once OpenResty's upstream is known;
- then the two Cambodian edges (Phase 4).

## Checks

```bash
curl -s --resolve app.public.koompi.cloud:443:<edge-ip> https://app.public.koompi.cloud/   # one edge
ssh root@<edge> journalctl -u jrok-dns-health -f      # DNS decisions (the lease holder writes)
ssh root@<edge> journalctl -u jrok -f
```

On 2026-11-01:
- 16 live apps and custom domains answered the same through every edge;
- 360 of 360 requests through real DNS succeeded, spread evenly over the three edges.
