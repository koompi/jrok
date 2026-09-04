# Proxy Mode

**Status:** default since 2026-09-04 · **Flag:** `JROK_PROXY_MODE` (default `true`)

## Decision

Jrok is a proxy, not a billing system. kconsole owns metering, quotas and
pricing — it has the customer, the plans and the payment data. Jrok enforcing a
second, independent set of plan limits meant every proxied request paid for a
policy decision jrok was not the authority on, and the two systems could
disagree about the same customer.

Proxy mode strips enforcement out of jrok while keeping accounting.

## What is off in proxy mode

| Removed | Was |
|---|---|
| Plan lookup per request (`getOrganizationPlan`) | 1–2 Mongo queries on cache miss, 60s TTL |
| HTTP rate limits (token bucket, per client) | 300 req/min × plan multiplier, 2× burst |
| Global per-tunnel HTTP rate limit | 3000 req/min × multiplier |
| Concurrent HTTP connections per tunnel | 200 × multiplier |
| Monthly bandwidth quota (402 response) | 1 GB × multiplier, in-memory (lost on restart) |
| TCP connection limits (per client / tunnel / org) | 10% of 5000 per client, 20000 per org |
| TCP bandwidth limits | 100 MB/min, 1 GB/hour per tunnel |
| Per-IP connection cap | 100 — broke NAT'd and multi-tunnel hosts |
| Per-server agent/client connection caps | 5000 / 10000 |
| Tunnel / domain / API key / member limits at connect | free tier: 1 tunnel, 1 domain, 3 keys, 2 members; 3 Mongo queries per agent connect |
| Custom domains gated to paid plans | blocked on free |

## What stays

- **Usage accounting.** `statsService.recordBandwidth` accumulates in memory and
  flushes to `bandwidth_records` in a batch every 30s. kconsole bills from it.
  Accounting was never the slow part; enforcement was.
- **Abuse control.** Globally blocked IPs and per-tunnel IP allow/blocklists —
  in-memory Map lookups, and not plan policy.
- **Connection logs.** Still off by default (`ENABLE_CONNECTION_LOGS`).

## How kconsole cuts someone off

Jrok computes no quota, so kconsole pushes the verdict in. Suspensions are held
in memory (no I/O on the request path); a suspended org gets `402` on HTTP and a
dropped socket on TCP.

```
POST   /security/suspensions   {"organizationId": "...", "reason": "Over quota"}
DELETE /security/suspensions   {"organizationId": "..."}
GET    /security/suspensions
```

Auth: `X-Admin-Key: $JROK_ADMIN_KEY` (falls back to `API_KEY`), or a super-admin
session. **kconsole must re-push active suspensions after a jrok restart** —
they are deliberately not persisted.

## Request path after this change

Zero MongoDB queries in the steady state: local socket lookup for the agent,
cached custom-domain and agent-group lookups (60s, invalidated on change), and
in-memory security maps. `bandwidth_records` is written once per 30s batch.

## Reverting

`JROK_PROXY_MODE=false` restores full standalone enforcement, for self-hosted
deployments that have no kconsole in front of them.

## Known remaining limits (not plan policy)

- `TUNNEL_REQUEST_TIMEOUT_MS` — 30s per request, env-tunable.
- `MAX_PENDING_REQUESTS` — 10000 in-flight requests, memory safety.
- Request bodies are fully buffered and base64-encoded over the agent
  WebSocket (~33% expansion, no streaming upload, no size cap). This is the
  biggest remaining throughput ceiling and needs a protocol change to fix.
- TCP flow-control watermarks (8/16/4 MB) — memory safety, not quotas.
