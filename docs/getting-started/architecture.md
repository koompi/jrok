# Architecture Overview

kproxy is a **horizontally-scalable reverse proxy** for exposing local services to the internet. Agents dial out over a persistent WebSocket from anywhere (no public IP, no port-forwarding, no shared network), and any kproxy node can serve any agent. There is **no single point of failure** and you scale by **adding nodes** — Cloudflare's Load Balancer spreads traffic across them, and an in-memory gossip mesh lets every node route to every agent.

## Topology

```
                          ┌──────────────────────────────┐
   Browsers / API         │        CLOUDFLARE EDGE         │
   clients      ─────────▶│  • Universal SSL (auto)        │  TLS #1: browser ⇄ Cloudflare
                          │  • Load Balancer (origin pool) │  (fully automatic)
                          │  • WAF / DDoS / caching        │
                          │  • Custom Hostnames (SaaS TLS) │
                          └───────────────┬────────────────┘
                                          │  TLS #2: Cloudflare ⇄ origin
                                          │  (one Origin CA cert per node)
                 ┌────────────────────────┼────────────────────────┐
                 ▼                        ▼                        ▼
          ┌────────────┐           ┌────────────┐           ┌────────────┐
          │  kproxy-1  │◀────────▶│  kproxy-2  │◀────────▶│  kproxy-N  │   ← just add nodes
          │ (stateless)│  gossip   │ (stateless)│  gossip   │ (stateless)│
          └─────┬──────┘  /_gossip └─────┬──────┘  mesh     └─────┬──────┘
                │  persistent agent WebSocket tunnels (dialed OUT by agents)
        ┌───────┴───────┐        ┌───────┴───────┐        ┌───────┴───────┐
        ▼               ▼        ▼               ▼        ▼               ▼
   ┌─────────┐    ┌─────────┐  ┌─────────┐         ...  ┌─────────┐
   │ agent A │    │ agent B │  │ agent C │              │ agent Z │   ← run anywhere
   │ :3000   │    │ :8080   │  │ :5432   │              │ :22     │
   └─────────┘    └─────────┘  └─────────┘              └─────────┘
        │
        ▼ local container / app / API / database

   Shared services (not on the request hot path):
   • MongoDB  — cold/durable state (users, orgs, API keys, tunnels, custom domains)
   • Cloudflare R2 / S3 — large file payloads (presigned URLs; never transit kproxy)
```

## Request flow

### 1. Agent connects (dials out)
```
kproxy CLI ──wss──▶ Cloudflare ──▶ kproxy node ──▶ register in gossip map (+ MongoDB)
```
`kproxy http 3000` opens a WebSocket to `/ws/agent`, authenticates with an API key, and the node it lands on becomes that agent's **home node**. The home node publishes `hostname → node` into the in-memory gossip table, which replicates to every other node within milliseconds.

### 2. Inbound request
```
Browser ──https──▶ Cloudflare (edge TLS + LB) ──▶ some kproxy node (origin TLS)
```
Cloudflare's Load Balancer picks any healthy node from the origin pool. The chosen node may **not** be the agent's home node — that's fine.

### 3. Routing (the interesting part)
```
node receiving request ──gossip lookup──▶ "agent X is on home node" ──forward──▶ home node ──tunnel──▶ agent ──▶ local service
```
- The receiving node looks up the hostname in its **in-memory gossip table** — zero database round-trip on the hot path.
- If the agent is **local**, it forwards straight down the tunnel.
- If the agent is on **another node**, it proxies the request to that node over the internal mesh, which forwards down the tunnel.
- On a rare cache miss (the agent connected milliseconds ago), the node does a one-shot `whoHas` broadcast, then falls back to MongoDB.

## TLS model — who issues what

| Leg | Covers | Who provisions it | Notes |
|-----|--------|-------------------|-------|
| Browser ⇄ Cloudflare | `*.yourdomain` subdomains | **Cloudflare Universal SSL** | Automatic, auto-renewed. You do nothing. |
| Browser ⇄ Cloudflare | customer **custom domains** | **Cloudflare for SaaS** (Custom Hostnames) | kproxy calls the CF API; CF issues + renews. Customer CNAMEs **DNS-only**. |
| Cloudflare ⇄ kproxy node | the origin leg | **one Cloudflare Origin CA cert** | 15-year cert, identical on every node, installed once. Or use `cloudflared` for zero certs. |

There is **no Let's Encrypt, no Certbot, no nginx, no certificate syncing**. Cloudflare owns every public certificate.

## Large payloads go to R2, not through kproxy

kproxy is the **control + small-payload plane**: HTTP requests/responses, APIs, WebSocket apps. It is **not** a bulk file pipe. Large uploads/downloads should go **directly to Cloudflare R2 (or S3)** via presigned URLs — the client talks to R2, not to your tunnel.

This is deliberate and matches the platform:
- Cloudflare's Load Balancer is not designed to stream large files through the origin.
- Keeping big payloads off the tunnel keeps node memory flat and lets you scale on request *count*, not byte volume.

```
Upload:   client ──presigned PUT──▶ Cloudflare R2        (kproxy only mints the URL)
Download: client ──presigned GET──▶ Cloudflare R2
App/API:  client ──▶ Cloudflare ──▶ kproxy ──▶ agent ──▶ your service
```

## Components

### kproxy node (server)
Stateless Bun process (`src/`). Each node:
- terminates the Cloudflare Origin CA cert directly (`Bun.serve` native TLS — no nginx)
- accepts agent tunnels on `/ws/agent`
- runs the **gossip routing** service and the internal mesh (`/_gossip`)
- forwards requests to local agents, or proxies to the node that holds the agent

Run several processes per box with `Bun.serve({ reusePort: true })` to use all cores.

### Gossip routing (`gossipService.ts`)
The distributed routing brain — **no Redis, no external coordinator**:
- in-memory `hostname → node` map on every node
- full-mesh gossip over `/_gossip` (authenticated with `GOSSIP_SECRET`)
- conflict resolution by `(timestamp, nodeId)`, tombstones on disconnect, periodic anti-entropy
- self-healing: a dead node's routes are evicted and its agents reconnect elsewhere
- **routing availability == cluster availability** — nothing separate to keep alive

### kproxy CLI agent
Lightweight Node/Bun client. Dials out over WebSocket, receives requests, forwards to the local service, returns responses, auto-reconnects. Works behind NAT/firewalls with no inbound ports.

### Dashboard
React/Vite web UI for login (OAuth), organizations, API keys, tunnels, custom domains, and usage.

### Shared services
- **MongoDB** — cold/durable state only (users, orgs, API keys, tunnel records, custom-domain records). **Not** on the request hot path; gossip is. A brief Mongo blip doesn't drop live traffic.
- **Cloudflare** — edge TLS, Load Balancer, WAF, DNS, and Custom Hostnames for custom domains.
- **Cloudflare R2 / S3** — large file storage via presigned URLs.

## No single point of failure

| Layer | How it survives a failure |
|-------|---------------------------|
| Edge | Cloudflare LB health-checks the origin pool and steers away from dead nodes |
| Routing | Gossip map lives on every node; a node loss evicts its routes, agents reconnect |
| Agents | Auto-reconnect to a surviving node (via the LB) and re-register |
| State | MongoDB replica set / Atlas; only cold data, off the hot path |
| Certs | Cloudflare-managed — nothing for a node to lose |

## Scaling — "just add a node"

1. Provision a box, install the Origin CA cert (or run `cloudflared`).
2. Set `VPS_ID` (unique), `VPS_HOST` (how peers reach it directly), and the shared `GOSSIP_SECRET`.
3. Add its IP/hostname to the Cloudflare Load Balancer origin pool.
4. The node joins the gossip mesh automatically; the LB starts sending it traffic.

Capacity scales with the number of nodes. Each agent is one long-lived socket (tens of thousands per node), so total agent capacity ≈ sum of nodes.

## Technology stack

| Component | Technology |
|-----------|------------|
| Server runtime | [Bun](https://bun.sh) |
| Edge / TLS / LB | Cloudflare (Universal SSL, Load Balancer, Cloudflare for SaaS) |
| Routing | In-process gossip mesh (no external store) |
| Cold state | MongoDB (Atlas or self-hosted) |
| Large files | Cloudflare R2 / S3 (presigned URLs) |
| Dashboard | React + Vite |
| CLI | Node/Bun + TypeScript |
| IaC | Terraform + Ansible |

---

## Next steps
- [Cloudflare Setup](../configuration/cloudflare.md) — orange proxy, Load Balancer, Origin CA, Custom Hostnames
- [Multi-Server Deployment](../deployment/multi-server.md) — the gossip mesh and scaling
- [Environment Variables](../configuration/environment.md) — all configuration options
- [MongoDB Setup](../configuration/mongodb.md) — cold-state database
