# Multi-Server Deployment Guide

How to run kproxy across many nodes for high availability and horizontal scale. The design has **no single point of failure** and **no external coordinator (no Redis)** — the routing brain lives inside the nodes themselves as an in-memory gossip mesh.

## Architecture

```
                         ┌──────────────────────────────┐
   clients ─────────────▶│  Cloudflare edge + Load Balancer │  (health-checked origin pool)
                         └───────────────┬────────────────┘
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
       ┌────────────┐  /_gossip   ┌────────────┐  /_gossip   ┌────────────┐
       │  kproxy-1  │◀──────────▶│  kproxy-2  │◀──────────▶│  kproxy-N  │
       │  VPS_ID=a  │   mesh      │  VPS_ID=b  │   mesh      │  VPS_ID=n  │
       └─────┬──────┘             └─────┬──────┘             └─────┬──────┘
             │ agent tunnels             │                         │
             ▼                          ▼                         ▼
          agents                      agents                    agents

                         ┌──────────────────────────────┐
                         │ MongoDB (replica set / Atlas) │  cold/durable state only
                         └──────────────────────────────┘
```

- **Cloudflare Load Balancer** replaces the old nginx upstream — it health-checks the origin pool and steers traffic across nodes.
- **Gossip mesh** (`/_gossip`) replicates the live `hostname → node` routing table in memory across all nodes.
- **MongoDB** holds only cold/durable state and is **off the request hot path**.

## What state lives where

| State | Where | Hot path? |
|-------|-------|-----------|
| Live `hostname → node` routing | **Gossip mesh (in-memory, all nodes)** | **Yes** — every request |
| Agent's tunnel socket | The node the agent dialed (its "home node") | Yes |
| Users, orgs, API keys, tunnel & custom-domain records | MongoDB | No (cold) |
| Server heartbeats (peer discovery bootstrap) | MongoDB `serverHeartbeats` | No |
| TCP port allocations | MongoDB `tcpPortAllocations` | On TCP connect only |
| Public certificates | **Cloudflare** (Universal SSL / Custom Hostnames) | n/a |

> There is no `agentConnections`-per-request lookup on the hot path anymore, no certificate collections, and no leader election. Those were removed when routing moved to gossip and TLS moved to Cloudflare.

## Setup

### Step 1 — MongoDB (shared cold state)
Use Atlas or a self-hosted replica set reachable by every node. See [MongoDB Setup](../configuration/mongodb.md). One database, default name `kproxy` (`MONGO_DB_NAME`).

### Step 2 — Per-node configuration
Each node needs a **unique `VPS_ID`**, a **`VPS_HOST`** other nodes can reach it on directly (private/mesh IP, not via Cloudflare), and the **same `GOSSIP_SECRET`** everywhere.

```bash
# node A
VPS_ID=node-a
VPS_HOST=10.0.0.11
GOSSIP_SECRET=shared-secret-on-every-node
MONGODB_URI=mongodb+srv://.../kproxy
PORT=3000

# node B
VPS_ID=node-b
VPS_HOST=10.0.0.12
GOSSIP_SECRET=shared-secret-on-every-node
MONGODB_URI=mongodb+srv://.../kproxy
PORT=3000
```

Nodes discover each other from `serverHeartbeats` and dial peers over `ws://VPS_HOST:PORT/_gossip?token=GOSSIP_SECRET`. The "lower `VPS_ID` dials" rule yields exactly one connection per pair. Put the gossip/forwarding traffic on a **private network or mesh** (WireGuard/Tailscale) — it should never traverse Cloudflare.

### Step 3 — Cloudflare Load Balancer (replaces nginx upstream)
Create an origin pool containing every node, add a `GET /health` check, and attach the LB to your hostname. See [Cloudflare Setup](../configuration/cloudflare.md). To add capacity, add a node to the pool; to remove one, let the health check drain it.

### Step 4 — Origin TLS
Install the **Cloudflare Origin CA cert** on each node (or run `cloudflared`). No Certbot, no per-node Let's Encrypt.

## Cross-node request routing

```
1. Request hits any node via the Load Balancer.
2. Node looks up the hostname in its in-memory gossip table  (no DB round-trip).
3a. Agent is local      → forward down the tunnel.
3b. Agent is on a peer  → proxy to that node over the mesh → it forwards down the tunnel.
3c. Cache miss (just-connected) → one-shot whoHas broadcast → else MongoDB fallback.
```

## High-availability behavior

- **Node failure:** Cloudflare LB drains it (health check); peers evict its routes; its agents auto-reconnect to a surviving node via the LB and re-register through gossip.
- **Graceful shutdown:** on `SIGINT`, a node stops accepting traffic and its peers/heartbeats expire its routes.
- **Agent reconnection:** the CLI auto-reconnects; the new home node re-publishes the route (newest `(timestamp, nodeId)` wins, so reconnect-to-a-different-node is handled correctly).
- **MongoDB blip:** live traffic keeps flowing from the in-memory gossip map; only new registrations/cold reads are affected.

## Monitoring

```bash
# Cluster stats (servers, agents, tunnels)
curl -H "Authorization: Bearer $API_KEY" https://live.yourdomain.com/admin/cluster/stats

# Per-node health (used by the Cloudflare LB)
curl https://live.yourdomain.com/health
```

Watch node logs for `🕸️  gossip: connected to peer <id>` to confirm the mesh is formed, and for the `GOSSIP_SECRET` warning if it's unset.

## Scaling guidelines

- **Per node:** run multiple Bun processes with `reusePort: true` to use all cores. Each agent is one long-lived socket — budget tens of thousands per node (file descriptors + memory).
- **Horizontally:** add a node → set `VPS_ID`/`VPS_HOST`/`GOSSIP_SECRET` → add it to the LB pool. It joins the mesh and starts taking traffic. Capacity ≈ sum of nodes.
- **At hundreds of nodes:** full-mesh gossip connections grow; consider a SWIM-style membership library or consistent-hash routing (the routing layer is behind an interface for this). Not needed for typical fleets.

## Troubleshooting

**Agent not found / 502 for a hostname**
```bash
# Is the agent connected anywhere?
#   check that the agent CLI is running and shows "connected"
# Is the mesh formed? look for gossip peer logs on each node.
# Cold fallback: the agentConnections record exists in MongoDB.
```

**Gossip peers not connecting**
- Confirm `VPS_HOST:PORT/_gossip` is reachable **node-to-node** (private network/firewall).
- Confirm `GOSSIP_SECRET` is identical on every node (mismatch → 403 on `/_gossip`).
- Confirm each `VPS_ID` is unique.

**Stale route after a node died**
- Routes for a vanished node are evicted within ~90s (heartbeat TTL); agents reconnect in the meantime. If you see a brief 502, it self-heals.

## Environment variables

See [Environment Variables](../configuration/environment.md) for the full reference (`VPS_ID`, `VPS_HOST`, `GOSSIP_SECRET`, `MONGO_DB_NAME`, `CF_*`, etc.).

---

## Next steps
- [Cloudflare Setup](../configuration/cloudflare.md)
- [Architecture Overview](../getting-started/architecture.md)
- [MongoDB Setup](../configuration/mongodb.md)
