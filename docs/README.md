# kproxy Documentation

kproxy is a horizontally-scalable reverse proxy for exposing local services to the internet — no single point of failure, scale by adding nodes, fronted by Cloudflare for TLS and load balancing.

## Start here
- [Architecture Overview](./getting-started/architecture.md) — the flow, gossip routing, TLS model, R2 for large files
- [Quick Start](./getting-started/quick-start.md) — expose a local service in minutes

## Deployment
- [Multi-Server Deployment](./deployment/multi-server.md) — the gossip mesh, HA, scaling
- [Self-Hosting Guide](./deployment/self-hosting.md) — deploy your own node
- [Ansible Deployment](./deployment/ansible.md) — automated configuration
- [Docker Deployment](./deployment/docker.md) — container-based deployment

## Configuration
- [Cloudflare Setup](./configuration/cloudflare.md) — orange proxy, Load Balancer, Origin CA, Cloudflare for SaaS, R2
- [Environment Variables](./configuration/environment.md) — all configuration options
- [MongoDB Setup](./configuration/mongodb.md) — cold/durable state
- [KOOMPI ID OAuth Setup](./configuration/oauth.md) — dashboard authentication

## CLI reference
- [CLI Installation](./cli/installation.md)
- [CLI Commands](./cli/commands.md) — HTTP, TCP, domains

## How TLS works (no Certbot)
- **Your subdomains** (`*.live.yourdomain.com`) → Cloudflare **Universal SSL**, automatic.
- **Customer custom domains** → **Cloudflare for SaaS** (Custom Hostnames); customers CNAME **DNS-only** (grey cloud).
- **Cloudflare ⇄ node** → one **Origin CA** cert per node (or `cloudflared`, zero certs).

There is no Let's Encrypt, Certbot, nginx, or certificate syncing.

## Features
- **HTTP/HTTPS tunnels** — expose web apps and APIs; TLS handled at the Cloudflare edge
- **TCP tunnels** — databases, SSH, custom protocols
- **Custom domains** — Cloudflare-for-SaaS Custom Hostnames (DNS-only CNAME)
- **Gossip routing** — in-memory, no Redis, no single point of failure
- **Large files via R2/S3** — presigned URLs; big payloads bypass the tunnel entirely

## Security
- Rate limiting, IP allowlists, connection logging
- API keys (`kproxy_…`; legacy `jrok_…` still accepted)
- Authenticated gossip mesh (`GOSSIP_SECRET`)
- Origins locked to Cloudflare IPs (or `cloudflared`)

---

## Quick links
| Resource | Description |
|----------|-------------|
| [GitHub Repository](https://github.com/koompi/jrok) | Source code and issues |
| [KOOMPI ID](https://dash.koompi.org) | OAuth credentials |
