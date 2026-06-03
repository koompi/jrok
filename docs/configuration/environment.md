# Environment Variables

Complete reference for all kproxy configuration options.

## Required

### Database

| Variable | Description | Example |
|----------|-------------|---------|
| `MONGODB_URI` | MongoDB connection string (cold/durable state) | `mongodb+srv://user:pass@cluster.mongodb.net/kproxy` |
| `MONGO_DB_NAME` | Database name. **Defaults to `kproxy`.** Set to `jrok` if migrating an existing deployment, or migrate the data. | `kproxy` |

### Authentication

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | Secret for JWT signing (min 64 chars) | `openssl rand -base64 64` |
| `API_KEY` | Optional master/admin API key for privileged endpoints (e.g. `/admin/cluster/stats`) | `openssl rand -hex 32` |

### Domain

| Variable | Description | Example |
|----------|-------------|---------|
| `BASE_DOMAIN` | Base domain for generated app subdomains | `live.example.com` |

### OAuth (for dashboard login)

| Variable | Description | Example |
|----------|-------------|---------|
| `KOOMPI_CLIENT_ID` | OAuth client ID | `abc123...` |
| `KOOMPI_CLIENT_SECRET` | OAuth client secret | `secret456...` |
| `KOOMPI_REDIRECT_URI` | OAuth callback URL | `https://live.example.com/auth/callback` |

---

## Multi-node (gossip routing + cross-node forwarding)

| Variable | Description | Default |
|----------|-------------|---------|
| `VPS_ID` | **Unique** node id. Also the gossip node id and the "lower id dials" key. | auto-generated |
| `VPS_HOST` | Address other nodes use to reach this one **directly** (not via Cloudflare) for `/_gossip` and cross-node forwarding. | `localhost` |
| `VPS_NAME` | Human-friendly node label (shown in cluster stats / logs). | `VPS_ID` |
| `VPS_REGION` | Optional region tag for the node (informational). | none |
| `HOSTNAME` | Host machine name used in heartbeats / diagnostics. | OS hostname |
| `GOSSIP_SECRET` | Shared secret guarding the gossip mesh — **set the same value on every node**. Without it, any host that reaches `/_gossip` can poison routing. | none (unauthenticated + warns) |
| `PORT` | HTTP server port | `3000` |

> Set `VPS_ID`, `VPS_HOST`, and `GOSSIP_SECRET` on **every** node in production.

---

## Cloudflare for SaaS (customer custom domains)

| Variable | Description | Example |
|----------|-------------|---------|
| `CF_API_TOKEN` | Token with **SSL and Certificates: Edit** on the zone | `...` |
| `CF_ZONE_ID` | Zone that owns the fallback origin | `...` |
| `CF_SAAS_FALLBACK_HOSTNAME` | Hostname customers CNAME to (DNS only). Defaults to `BASE_DOMAIN`. | `ssl.live.example.com` |

The Cloudflare ⇄ origin TLS leg is configured at the process/host level, not in kproxy app config — see [Cloudflare Setup](./cloudflare.md) (Origin CA cert or `cloudflared`).

---

## Optional

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `DASHBOARD_URL` | Dashboard URL for redirects | `http://localhost:5173` |
| `ALLOWED_ORIGINS` | CORS allowed origins (comma-separated) | `http://localhost:5173` |

### TCP tunnels & connection limits

| Variable | Description | Default |
|----------|-------------|---------|
| `TCP_PORT_MIN` | Low end of the port range allocated to TCP tunnels | `10000` |
| `TCP_PORT_MAX` | High end of the TCP tunnel port range | `20000` |
| `MAX_AGENT_CONNECTIONS` | Max concurrent agent WebSocket tunnels per node | unlimited |
| `MAX_CLIENT_CONNECTIONS` | Max concurrent client connections per node | unlimited |
| `MAX_CONNECTIONS_PER_IP` | Max concurrent connections from a single source IP | unlimited |

> Open the `TCP_PORT_MIN`–`TCP_PORT_MAX` range on the firewall for TCP tunnels. Cloudflare's
> Load Balancer fronts HTTP/HTTPS; raw TCP tunnels connect to the node directly on these ports.

### Notifications

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for alerts | none |
| `TELEGRAM_CHAT_ID` | Telegram chat id for alerts | none |

### Removed / no longer used

These variables were part of the old nginx + Certbot/Let's Encrypt + MongoDB cert-sync design and are **no longer read**:

| Variable | Why it's gone |
|----------|---------------|
| `NGINX_PATH` | kproxy no longer runs or configures nginx — Cloudflare is the edge. |
| `CERT_SYNC_API_KEY` | The MongoDB certificate-sync service was removed; Cloudflare issues + stores certs. |
| `CLOUDFLARE_TOKEN` (Certbot) | The DNS-01/Certbot token is gone. Custom-hostname issuance uses `CF_API_TOKEN` instead. |
| `VPS_USER`, `VPS_PORT` | SSH/cert-sync plumbing that no longer exists. |

> **Backward compatibility:** the legacy `JROK_*` env vars are still accepted as fallbacks for
> the new `KPROXY_*` CLI vars; API keys with the `jrok_` prefix are still accepted alongside
> `kproxy_`; and a legacy `~/.jrok` config is still read.

---

## Example `.env`

```bash
# =============================================================================
# KPROXY ENVIRONMENT CONFIGURATION
# =============================================================================

# --- Database (cold/durable state) ---------------------------------------------
MONGODB_URI=mongodb+srv://kproxy:password@cluster0.xxxxx.mongodb.net/kproxy?retryWrites=true&w=majority
# Existing "jrok" deployments: set MONGO_DB_NAME=jrok or migrate the data.
MONGO_DB_NAME=kproxy

# --- Auth ----------------------------------------------------------------------
JWT_SECRET=your-super-long-secret-at-least-64-characters

# --- Domain --------------------------------------------------------------------
BASE_DOMAIN=live.yourdomain.com

# --- KOOMPI OAuth (dashboard) --------------------------------------------------
KOOMPI_CLIENT_ID=your-client-id
KOOMPI_CLIENT_SECRET=your-client-secret
KOOMPI_REDIRECT_URI=https://live.yourdomain.com/auth/callback

# --- Multi-node (gossip mesh) --------------------------------------------------
VPS_ID=node-a                 # unique per node
VPS_HOST=10.0.0.11            # how peers reach THIS node directly (private/mesh IP)
VPS_NAME=kproxy-sgp1          # optional label
VPS_REGION=sgp1               # optional region tag
GOSSIP_SECRET=shared-secret-set-on-every-node
PORT=3000

# --- Cloudflare for SaaS (custom domains) --------------------------------------
CF_API_TOKEN=your-cf-token
CF_ZONE_ID=your-zone-id
CF_SAAS_FALLBACK_HOSTNAME=ssl.live.yourdomain.com

# --- Server --------------------------------------------------------------------
NODE_ENV=production
DASHBOARD_URL=https://live.yourdomain.com
ALLOWED_ORIGINS=https://live.yourdomain.com
# API_KEY=admin-master-key-for-privileged-endpoints   # optional

# --- TCP tunnels & limits (optional) -------------------------------------------
# TCP_PORT_MIN=10000
# TCP_PORT_MAX=20000
# MAX_AGENT_CONNECTIONS=10000
# MAX_CLIENT_CONNECTIONS=20000
# MAX_CONNECTIONS_PER_IP=100

# --- Notifications (optional) --------------------------------------------------
# TELEGRAM_BOT_TOKEN=...
# TELEGRAM_CHAT_ID=...
```

---

## Generating secrets

```bash
openssl rand -base64 64     # JWT_SECRET
openssl rand -hex 32        # GOSSIP_SECRET
```

---

## Loading & systemd

```ini
# /etc/systemd/system/kproxy.service
[Service]
Environment=NODE_ENV=production
EnvironmentFile=/etc/kproxy/environment
ExecStart=/usr/local/bin/bun run /opt/kproxy/src/index.ts
```

Required variables are validated on startup; missing ones cause the server to exit with an error.

---

## Next steps
- [Cloudflare Setup](./cloudflare.md) — orange proxy, Load Balancer, Origin CA, Custom Hostnames
- [MongoDB Setup](./mongodb.md) — cold-state database
- [Multi-Server Deployment](../deployment/multi-server.md) — gossip mesh and scaling
