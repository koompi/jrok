# Plan: Many jrok Edges Across Cambodia (Stateless Apps)

**Status:** Approach agreed 2026-10-30. Phase 0 built on 2026-10-31 (branch `feat/phase0-edge-fixes`) and passed on staging the same day: 2 edges, real TLS, kept running for the later phases ([runbook](staging-runbook.md)). Next: Phase 1 step 1.3 (MongoDB off the request path), then production rollout of Phase 0.
**Date:** 2026-10-30
**Repos:** jrok (server, CLI, Ansible) and kconsole (deploy worker, backend)
**Scope:** HTTP and WebSocket traffic to stateless apps (Git and image services).
**Out of scope:** databases, VPS, TCP tunnels, RabbitMQ, kconsole's own MongoDB, a Rust/Pingora rewrite.
**Related:** [GPT/Codex review](../reviews/jrok-kconsole-multidc-stateless-paas-review.md)

---

## 1. Goal

KOOMPI Cloud should serve every stateless app from many jrok servers ("edges") in many regions of Cambodia, so that:

1. **Any edge can fail, or restart for a deploy, and no app goes down.**
2. **Capacity grows by adding edges and app replicas.** No edge is special. There is no leader.
3. **A MongoDB outage does not stop traffic that is already flowing.**
4. **Adding a region means adding edges and workers there.** No code change.

---

## 2. Where we are today

### Production

- **One edge** serves every app: `152.42.241.139` (DigitalOcean Singapore, 1 vCPU, 1 GB RAM, ~66 agents). This size is for testing; it can be made bigger. Restarting jrok drops every tunnel for about 5 seconds.
- **DNS** is on Cloudflare, DNS-only (not proxied). `*.public.koompi.cloud` and `*.tunnel.koompi.cloud` both point at that one IP.
- **jrok's MongoDB** is Atlas (cluster `reverse2vps`), which is already replicated. It is not a single point of failure.
- **Production nginx was edited by hand** and no longer matches the Ansible role (for example, prod has `worker_rlimit_nofile 8192`; the role does not). jrok is deployed by copying a bundle and restarting the service.

### Load test (2026-10-30)

A real jrok server and real jrok agents ran locally. Each process was pinned to one CPU core. There was no nginx, no TLS and no internet latency, so these numbers measure jrok's own cost.

| Test | Requests/s | Median / p99 | Errors | jrok server CPU | Agent CPU |
|---|---|---|---|---|---|
| 1 KB JSON, 100 connections | 4,792 | 15 / 99 ms | 0 | 54% | 77% |
| 30 KB page, 100 connections | 2,708 (84 MB/s) | 27 / 79 ms | 0 | 47% | 93% |
| 300 KB file, 50 connections | 484 (149 MB/s) | 97 / 139 ms | 0 | 32% | 94% |
| 30 KB page, 2,000 connections, 1,000/s | 1,003 | 114 / 551 ms* | 0 | 19% | 44% |
| 30 KB page, 2,000 connections, 1,500/s | 1,515 | 161 / 606 ms* | 0 | 28% | 60% |
| 30 KB page, **2 replicas**, 200 connections | 4,751 (147 MB/s) | 41 / 77 ms | 0 | 71% | 86% |

\* The load tool sends rate-limited traffic in bursts. Sent the same way straight to the app, the median was 73 ms, so jrok added about 40 ms under those bursts.

**What this tells us:**

- The **agent** (one Node process per replica) is the first limit: about 2,700 pages of 30 KB per second. A second replica gave 1.75× the throughput.
- **One jrok core** served 4,750 pages/s at 71% CPU. TLS in nginx will add CPU on top of this.
- **2,000 open connections ran with no errors.**

These numbers measure jrok's own cost on a fast desktop core. They are **not** an edge's capacity: see the staging numbers below.

### Staging (2026-10-31)

Two edges built from the Ansible role on DigitalOcean SGP1, each 1 vCPU / 1 GB "Regular" (production's size), with nginx 1.18, Bun 1.3.4 and real Let's Encrypt certificates. A 2 vCPU test droplet ran MongoDB, the test app, and a group-mode agent built from the branch. Load came from the test droplet (`autocannon`, gzip accepted, keep-alive connections).

| Test | Requests/s | Median / p99 | Errors | Edge CPU (jrok / nginx) |
|---|---|---|---|---|
| Small page, 50 connections | 544 | 198 / 383 ms | 0 | 89% (54 / 34) |
| Small page, 200 connections | 691 | 274 / 1,140 ms | 0 | 90% (50 / 38) |
| JS file (16 KB, sent gzipped), 100 connections | 432–514 | 221–244 / 602–766 ms | 0 | 71–86% |
| JSON (9.8 KB, sent gzipped), 100 connections | 557 | 203 / 558 ms | 0 | 89% (49 / 39) |
| Small page through edge2, forwarded to the agent on edge1 | 315 | 285 / 775 ms | 0 | edge2 99% (jrok 90), edge1 57% |
| Same edge: group-mode agent vs. single agent | 448 vs. 509 | — | 0 | 89% vs. 94% |

**What this tells us:**

- **A 1 vCPU edge tops out at about 500–700 requests/s with TLS.** CPU is the limit; memory is not (about 300 of 957 MB used). The latencies above are at saturation, not what visitors see at normal load.
- **The local numbers overstate a DigitalOcean vCPU.** A single-core micro-benchmark runs 2.6× slower there, and jrok used about 1 ms of CPU per request against 0.11 ms locally. The rest of that gap is not explained yet: profile jrok on an edge before settling edge sizes (Phase 0.5).
- **The agent** used about 80% of a core at 500–700 requests/s, so one replica on a similar CPU tops out near 850 requests/s.
- **nginx reuses its connections to jrok:** a few hundred TIME-WAIT per ~15,000 requests (about 98% reused). Production opens one per request.
- **Forwarding is expensive:** the forwarding edge spends about 2.5× the CPU of serving locally (P14).
- **Group mode's per-request MongoDB work** costs about 12% of throughput (P8). Its bigger cost is availability (below).

**Multi-edge baseline (today's code, before Phase 1):**

| Test | Result |
|---|---|
| Phase 0 checks through the edge holding the agent | 8 of 8 pass |
| Phase 0 checks through the other edge (forwarded) | 8 of 8 pass, including the event stream, the 70 s response and the idle WebSocket |
| Allowlist set through edge2, agent on edge1 | **Enforced nowhere.** edge1 never learns it, and edge2 forwards without checking it, so visitors are served through both edges (P4 confirmed). |
| jrok stopped on the edge holding the agent | The agent reconnected to the other edge in 0.6 s, and through that edge the app was down for under 1 s. Visitors whose DNS answer was the stopped edge got 502 the whole time, because nginx there was still up (P15). |
| MongoDB unreachable from the edge holding the agent | **The app went down through both edges within about 5 s and stayed down** for the 2.5 minutes of the test, though the agent never disconnected. Through that edge requests hung; through the other, 503. It recovered as soon as MongoDB returned (P8, worse than expected). |

### Problems found

| # | Problem | Where | Effect | Phase |
|---|---|---|---|---|
| P1 | nginx allows 10 requests/s per visitor IP (burst 20) on all `*.public` and `*.tunnel` apps | prod nginx, Ansible role | Normal page loads with many files get 503s. Users sharing a mobile carrier IP share the limit. It refused real traffic on 2026-10-21 (`/api/isiec/...`). | 0 |
| P2 | jrok gives an app 30 s to start answering; nginx closes connections that are quiet for 60 s | `src/index.ts:82`, nginx | Slow pages and reports get 504s. Chat apps that don't send pings lose their WebSocket after 60 s. | 0 |
| P3 | nginx opens a new connection to jrok for every request | `$connection_upgrade` map; custom-domain template in `domainService.ts` | Wasted CPU at high load | 0 |
| P4 | Per-app IP allow/block lists are saved to MongoDB but only loaded at startup | `securityService.ts:1114`, `index.ts:492` | With two edges, a customer's allowlist is enforced on only one of them. **Security issue.** | 1 |
| P5 | Admin IP blocks and suspensions live only in the memory of the edge that received the call | `securityService.ts:1142`, `index.ts:1840` | They reach only one edge | 1 |
| P6 | If one replica connects to several edges, its group record is overwritten | `agentGroupService.ts:186` (keyed by group + instance ID) | Wrong group state, members removed while still connected | 1 |
| P7 | Every edge saves its own copy of the daily stats | `statsService.ts:448` (`insertOne` with a new id) | Daily totals counted once per edge | 1 |
| P8 | MongoDB is on every request's path. In group mode (how kconsole runs every app), each request makes three MongoDB round trips in turn: find the group's healthy members (uncached), add to the chosen member's connection count, and subtract from it before the response is returned. None of them falls back to what the edge already knows. | `agentGroupService.ts:271`, `:318`, `:471`; `index.ts:1390` | **A MongoDB outage takes every app down within seconds, even with the agent connected to the edge** (measured on staging). In production it also adds about 5 ms per request (3 × 1.3–2 ms to Atlas). | 1 |
| P9 | Forwarded requests have no hop limit (`X-Forwarded-From` is set but never read) | `crossServerService.ts:184` | If MongoDB's record of an agent is stale, two edges can pass a request back and forth until it times out | 1 |
| P10 | Forwarding between edges uses plain `http://` / `ws://` | `crossServerService.ts:180`, `:270` | Customer traffic crosses the network unencrypted | 4 |
| P11 | The CLI builds the printed public URL from the `--server` hostname | `cli/src/index.ts:196` | Per-edge connect addresses would print the wrong URL | 1 |
| P12 | The worker runs one agent per replica, and its tunnel health check uses the public URL | `JrokService.ts:258`, `:663` | With several edges, DNS picks one at random, so the worker can't tell which edge lost a tunnel | 1 |
| P13 | The TCP tunnel hostname (`sgp1.private.koompi.cloud`) is the same server that serves HTTP | `ansible/inventory.ini` | Publishes the HTTP edge's real IP, which matters once it sits behind Cloudflare | 3 |
| P14 | Each forwarded request makes two uncached MongoDB lookups (which edge holds the agent, then that edge's address), and edge-to-edge connections are only partly reused (about 500 new ones in a 30 s run) | `crossServerService.ts:113`, `:488`, `:209` | The forwarding edge maxes out at about 315 requests/s, 2.5× the CPU of a local request (staging) | 1 |
| P15 | When jrok stops but nginx keeps running, that edge answers 502, and DNS keeps sending visitors to it | nginx `upstream jrok` lists only the local jrok | With two edges in DNS, about half of visitors fail until jrok is back or the edge leaves DNS (staging) | 2 |

---

## 3. Target design

### Terms

- **Edge:** one jrok server, meaning nginx (TLS) plus jrok, with a public IP. All edges are identical.
- **Region:** a site in Cambodia with **at least 2 edges** and some deploy workers.
- **Home edges:** the edges in the region where a replica runs.

### How it works

```
                      visitor
                         │
        DNS: every healthy edge (Cloudflare health checks)
                         │
     ┌──── Region A ────┐                    ┌──── Region B ────┐
     │ edge-a1  edge-a2 │◄────── HTTPS ─────►│ edge-b1  edge-b2 │
     │    ▲        ▲    │   (forwarding)     │    ▲        ▲    │
     │    └─ app X ─┘   │                    │    └─ app Y ─┘   │
     │  replicas        │                    │  replicas        │
     └──────────────────┘                    └──────────────────┘
```

1. Each app replica opens **one tunnel to each home edge**, so 2 tunnels in a normal region.
2. DNS sends visitors to any healthy edge.
3. If that edge has a local tunnel for the app, it serves the request directly. This is today's fast path and needs no MongoDB lookup.
4. If not (the app runs in another region), the edge forwards the request **once**, over HTTPS, to an edge that has it.
5. If an edge dies, the DNS health check removes it. The other home edge still has tunnels to every app in the region, so no app goes down.
6. **No leader.** Every background job either touches only its own edge's data or is safe to run on every edge at once.

Each replica keeps 2 tunnels no matter how many regions exist. Adding a region is adding 2+ edges and some workers.

**Why not connect every agent to every edge?** That works for 2–4 edges, but tunnels = replicas × edges, which doesn't scale to many provinces.

### Rules every change must follow

- The request path never waits on MongoDB when the edge already has the answer in memory.
- If MongoDB errors, use the last known answer.
- Shared settings (IP rules, blocks, suspensions) are stored in MongoDB, and every edge picks up changes within about 15 seconds.
- A request is forwarded at most once.
- The server keeps working with older CLI agents that don't send the new fields.
- Everything keeps working with a single edge. Today's production and self-hosted KConsole installs run one; they just don't get failover.

---

## 4. Phases

Each phase can ship on its own and leaves production better than before. Time estimates are rough.

### Phase 0: Fix the single edge (no new servers), about 1–2 days

| Step | Work |
|---|---|
| 0.1 | Copy the production nginx config back into the Ansible role and compare them, so every future edge is built from one source of truth. |
| 0.2 | Remove the per-IP `limit_req` from app traffic on `*.public` and `*.tunnel` (P1). Keep the strict limits on `/ws/agent`, the API and `/certificates/`. Decision **D3**. |
| 0.3 | Turn on upstream keepalive: make the `$connection_upgrade` map default to `""`, and make the custom-domain template in `domainService.ts` use the `jrok` upstream. Regenerate the 74 existing custom-domain configs (P3). |
| 0.4 | Raise the timeouts: `TUNNEL_REQUEST_TIMEOUT_MS` and nginx `proxy_read_timeout` for HTTP, plus a long read timeout for WebSocket upgrades (P2). Decision **D4**. |
| 0.5 | Resize the edge (recommended: 2 vCPU / 4 GB). Decision **D5**. |
| 0.6 | Compression: add `application/json`, `application/javascript`, `image/svg+xml` and the other text types to `gzip_types`. Today production (nginx 1.18) sends JSON APIs and JS bundles to phones uncompressed unless the app compresses them itself. Text usually shrinks 70–90%. |

**Done when:**
- A page with 60 files loads with no 503s from one IP.
- 100 requests/s from one IP all succeed.
- An idle WebSocket stays open for 10 minutes.
- JSON and JavaScript responses arrive gzip-compressed.
- The load test shows no slowdown.

**Found while testing Phase 0 (also on the branch):**

| Step | Work |
|---|---|
| 0.7 | Event streams reached HTTP/1.1 clients (server-side `fetch`, SDKs) all at once when they ended; browsers on HTTP/2 were fine. jrok now sets `X-Accel-Buffering: no` on `text/event-stream` (Fix-100). |
| 0.8 | Agent WebSocket bugs: messages a visitor sent on open were dropped, and a vanished visitor (close code 1006) made the agent throw and leak the app-side socket (Fix-101). |
| 0.9 | The Ansible nginx role never applied its config to a running nginx; the playbook referenced an undefined `jwt_secret` and a hard-coded `example.com` email (Fix-102). |

**Results (local, 2026-10-31).** nginx 1.18 with the config rendered from the Ansible role, compared with production's current `nginx.conf` (only names and ports changed for the test), in front of jrok and an agent from the branch:

| Check | Production today | Phase 0 |
|---|---|---|
| JS the app gzipped itself (2,041 bytes) | 16,192 bytes, uncompressed | 1,970 bytes, gzip |
| JSON (9,791 bytes) | 9,791 bytes, uncompressed | 995 bytes, gzip |
| 60 requests at once from one IP to an app | 21 × 200, 39 × 503 | 60 × 200 |
| jrok's own host, same burst | 21 × 200, 39 × 503 | 21 × 200, 39 × 503 (kept) |
| Connections nginx opened to jrok for 3,000 requests | 2,961 | 0 new (134 kept open and reused) |
| 70 s response | 504 at 60 s | 200 |
| WebSocket idle 75 s | Closed at 60 s | Open; message sent on open delivered |
| Event stream to an HTTP/1.1 client | All 6 events at 3.0 s | 0.5 s apart |
| Production's 73 custom-domain vhosts | — | 66 upgraded, 7 hand-edited left alone (run against copies) |
| `nginx -t` | — | Passes for the new `nginx.conf`, and for the new vhosts under production's current `nginx.conf` |
| jrok test suite | — | 165 pass, 0 fail |

**On staging (2026-10-31, real TLS, 2 edges):** all 8 checks in `scripts/staging/phase0-check.ts` pass through both edges, including when the request is forwarded from one edge to the other. Load and failure results are in section 2.

**Decisions taken:** D3, the per-IP limit is removed from app traffic and kept on jrok's own hosts. D4, apps get 120 s to start answering and a quiet WebSocket gets 1 hour.

### Phase 0.5: Edge cache, binary frames, compression in the tunnel, about 1–2 weeks

| Step | Work |
|---|---|
| 0.5.1 | **Edge cache** (nginx `proxy_cache`) for responses the app marks as shareable, such as Next.js `_next/static/*` (`public, max-age=31536000, immutable`). Cached files never cross the tunnel. **Safety rules:** (1) the cache key is scheme + **host** + URI, because nginx's default key uses the upstream name, which is the same for every app, so two customers' `/app.js` would collide; (2) cache only responses whose `Cache-Control` has `public` or `s-maxage`; (3) never cache a response with `Set-Cookie`, or one marked `private`, `no-store` or `no-cache`; (4) cap the cache size on disk. |
| 0.5.2 | **Binary frames:** write the frame format down as a short spec, then implement it in the server and the current CLI behind a new capability, so old agents keep using base64. The Phase 5 connector reuses the same spec. Measured 2026-10-30: base64 + JSON adds 33–42% to the bytes on the worker→edge link and costs the Node agent about 400–670 MB/s per core (about a fifth of its CPU when serving large files; about 1% for small API responses). jrok has never used binary frames on the agent link; Fix-059's corrupted uploads came from reading bodies as text, which base64 fixed. |
| 0.5.3 | **Compression in the tunnel:** the agent gzips text responses that arrive uncompressed, when the visitor accepts gzip. It skips `text/event-stream`, responses that are already compressed, and very small bodies, and flushes each chunk so streaming keeps working. It sets `Content-Encoding` and `Vary: Accept-Encoding`; nginx passes these responses through without compressing them again. This moves compression CPU from the edges to the workers. |

**Done when:**
- A repeat visit to a Next.js app serves `_next/static` files from the edge cache (`X-Cache-Status: HIT`).
- Tests prove two apps with the same path and different content never get each other's cached file, and that responses with `Set-Cookie` or marked `private` are never cached.
- Tunnel bytes for a text page drop by at least 60%.
- The load test (section 8) shows the same or better numbers.
- An old CLI works against the new server, and the new CLI works against an old server.

### Phase 1: Make jrok safe to run as many equal edges (code only; production still has one edge), about 1–1.5 weeks

**jrok:**

| Step | Work | Fixes |
|---|---|---|
| 1.1 | Each edge reloads per-app IP rules from MongoDB every 10 s, picking up only records changed since the last reload (`updatedAt`). Admin blocks and suspensions move to a MongoDB collection and reload the same way. Automatic abuse blocks stay per edge. | P4, P5 |
| 1.2 | Daily stats: upsert keyed on organization + tunnel + day, so any number of edges can run the job. | P7 |
| 1.3 | **Take MongoDB off the request path (do first).** An edge picks among the group members whose sockets it holds and keeps their connection counts in memory. MongoDB is used only to find members on other edges, through a cache refreshed in the background and kept when MongoDB throws. Route lookups for forwarding work the same way. Safe to ship to the single production edge on its own. | P8, P14 |
| 1.4 | One-hop rule: forwarded requests carry a hop header. An edge that receives one never forwards again; it serves locally or returns 502. | P9 |
| 1.5 | Edge identity: `EDGE_ID`, `REGION`, `FORWARD_URL` (the HTTPS address other edges use to reach this one) environment variables, recorded in `serverHeartbeats`. Forwarding uses `FORWARD_URL`. | — |
| 1.6 | CLI: the server sends the public URL in the welcome message (or a `--public-domain` flag), so connect addresses and public URLs are separate. | P11 |

**kconsole deploy worker:**

| Step | Work | Fixes |
|---|---|---|
| 1.7 | Read a `JROK_EDGES` list and run one agent per home edge for each replica. Extend the instance ID to `<instanceId>@<workerId>@<edgeId>`. Use one CLI process per edge (no CLI refactor). At about 62 MB each that is fine at today's scale; Phase 5 replaces it when replicas reach the thousands. | P6, P12 |
| 1.8 | Check tunnel health per edge, and restart only the agent for the edge that lost its tunnel. Either call each edge directly, or add a small endpoint that reports whether an edge holds a tunnel for an instance. | P12 |

**Tests:**
- Unit tests for each change, in the style of `tests/requestPathNoDb.test.ts` (in-memory stand-in for the collections).
- A local test with 2 edges and 2 agents per replica, checking that:
  - stopping one edge under load fails only the requests in flight on it;
  - an allowlist change is enforced on both edges within 15 s;
  - stopping MongoDB does not stop traffic;
  - a stale agent record does not cause a forwarding loop.

**Done when:** all tests pass, and production (still one edge) runs the new code for a week with no regressions.

### Phase 2: Second edge in production, about 3–5 days

| Step | Work |
|---|---|
| 2.1 | **Staging first:** 2–3 DigitalOcean droplets as edges, with nginx and TLS on a test domain, plus a separate droplet that generates load. They must use **their own MongoDB, never the production Atlas cluster**: jrok always uses the database named `jrok`, so staging edges on the production cluster would join production. DigitalOcean has no Cambodian region, so these droplets test multi-edge behaviour and TLS cost per core; run the load test once more from a machine inside Cambodia for real latency. Spinning them up before Phase 1 is useful too: it records today's multi-server behaviour (P4, P9) as a baseline. **Built 2026-10-31 and kept running**; the baseline is in section 2. |
| 2.2 | Build edge-2 with Ansible, ideally in Cambodia (decision **D2**). Edges reach each other over HTTPS (`wss://` for WebSockets), authenticated with a shared server key. |
| 2.3 | Certificates: install the wildcard `*.public` / `*.tunnel` certificates on both edges. Custom-domain certificates already sync from MongoDB every 5 minutes. HTTP-01 challenges must work on both edges, so either serve them from MongoDB or forward `/.well-known/acme-challenge/` to the edge that requested the certificate. |
| 2.4 | **Rollout:** set `JROK_EDGES` on one worker, then all workers. Confirm every app has a tunnel on both edges. Then add edge-2's IP to DNS with Cloudflare health checks. |
| 2.5 | **Failover drill:** stop edge-1 under test load, and measure failed requests and how long DNS keeps sending visitors to it. Then write a rolling deploy script: take an edge out of DNS, deploy, check it, put it back. |
| 2.6 | When the local jrok is down, nginx sends requests to another edge instead of answering 502: list the other edges as `backup` servers in the `jrok` upstream, reached over HTTPS. Health-checked DNS (or Cloudflare) covers a whole machine going down (P15). |

**Done when:**
- The drill shows no app downtime beyond requests in flight.
- A jrok deploy drops no app requests.

### Phase 3: Front door and attack protection, about 3–5 days

This phase depends on decision **D1**.

- **Option A: Cloudflare proxy** for `*.public` and `*.tunnel`. Cloudflare absorbs floods, adds a WAF and hides the edge IPs. Health-checked failover needs Cloudflare Load Balancing (a paid add-on). Custom domains would need Cloudflare for SaaS, or stay DNS-only.
- **Option B: DNS-only with health checks.** Simpler, but nothing absorbs a flood.

With either option:

| Step | Work |
|---|---|
| 3.1 | Restore the real visitor IP: nginx `set_real_ip_from` with Cloudflare's IP ranges plus `real_ip_header CF-Connecting-IP`, and set jrok's trusted proxy hops (`src/utils/clientIp.ts`). Do this **before** proxying, or per-IP limits will start blocking Cloudflare itself. |
| 3.2 | If proxied: firewall ports 80/443 so only Cloudflare's IP ranges can reach them. |
| 3.3 | Move TCP tunnels (databases, SSH) to their own servers so the HTTP edges' IPs aren't published (P13). |
| 3.4 | Admin and API endpoints (`/security/*`, admin): accept them only from kconsole's and the other edges' IPs. |
| 3.5 | Agent endpoint: give it its own hostname, and limit agent registrations per API key and per IP. |
| 3.6 | If proxied: use a Cloudflare Origin certificate on the edges, so they don't need certbot renewals for the wildcard. |

### Phase 4: More regions in Cambodia, about 2 weeks, after Phase 2 is stable

| Step | Work |
|---|---|
| 4.1 | Region config: each worker gets `REGION`, and `JROK_EDGES` lists only its region's edges. |
| 4.2 | Forwarding between regions: keep a map of domain → edges in memory, refreshed every 10 s and kept if MongoDB errors. Prefer healthy edges. Forward over HTTPS / `wss://` instead of plain `http://` / `ws://`, and have edges authenticate each other with a shared server key or mTLS (P10). |
| 4.3 | Location-aware replica placement in kconsole: workers report `region` and `datacenter` in their heartbeat (today the fields exist but are never filled in), and the replicas of one service spread across regions or data centers when possible (the GPT review's #2). |
| 4.4 | DNS: start with all edges in rotation. Inside Cambodia, latency depends mostly on which ISPs and mobile carriers a data center connects to, so choose data centers well connected to the big carriers. Add GeoDNS later only if measurements show it helps. |
| 4.5 | **Region drill:** stop every edge in one region. Apps with replicas in another region must keep serving. |

### Phase 5: One connector per worker, when replicas reach the thousands, about 3–4 weeks (rough)

Today every replica runs its own Node agent, about 62 MB each even when idle (measured). With 2 home edges, that is 2 agents per replica:
- **Today:** 66 agents, or 132 with 2 edges, is about 8 GB across all workers. That's fine.
- **At 5,000 services:** 5,000 × 2 replicas × 2 edges = 20,000 agents, about 1.2 TB. That's not fine.

Cloudflare's `cloudflared` solves the same problem with one process per machine.

| Step | Work |
|---|---|
| 5.1 | A connector per worker: one process carries every app on the worker, with 2 connections to each home edge. The server treats each app on it as its own agent, so routing, groups and health checks work as they do now. Processes go from replicas × edges to workers × edges. |
| 5.2 | Write it in Go or Rust. One process now carries a whole worker's traffic, and the Node agent tops out at about 2,700 pages of 30 KB per second per core. This is the one part of jrok where a rewrite pays off; the jrok server is not the bottleneck. |
| 5.3 | Use the binary frames and tunnel compression from Phase 0.5, following the same spec. |
| 5.4 | Roll out one worker at a time behind a flag, keeping per-replica agents as a fallback. **Drill:** kill the connector. Replicas on other workers keep serving, and the connector restarts (systemd) and reconnects every app within seconds. |

**Trade-off:** if a connector dies, every app on that worker loses its tunnels until it restarts. This is the same as losing the worker, which replicas on other workers already cover.

---

## 5. Capacity guide

Measured on staging (section 2), on DigitalOcean "Regular" vCPUs. Faster CPUs do better; re-measure on the real edge hardware.

- **Per edge, 1 vCPU (production's size today):** about 500–700 requests/s at full CPU, with nginx (TLS) and jrok sharing the core. Plan for 300.
- **Per edge, 2 vCPU:** nginx gets its own core. jrok is one process, so it uses one core at most: expect roughly 1,000 requests/s (not measured yet). Beyond that, add edges rather than cores.
- **Per replica:** about 850 requests/s with the agent at full CPU on a DigitalOcean vCPU. Plan for half that. Workers' CPUs differ.
- **Plan bandwidth caps limit a replica before jrok does.** Each app container has a `tc` limit: 10 MB/s on Free and Pro, which is about 330 pages of 30 KB per second, and 100 MB/s on Enterprise (`backend/src/config/pricing.ts:521`).
- **Example:** an app with 2,000 concurrent users usually makes about 400–2,000 requests/s, or 12–60 MB/s at 30 KB per request. On Pro that needs 2–6 replicas because of the bandwidth cap. At 300 requests/s each, it needs 2–7 production-sized edges, or 1–4 edges of 2 vCPU. The edge cache (Phase 0.5) takes static files, most of a page load's requests, off the tunnel and off jrok.
- **Edges:** at least N+1 per region. Size each edge so the others can carry its load when it fails.
- **MongoDB:** agent heartbeats are batched into one write per edge every 10 s, however many agents there are, so more edges add very little database load.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Workers only get CLI changes through `install.sh`, which installs from jrok branch `v2.6.5`. | Merge CLI changes into `v2.6.5` and reinstall on each worker. Keep the server compatible with old CLIs throughout. |
| Hand-edited production nginx is overwritten by the next Ansible run. | Phase 0.1 comes first. |
| DNS caching: some clients keep using a dead edge's IP until the TTL expires. | Use a low TTL (60 s), or Cloudflare proxy (Option A), which fails over without waiting for DNS. |
| A custom domain with an A record pointing at `152.42.241.139` only ever reaches that edge. | Before relying on failover, list every custom domain whose DNS points at that IP and move it to a CNAME or flattened record. |
| Two agent processes per replica use more memory on the workers (about 62 MB each). | Fine at today's scale (about 8 GB in total). Phase 5 replaces per-replica agents before it becomes a problem. |
| Phase 1 changes many things in one release. | Ship each step on its own behind the existing single edge; most steps change nothing until a second edge exists. |

---

## 7. Decisions needed

| # | Question | Recommendation |
|---|---|---|
| D1 | Put Cloudflare's proxy in front of app traffic? | Yes for `*.public` and `*.tunnel`. Budget for the Load Balancing add-on. |
| D2 | Where does edge-2 go? | A data center in Cambodia that is well connected to the big ISPs and mobile carriers. |
| D3 | Per-IP limit on app traffic: remove it, or raise it to what? | Remove it from app traffic. Rely on kconsole plan limits and Phase 3 for flood protection. |
| D4 | How long may an app take to answer, and how long may a WebSocket stay quiet? | 120 s and 1 hour. |
| D5 | Edge size? | 2 vCPU / 4 GB to start: on 1 vCPU, nginx and jrok compete for the one core (staging). jrok is one process, so beyond 2 vCPU add edges rather than growing one. |

---

## 8. How to rerun the load test

1. Start a throwaway MongoDB: `docker run -d --rm --name jrok-bench-mongo -p 127.0.0.1:27018:27017 mongo:7`. jrok always uses the database named `jrok` whatever the URI says, so never point a test server at a shared MongoDB.
2. Insert an API key document into `jrok.apiKeys`: `key` = sha256 of a `jrok_…` key, `permissions: ['*']`, `isActive: true`.
3. Start a fixed-response test app on one core, then jrok on another core: `PORT=13000 MONGODB_URI=mongodb://localhost:27018/jrok BASE_DOMAIN=bench.local taskset -c 2 bun run src/index.ts`.
4. Bundle the CLI for Node (`bun build cli/src/index.ts --target node`). Run it with `node … --server http://localhost:13000 --port <app> --domain bench --group --instance-id bench-a`, with `JROK_AUTH` set to the key.
5. Load test: `autocannon -c 100 -d 15 -w 4 -H Host=bench.bench.local http://localhost:13000/<path>`. For a fixed request rate, use `-w 1 -R <rate>`, because `-R` applies to each worker thread.
6. Measure CPU from `/proc/<pid>/stat` (utime + stime) before and after each run. `ps %cpu` averages over the process's whole lifetime and is wrong for this.
