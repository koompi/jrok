# Production Runbook: jrok Edges

**For:** [jrok scale-out plan](jrok-scale-out-plan.md); built and tested on staging first ([staging runbook](staging-runbook.md); staging was destroyed on 2026-11-01 and is rebuilt from that runbook when needed).

**Status (2026-11-01):** three edges in DigitalOcean Singapore serve app traffic, all on `v2.6.5`.
- **Updated workers:** the deploy workers vps4 and selendra-03 follow `jrok-edges.koompi.cloud` with the connector, so their apps have an agent on every edge (failover tested, below).
- **Not yet updated:** `riverbase-worker-contabo` and `deploy-worker-01`.

---

## Edges

| | Address | Size | Server id | TCP ports | TCP name | Edge name (`forward_host`) |
|---|---|---|---|---|---|---|
| edge1 (the original server) | 152.42.241.139 | 1 vCPU / 1 GB, 4 GB swap | `vps-sgp1` | 10000–13333 | `sgp1.private.koompi.cloud` | `edge-sgp1.public.koompi.cloud` |
| edge2 `jrok-edge-sgp2` | 206.189.33.115 | 1 vCPU / 1 GB, 2 GB swap | `vps-sgp2` | 13334–16666 | `sgp2.private.koompi.cloud` | `edge-sgp2.public.koompi.cloud` |
| edge3 `jrok-edge-sgp3` | 168.144.96.128 | 1 vCPU / 1 GB, 2 GB swap | `vps-sgp3` | 16667–19999 | `sgp3.private.koompi.cloud` | `edge-sgp3.public.koompi.cloud` |

All three are the $6 size (edges 2 and 3 were replaced on 2026-11-01: DigitalOcean can't shrink a disk). One such edge does about 500 requests/s; production's peak is about 10. To grow, add edges or rebuild one bigger. The playbook gives edges with under 3 GB of RAM a 2 GB swap file.

The two new droplets carry the DigitalOcean tag `jrok-production`.

- **Managed by Ansible:** `ansible/inventory.production.ini`, not committed because it names real servers. Every edge runs nginx, jrok, `jrok-dns-health`, certbot and GeoIP, with UFW on.
- **Port 3000:** closed to the internet on every edge since 2026-11-01. Edges reach each other over HTTPS (`forward_host`).
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

## Certificates

The wildcard certificate (`tunnel.koompi.cloud`: `public.` and `tunnel.koompi.cloud`, and `*.` of each) is renewed by one edge only. Let's Encrypt issues at most 5 certificates a week for the same names, so an edge each would run out when several edges are built or replaced in one week.

- **The renewing edge:** `cert_renewer` in the inventory, default the first edge (edge1). It renews 30 days before expiry. Its deploy hook uploads each renewal to MongoDB (`/var/log/certbot-sync.log`), and every other edge's jrok pulls it within 15 s and reloads nginx (staging: 9 s).
- **The other edges:** a new edge takes a copy of the renewing edge's certificate when it is built, never one of its own. Edges 2 and 3 still have the copies they issued on 2026-11-01; they renew those only 10 days before expiry (`renew_before_expiry` in `/etc/letsencrypt/renewal/tunnel.koompi.cloud.conf`). That never happens while the renewing edge works, and keeps the certificate valid if it doesn't.
- **Retiring the renewing edge:** set `cert_renewer` to another edge, run `scripts/deploy-production.sh certbot`, then remove it. Only an edge with its own renewal settings (edges 1–3 today) can renew; otherwise issue one there first with certbot.
- **Private keys in MongoDB** are encrypted with `JROK_CERT_KEY` (AES-256-GCM) once it is in `~/.config/jrok-production/secrets.env`: `openssl rand -hex 32`, the same for every edge, kept safe and never changed. Each edge encrypts the older records when it starts. An edge without the key can't read new certificates (it keeps the ones it has and logs `can't be read on this server`), so the playbook refuses a deploy that would drop or change an edge's key. Add it only after every edge runs this code.

## The server key

The server key (`API_KEY`) works only from the edges themselves and from `server_key_sources` (inventory, comma-separated). Elsewhere it is refused and the edge logs `🚫 Server key presented from <ip>`. Operators use it on an edge: `ssh root@<edge>`, then `curl -H "X-Admin-Key: <key>" http://127.0.0.1:3000/…`. kconsole must call with a `jrok_` key (its `JROK_API_KEY`); if that is the server key, put kconsole's outgoing addresses in `server_key_sources`, or better, give it a `jrok_` key of KOOMPI Cloud's organization.

## Deploy

```bash
scripts/deploy-production.sh                       # tag "app": rebuild and restart jrok, one edge at a time
scripts/deploy-production.sh nginx                 # nginx only (reload, nothing dropped)
scripts/deploy-production.sh dns-health            # the DNS checkers' code and settings; jrok keeps running
scripts/deploy-production.sh certbot               # certificate settings and hooks; nothing restarts
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
1. Create the droplet (1 vCPU / 1 GB is enough today; tag `jrok-production`).
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

**Replace an edge** (new machine, same `vps_id`):
1. Drain the old edge and wait until it is out of every record.
2. Stop jrok, the DNS checker and nginx on the old edge.
3. Change its address in the inventory and the two A records.
4. Update the other edges first: `scripts/deploy-production.sh nginx,dns-health`.
5. Then build the new edge. It copies the certificate from the renewing edge (see Certificates); if it replaces the renewing edge, move `cert_renewer` first.

On 2026-11-01 the new edges were built first, and edge1's checker, still listing the old addresses, added them back to DNS for about 6 minutes (P38). Two rules have prevented that since:
- **Votes name the address probed.** A checker counts only votes about the address it knows for an edge, so one with older settings can't use a vote about the new machine to put the old address back.
- **Leftovers are removed.** An address the checkers added (Cloudflare comment `jrok dns-health`) that no edge has and no checker probes is removed after 5 minutes (`DNS_HEALTH_LEFTOVER_AFTER_S`, logged first). Records made by hand are never touched.

**After the workers:**
- reboot edge1 for its kernel update (agents on the other edges cover it);
- then the two Cambodian edges (Phase 4).

## Floods

- **Settings:** see jrok's [scale-out plan](jrok-scale-out-plan.md), 3.6. `flood_exempt` in the inventory lists the deploy workers (116.212.132.113, 202.124.44.232): apps calling other apps through their public URLs must never be blocked. Add any new worker or monitor there and run `scripts/deploy-production.sh` (tag `app`).
- **What is refused:** an address (an IPv6 /64 counts as one) sending one app more than 3,000 requests in 10 s gets 429 from that app for the rest of those 10 s (`🚦 … the rest of this window refused`). Doing it again within the hour blocks it from that app on every edge: 10 minutes, doubling each time, at most an hour. Its other apps are never refused. An address asking one edge for more than 500 different names in 10 s (names at random, each a MongoDB lookup) is refused every app on that edge for 10 minutes.
- **A block happening:** an edge logs `🛑 Flood blocked: <ip> …` (`journalctl -u jrok | grep "Flood blocked"`). With `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set on the edges, a person gets the same message; not configured yet.
- **List or lift blocks** with the server key, on any edge itself (see "The server key"; the change reaches the others within 10 s):
  - list: `GET /security/blocked-ips`: `blockedIps` (by hand, every app) and `appBlocks` (floods, one app each);
  - lift: `POST /security/unblock-ip` with `{"ip":"…"}` (every block of that address), or `{"ip":"…","app":"…"}` (that app's);
  - block by hand: `POST /security/block-ip` with `{"ip":"…","reason":"…","duration":3600}`.
- **One app busy:** its visitors get 503 with `X-Jrok-App-Busy`, and jrok logs `🚦 <app>: N requests already waiting`. The app itself is too slow for its traffic: more replicas, or a look at the app.

## Edge cache

nginx keeps what an app marks shareable (`public` or `s-maxage`, never HTML) and serves it without asking jrok. So jrok tells nginx what to leave to it:
- **Hosts** of an app with IP rules (an allowlist, or a blocklist with addresses) or a suspension: `/etc/nginx/jrok-cache-off.map`.
- **Addresses blocked by hand** (`POST /security/block-ip`): `/etc/nginx/jrok-blocked-ips.geo`. Flood blocks are not listed: they protect the apps and tunnels, which cached files don't touch.

Their requests are never answered from the cache nor stored in it, so jrok's checks see each one. jrok rewrites both files and reloads nginx within about 20 s of a change reaching the edge, at most once every 15 s. If nginx refuses them, it puts the old ones back and logs `❌ nginx refused the edge cache rules`; a change logs `🧊 Edge cache rules updated`. Don't edit them by hand: jrok overwrites them.

## Checks

```bash
curl -s --resolve app.public.koompi.cloud:443:<edge-ip> https://app.public.koompi.cloud/   # one edge
ssh root@<edge> journalctl -u jrok-dns-health -f      # DNS decisions (the lease holder writes)
ssh root@<edge> journalctl -u jrok -f
```

**Failover test, 2026-11-01:**
- **Setup:** both deploy workers (vps4, selendra-03) on the new setup, so 42 apps have an agent on every edge.
- **Test:** jrok on edge1 stopped for 61 s.
- **Result:**
  - 244 of 244 requests to those apps succeeded through edge1 (its nginx passed them to edges 2 and 3), through edge2, and through normal DNS;
  - edge1 stayed in DNS, as it kept serving through its nginx.
- **Still down while edge1 is:**
  - tunnels whose agents connect to edge1 only: people running `jrok` themselves through `tunnel.koompi.cloud`, and workers not yet updated;
  - database/SSH tunnels, which move after 10 minutes, with a new address.

On 2026-11-01:
- 16 live apps and custom domains answered the same through every edge;
- 360 of 360 requests through real DNS succeeded, spread evenly over the three edges.
