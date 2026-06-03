# Cloudflare Setup

Cloudflare is the front door for kproxy. It provides **edge TLS** (so you never run Certbot), the **Load Balancer** that spreads traffic across your nodes, **Cloudflare for SaaS** for customer custom domains, and optionally **R2** for large files.

> There is no Let's Encrypt / Certbot / nginx in this design. Cloudflare owns every public certificate.

## What you'll configure

1. Add your domain and turn on the **orange proxy** for kproxy hostnames.
2. Install **one Origin CA certificate** on every node (the Cloudflare ⇄ origin leg).
3. Lock origins to **Cloudflare IPs** (or use a Tunnel) so nobody bypasses the edge.
4. Create a **Load Balancer** with your nodes as an origin pool.
5. Enable **Cloudflare for SaaS** for customer custom domains.
6. (Optional) Create an **R2** bucket for large file payloads.

---

## 1. Add your domain (orange proxy ON)

1. Add your site at [dash.cloudflare.com](https://dash.cloudflare.com) and point your registrar at Cloudflare's nameservers.
2. Create the kproxy hostnames as **Proxied (orange cloud)** — the opposite of the old DNS-01 setup:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A / CNAME | `live` | your LB / node | **Proxied (orange)** |
| A / CNAME | `*.live` | your LB / node | **Proxied (orange)** |

Universal SSL automatically covers `live.yourdomain.com` and one wildcard level `*.live.yourdomain.com` — auto-renewed, zero work.

---

## 2. Origin certificate (Cloudflare ⇄ node)

The edge cert covers browser ⇄ Cloudflare. The **origin leg** still needs encryption. Use a **Cloudflare Origin CA certificate** — free, 15 years, trusted only by Cloudflare (perfect, since only Cloudflare talks to your nodes).

1. **SSL/TLS → Origin Server → Create Certificate**.
2. Cover `live.yourdomain.com` and `*.live.yourdomain.com`.
3. Save the cert + key on **every node** and point Bun at them:

```bash
# on each node
CF_ORIGIN_CERT=/etc/kproxy/origin.pem
CF_ORIGIN_KEY=/etc/kproxy/origin.key
```

`Bun.serve` terminates this directly — no nginx. Set **SSL/TLS mode to "Full (strict)"** in the Cloudflare dashboard.

> **Alternative — no cert, no open port:** run [`cloudflared`](https://developers.cloudflare.com/cloudflare-tunnel/) on each node. The origin needs no public IP and no certificate; the tunnel connects out to Cloudflare. This also satisfies origin lockdown automatically.

---

## 3. Lock origins to Cloudflare

If your nodes have public IPs, anyone who finds them can bypass the edge (WAF, LB, DDoS). Prevent it:

- **Firewall** each node to allow `:443` only from the [Cloudflare IP ranges](https://www.cloudflare.com/ips/), **or**
- use **`cloudflared`** (no public origin at all), and
- enable **Authenticated Origin Pulls** (mTLS from Cloudflare) for defense in depth.

Restore the real client IP from the `CF-Connecting-IP` header (kproxy reads this) instead of the socket address.

---

## 4. Load Balancer (spread traffic across nodes)

The Load Balancer is what makes the edge highly available and lets you "just add a node."

1. **Traffic → Load Balancing → Create**.
2. Create an **origin pool** containing every kproxy node (by IP or per-node hostname).
3. Add a **health check** (HTTP `GET /health`).
4. Attach the LB to your hostname (`live.yourdomain.com` and the wildcard).

```
client ──▶ Cloudflare LB ──┬─▶ kproxy-1  (healthy)
                           ├─▶ kproxy-2  (healthy)
                           └─▶ kproxy-3  (drained — failed health check)
```

Adding a node = add it to the pool. Removing one = the health check drains it. Cross-node routing to agents is handled by kproxy's gossip mesh, so you do **not** need session affinity (though you may enable it to reduce cross-node hops).

> Cloudflare Load Balancing is a paid add-on and has plan limits (origins per pool, proxied ports). It is **not** built to stream large files — see [R2](#6-r2-for-large-files-optional).

---

## 5. Cloudflare for SaaS — customer custom domains

When a customer wants `app.theirdomain.com` to point at their tunnel, kproxy registers it as a **Custom Hostname** and Cloudflare issues + renews the certificate for it on your edge.

### Server config
```bash
CF_API_TOKEN=...                         # token with "SSL and Certificates: Edit" on the zone
CF_ZONE_ID=...                           # the zone that owns the fallback origin
CF_SAAS_FALLBACK_HOSTNAME=ssl.live.yourdomain.com   # what customers CNAME to
```

Create the API token under **My Profile → API Tokens** with **SSL and Certificates: Edit** (and **Zone: Read**) scoped to your zone.

### Customer instructions (give them this)
```
Add ONE DNS record at your DNS provider:

    app.theirdomain.com   CNAME   ssl.live.yourdomain.com

Set it to "DNS only" (grey cloud). Do NOT enable the Cloudflare proxy (orange)
on this record.
```

> **Why grey cloud:** if the customer proxies (orange) a record that points at *your* proxied hostname without Cloudflare-for-SaaS handling it, Cloudflare returns **Error 1014 (CNAME Cross-User Banned)**. With grey cloud, traffic goes straight to *your* edge, and your Custom Hostname cert serves their domain. Bonus: the customer doesn't even need to be a Cloudflare user.

### Flow
```
1. Customer registers app.theirdomain.com in kproxy
2. kproxy → Cloudflare API: create custom hostname            (cloudflareService.ts)
3. Customer adds the CNAME (DNS only)
4. kproxy polls until Cloudflare reports ssl.status = active
5. Browser → app.theirdomain.com → your edge (valid cert) → LB → kproxy → agent
```

---

## 6. R2 for large files (optional)

kproxy carries APIs and small payloads, not bulk files. Send large uploads/downloads **directly to Cloudflare R2** with presigned URLs so they never transit the tunnel or the Load Balancer.

1. **R2 → Create bucket**.
2. Create an **R2 API token** (S3-compatible) and configure your app to mint presigned `PUT`/`GET` URLs.
3. Clients upload/download straight to R2; kproxy only issues the URL.

```
Upload:   client ──presigned PUT──▶ R2
Download: client ──presigned GET──▶ R2
```

---

## Verify

```bash
# Edge cert (browser ⇄ Cloudflare)
curl -I https://live.yourdomain.com/health        # HTTP/2 200

# Origin is reachable only via Cloudflare (direct hit should fail/refuse)
curl -I https://<node-ip>/health --resolve live.yourdomain.com:443:<node-ip>

# Load Balancer is steering across the pool
#   Cloudflare dashboard → Load Balancing → Analytics

# Custom hostname status
#   Cloudflare dashboard → SSL/TLS → Custom Hostnames  (or via API)
```

---

## Security notes
- Scope the API token to **one zone**, **SSL and Certificates: Edit** only. Never commit it.
- Keep SSL/TLS mode at **Full (strict)** (or use `cloudflared`).
- Always lock origins to Cloudflare IPs or use a Tunnel — the orange cloud is decorative if the origin is reachable directly.

---

## Next steps
- [Environment Variables](./environment.md) — all configuration options
- [Multi-Server Deployment](../deployment/multi-server.md) — the gossip mesh and scaling
- [MongoDB Setup](./mongodb.md) — cold-state database
