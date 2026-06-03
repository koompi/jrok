# Deploy a 3-node cluster on DigitalOcean + Cloudflare

A complete, copy-paste runbook to stand up a **3-node kproxy cluster** on DigitalOcean
droplets, fronted by **Cloudflare** (edge TLS + Load Balancer) using **`cloudflared`**
tunnels for ingress, with the in-memory **gossip mesh** over a private network — then
**verify** it actually works end to end.

> **Origin model used here: `cloudflared`.** Each node serves plain **HTTP on `:3000`**
> (the Bun server does not terminate TLS itself), and `cloudflared` provides the public,
> encrypted ingress — no origin certificate to manage, no public `:443` to lock down.
> If you prefer Cloudflare's "Full (strict)" with a Cloudflare Origin CA cert on the node,
> that requires adding native TLS to `Bun.serve` first; it is **not** wired today.

---

## Topology

```
                        ┌──────────────────────────────────────┐
   Browsers / API  ───▶ │  CLOUDFLARE EDGE                       │  TLS: browser ⇄ Cloudflare
   kproxy CLI agents    │  • Universal SSL  (live + *.live)      │  (automatic)
   (wss /ws/agent)      │  • Load Balancer  (origin pool)        │
                        │  • Cloudflare for SaaS (custom domains)│
                        └───────────────┬──────────────────────-┘
                          cloudflared tunnels (outbound from each node — no inbound 443)
            ┌───────────────────────────┼───────────────────────────┐
            ▼                           ▼                           ▼
     ┌─────────────┐  gossip /_gossip ┌─────────────┐  gossip   ┌─────────────┐
     │  kproxy-1   │◀────────────────▶│  kproxy-2   │◀─────────▶│  kproxy-3   │
     │ HTTP :3000  │  PRIVATE VPC     │ HTTP :3000  │  :3000     │ HTTP :3000  │
     └─────────────┘  (10.x, never    └─────────────┘            └─────────────┘
            │           via Cloudflare)
            └────────────────────────── shared ──────────────────────────────┐
                                         ▼                                     ▼
                                   ┌───────────┐                       (TCP tunnels go
                                   │  MongoDB  │  cold state only       DIRECT to a node's
                                   │  (Atlas)  │  (off the hot path)    public IP:port —
                                   └───────────┘                        not through Cloudflare)
```

- **HTTP/WebSocket tunnels** ride Cloudflare → `cloudflared` → `localhost:3000`.
- **Gossip + cross-node forwarding** ride the **private VPC** (`VPS_HOST` = private IP, port 3000). Never through Cloudflare.
- **Raw TCP tunnels** connect **directly to a node's public IP** on its allocated port range (Cloudflare does not proxy arbitrary TCP without Spectrum).
- **MongoDB** holds only cold state; gossip is the hot path.

---

## Prerequisites

- A domain on **Cloudflare** (e.g. `example.com`), nameservers already pointed at Cloudflare.
- A **MongoDB** the nodes share — **MongoDB Atlas** (free M0 is fine for a test) recommended.
- A **KOOMPI OAuth app** (`dash.koompi.org`) for dashboard login — client id/secret + redirect URI. *(Required even if you only test via API key: production boot checks that the vars are present.)*
- A **Cloudflare API token** scoped to the zone with **SSL and Certificates: Edit** + **Zone: Read** (for Cloudflare-for-SaaS custom domains).
- Local tools: `doctl` or the DO console, `ssh`, `ansible`, and the kproxy repo checked out.
- The **Cloudflare Load Balancer** add-on enabled on your account (it is paid). *A free alternative that needs no LB add-on is noted in Step 6.*

---

## Step 1 — Provision 3 droplets on a DigitalOcean VPC

Create one **VPC** (private network) and 3 droplets in the **same region** so they share a private subnet.

```bash
# Create a VPC (or reuse the region default)
doctl vpcs create --name kproxy-net --region sgp1 --ip-range 10.110.0.0/24

# Create 3 droplets in that VPC
for i in 1 2 3; do
  doctl compute droplet create kproxy-$i \
    --region sgp1 --size s-2vcpu-2gb --image ubuntu-24-04-x64 \
    --vpc-uuid <VPC_UUID> --ssh-keys <YOUR_SSH_KEY_ID> --wait
done

doctl compute droplet list --format Name,PublicIPv4,PrivateIPv4
```

Record each node's **public** and **private** IPv4. You'll use:
- **private IP** for `vps_host` (gossip/mesh),
- **public IP** for SSH and for raw-TCP tunnels.

*(The repo also ships `kproxy.tf` (OpenTofu/Terraform) that creates N droplets — you can use it instead, then read the IPs from `tofu output`.)*

---

## Step 2 — MongoDB (shared cold state)

Create a **MongoDB Atlas** cluster, add a database user, and allow access from your droplet
public IPs (or `0.0.0.0/0` for a quick test). Grab the connection string:

```
mongodb+srv://USER:PASS@cluster0.xxxx.mongodb.net/kproxy?retryWrites=true&w=majority
```

All three nodes use the **same** `MONGODB_URI`. The DB name (`kproxy`) is created on first write.

---

## Step 3 — Cloudflare DNS, API token, and for-SaaS

In the Cloudflare dashboard for `example.com`:

1. **DNS** — create the platform hostnames (these will attach to the Load Balancer in Step 7), **Proxied (orange)**:

   | Type | Name   | Proxy            |
   |------|--------|------------------|
   | A/CNAME | `live`   | **Proxied (orange)** |
   | A/CNAME | `*.live` | **Proxied (orange)** |

   Universal SSL automatically covers `live.example.com` and one wildcard level `*.live.example.com`.

2. **API token** — **My Profile → API Tokens → Create** with **Zone → SSL and Certificates → Edit** and **Zone → Zone → Read**, scoped to this zone. Save as `CF_API_TOKEN`. Note your **Zone ID** (`CF_ZONE_ID`) from the zone overview.

3. **Cloudflare for SaaS** — note the fallback hostname customers will CNAME to, e.g. `CF_SAAS_FALLBACK_HOSTNAME=ssl.live.example.com`.

---

## Step 4 — Per-node configuration (ansible inventory)

Edit `ansible/inventory.ini`. Set **`vps_host` to each node's PRIVATE IP**, give each a **unique
`vps_id`** and a **non-overlapping TCP port range**, and put the shared secrets in the group vars:

```ini
[jrok_servers]
kproxy-1 ansible_host=<PUB_IP_1> ansible_user=root vps_id=kproxy-1 vps_host=<PRIV_IP_1> vps_region=ap-southeast tcp_port_min=10000 tcp_port_max=13333
kproxy-2 ansible_host=<PUB_IP_2> ansible_user=root vps_id=kproxy-2 vps_host=<PRIV_IP_2> vps_region=ap-southeast tcp_port_min=13334 tcp_port_max=16666
kproxy-3 ansible_host=<PUB_IP_3> ansible_user=root vps_id=kproxy-3 vps_host=<PRIV_IP_3> vps_region=ap-southeast tcp_port_min=16667 tcp_port_max=20000

[jrok_servers:vars]
domain_name=live.example.com
cf_saas_fallback_hostname=ssl.live.example.com
api_key=<RANDOM_32B_HEX>            # openssl rand -hex 32  (NOT the default)
repo_url=https://github.com/koompi/jrok.git
repo_branch=main
app_dir=/opt/kproxy
ansible_ssh_private_key_file=~/.ssh/id_rsa
```

The remaining secrets are read from your **shell environment** by the playbook — export them before deploying:

```bash
export MONGODB_URI='mongodb+srv://USER:PASS@cluster0.xxxx.mongodb.net/kproxy?retryWrites=true&w=majority'
export JWT_SECRET="$(openssl rand -base64 48)"        # >= 32 chars — required in prod
export GOSSIP_SECRET="$(openssl rand -base64 32)"     # >= 16 chars — SAME on every node
export CF_API_TOKEN='...'                             # from Step 3
export CF_ZONE_ID='...'
export CF_SAAS_FALLBACK_HOSTNAME='ssl.live.example.com'
export KOOMPI_CLIENT_ID='...'                         # from your KOOMPI OAuth app
export KOOMPI_CLIENT_SECRET='...'
export KOOMPI_REDIRECT_URI='https://app.example.com/callback'   # your dashboard callback
export DASHBOARD_URL='https://app.example.com'        # where the dashboard is hosted (Step 8)
```

> **Boot-required in production** (the node exits on startup if any is missing/weak):
> `MONGODB_URI`, `JWT_SECRET` (≥32), `BASE_DOMAIN` (= `domain_name`), `KOOMPI_CLIENT_ID`,
> `KOOMPI_CLIENT_SECRET`, `GOSSIP_SECRET` (≥16), and a non-default `API_KEY`.

---

## Step 5 — Deploy the kproxy server to all 3 nodes

From `ansible/`:

```bash
cd ansible
ansible all -i inventory.ini -m ping            # connectivity
ansible-playbook -i inventory.ini playbook.yml  # installs Bun + the kproxy systemd service
```

This installs the runtime and starts a `kproxy` systemd service on each node (HTTP on `:3000`),
and opens UFW for `3000` + each node's TCP range. Check one node:

```bash
ssh root@<PUB_IP_1> 'systemctl status kproxy --no-pager; curl -s localhost:3000/health'
# -> {"success":true,"message":"Server is running","serverId":"kproxy-1"}
```

---

## Step 6 — `cloudflared` ingress on each node

`cloudflared` gives each node public HTTPS ingress with no inbound port. **Per node:**

```bash
# install
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb && dpkg -i cf.deb
cloudflared tunnel login                                  # opens a browser; authorizes the zone
cloudflared tunnel create kproxy-1                        # unique name per node -> prints a Tunnel ID
```

Create `/etc/cloudflared/config.yml` (use this node's tunnel id):

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: origin-1.example.com     # this node's LB-origin hostname (per node: origin-2, origin-3)
    service: http://localhost:3000
  - service: http_status:404
```

Route the per-node origin hostname through the tunnel and run it as a service:

```bash
cloudflared tunnel route dns kproxy-1 origin-1.example.com
cloudflared service install
systemctl enable --now cloudflared
cloudflared tunnel info kproxy-1        # should show 1+ active connections
```

> **Simpler free alternative (no Load Balancer add-on):** create **one** named tunnel and run it
> on **all three** nodes (same `<TUNNEL_ID>` + credentials), with ingress `live.example.com` and
> `*.live.example.com` → `http://localhost:3000`. Cloudflare load-balances across the connected
> replicas and drains dead ones automatically. If you use this, **skip Step 7** and just
> `cloudflared tunnel route dns` the `live`/`*.live` hostnames. The rest of this guide is identical.

---

## Step 7 — Cloudflare Load Balancer

**Traffic → Load Balancing → Create:**

1. **Monitor (health check):** HTTP `GET /health`, expect `200`, interval 15s.
2. **Origin pool** `kproxy-pool` with 3 origins → `origin-1.example.com`, `origin-2.example.com`, `origin-3.example.com` (the per-node tunnel hostnames from Step 6).
3. **Load balancer hostname:** attach to `live.example.com`. Add a second LB (or hostname) for `*.live.example.com` so wildcard subdomains are balanced too.
4. Session affinity: **off** (kproxy's gossip mesh routes cross-node; affinity only reduces hops).

```
client ──▶ Cloudflare LB ──┬─▶ origin-1 (cloudflared → kproxy-1)   healthy
                           ├─▶ origin-2 (cloudflared → kproxy-2)   healthy
                           └─▶ origin-3 (cloudflared → kproxy-3)   drained on /health fail
```

---

## Step 8 — Dashboard (for login) — optional for the cluster test

The React dashboard is a separate static app. For a quick cluster test you can **skip it** and
authenticate the CLI with an API key (Step 9). To enable browser login + the device flow:

```bash
cd dashboard
VITE_API_URL=https://live.example.com npm run build      # outputs dist/
```

Host `dist/` on **Cloudflare Pages** (or any static host) at `app.example.com`, then make sure
`DASHBOARD_URL` and `KOOMPI_REDIRECT_URI` (Step 4) match that origin, and add `app.example.com`
to the KOOMPI OAuth app's allowed redirect URIs.

---

## Step 9 — Hardening the firewall (important)

Because ingress is via `cloudflared`, **port 3000 should NOT be open to the public** — only to
the private VPC (for gossip) and localhost (for cloudflared). On each node:

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp
ufw allow from 10.110.0.0/24 to any port 3000 proto tcp     # gossip/mesh on the VPC only
ufw allow 10000:20000/tcp                                   # raw-TCP tunnel range (public)
ufw --force enable
```

*(Skip the TCP range rule if you're not testing raw TCP tunnels.)*

---

## ✅ Verify the cluster

Run these in order. Each shows the expected result.

### 1. Every node is up
```bash
for ip in <PUB_IP_1> <PUB_IP_2> <PUB_IP_3>; do
  ssh root@$ip 'systemctl is-active kproxy; curl -s localhost:3000/health'
done
# active  {"success":true,...,"serverId":"kproxy-N"}   (x3, distinct serverIds)
```

### 2. The gossip mesh has formed
```bash
ssh root@<PUB_IP_1> 'journalctl -u kproxy --no-pager | grep -i gossip | tail'
# look for:  🕸️  gossip: connected to peer kproxy-2 (10.110.0.x:3000)
#            🕸️  gossip: connected to peer kproxy-3 (...)
```
On a 3-node cluster each node should connect to the peers with a **higher** `vps_id`
("lower id dials"), so the mesh has 3 connections total. Then check cluster state via the edge:
```bash
curl -s https://live.example.com/cluster/stats | jq
# -> servers: 3 (healthy), plus agent/tunnel counts
```

### 3. Edge + Load Balancer are serving
```bash
curl -sI https://live.example.com/health      # HTTP/2 200  (via Cloudflare → LB → a node)
# Hit it a few times; in Cloudflare → Load Balancing → Analytics you should see all 3 origins healthy.
```

### 4. An HTTP tunnel works (and proves cross-node routing)
On your laptop, run a local service and a tunnel:
```bash
python3 -m http.server 3000 &                 # something on :3000
kproxy --auth <API_KEY> http 3000             # or: kproxy login; kproxy http 3000
# prints:  https://<random>.live.example.com
```
The agent lands on **one** node (its home node), but the **LB sends requests to any node**. Hit the
URL several times — every request must succeed, which proves nodes forward over the gossip mesh to
the home node:
```bash
for i in $(seq 1 10); do curl -s -o /dev/null -w "%{http_code}\n" https://<random>.live.example.com/; done
# ten 200s
```

### 5. Failover (kill the home node)
Find which node the agent is on (the `kproxy` log on that node shows the agent register), then:
```bash
ssh root@<home-node> 'systemctl stop kproxy'
# Within a few seconds: the CLI logs "reconnecting", reconnects through the LB to a surviving node,
# and the tunnel URL keeps returning 200. Cloudflare drains the stopped origin on the next health check.
ssh root@<home-node> 'systemctl start kproxy'   # it rejoins the mesh automatically
```

### 6. A raw TCP tunnel (direct to the node, not via Cloudflare)
```bash
kproxy --auth <API_KEY> tcp 22
# prints a host:port. NOTE: connect to the NODE'S PUBLIC IP on that port (Cloudflare does not
# proxy raw TCP without Spectrum):
ssh -p <port> user@<home-node-public-ip>
```

### 7. A customer custom domain (Cloudflare for SaaS)
```bash
kproxy --auth <API_KEY> domain register app.yourtest.com --email you@example.com
# add at app.yourtest.com's DNS:   app.yourtest.com  CNAME  ssl.live.example.com   (DNS only / grey cloud)
kproxy --auth <API_KEY> domain verify app.yourtest.com
curl -sI https://app.yourtest.com/health      # 200 with a valid cert once Cloudflare provisions it
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Node exits immediately on boot | A required prod env is missing/weak. `journalctl -u kproxy` prints which (`MONGODB_URI`, `JWT_SECRET≥32`, `BASE_DOMAIN`, `KOOMPI_CLIENT_ID/SECRET`, `GOSSIP_SECRET≥16`, non-default `API_KEY`). |
| `/cluster/stats` shows 1 server | Heartbeats aren't shared — check all nodes use the **same `MONGODB_URI`**. |
| Gossip never connects (`peers: 0`) | `VPS_HOST` must be the **private IP** and port 3000 reachable node-to-node on the VPC (UFW rule in Step 9). Confirm with `nc -vz <peer-private-ip> 3000`. |
| `GOSSIP_SECRET` mismatch | All nodes must share the exact same value, or `/_gossip` returns 403 and the mesh won't form. |
| Custom domain stuck pending | The CNAME must be **DNS only (grey cloud)**. Orange-clouding it triggers Cloudflare **Error 1014**. |
| LB origin unhealthy | `cloudflared tunnel info <name>` shows connections; the health check path is `/health`; the per-node origin hostname is routed through that node's tunnel. |
| TCP tunnel won't connect | Connect to the **node's public IP** (not `live.example.com`) on the allocated port, and open that port range in UFW. Cloudflare-fronted TCP needs **Spectrum**. |

---

## What this guide intentionally does not cover

- **Origin "Full (strict)" with a Cloudflare Origin CA cert** — the Bun server does not terminate
  TLS today, so this path needs a small code change first; `cloudflared` is used instead.
- **Cloudflare Spectrum** for TCP tunnels behind the edge — raw TCP here is direct-to-node.
- **R2 / large payloads** — see [Cloudflare Setup](../configuration/cloudflare.md#6-r2-for-large-files-optional).

## See also
- [Architecture](../getting-started/architecture.md) · [Cloudflare Setup](../configuration/cloudflare.md) · [Multi-Server](./multi-server.md) · [Environment Variables](../configuration/environment.md)
