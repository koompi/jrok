# Quick Start

Expose a local service to the internet in a couple of minutes with the `kproxy` CLI.

## 1. Install the CLI

```bash
npm install -g kproxy
```

Verify: `kproxy --version`.

## 2. Authenticate

`kproxy login` opens your browser, you approve, and the CLI stores a scoped API key in
`~/.kproxy/config.json`. Point it at your server with `--server` (the value is remembered):

```bash
# Self-hosted cluster
kproxy login --server https://live.example.com

# Managed (KOOMPI Cloud)
kproxy login --server https://tunnel.koompi.cloud
```

> Prefer non-interactive / CI? Skip the browser with an API key:
> `kproxy config --server https://live.example.com --auth kproxy_xxx`
> (or set `KPROXY_SERVER` / `KPROXY_AUTH`).

## 3. Expose your service

```bash
kproxy http 3000
```

```
✓ Connected to server

  https://crimson-fox-1a2b.live.example.com
  → localhost:3000

Press Ctrl+C to stop.
```

That URL is public and TLS-terminated by Cloudflare. In a cluster, it works no matter which
node a request lands on — the gossip mesh routes it to the node holding your tunnel.

## Common use cases

### A dev server
```bash
kproxy http 3000        # React/Vue/Next
kproxy http 8000        # Django/Flask
```

### A specific subdomain
```bash
kproxy http 3000 --domain myapp
# → https://myapp.live.example.com   (a suffix is added if it's taken; use --force-new to insist)
```

### Inspect requests locally (ngrok-style)
```bash
kproxy http 8080 --inspect
# → also opens http://127.0.0.1:4040 to view/replay tunneled requests
```

### Raw TCP (SSH, databases)
```bash
kproxy tcp 22
```
TCP prints a `host:port`. **Connect to the node's public IP** on that port — raw TCP goes
**directly to the node**, not through Cloudflare:
```bash
ssh -p <port> user@<node-public-ip>
```

### A custom domain
```bash
kproxy domain register app.yoursite.com --email you@yoursite.com
# add at your DNS:  app.yoursite.com  CNAME  ssl.live.example.com   (DNS only / grey cloud)
kproxy domain verify app.yoursite.com
```

### Manage tunnels
```bash
kproxy list                 # active tunnels        (alias: ls)
kproxy disconnect myapp     # tear one down         (alias: rm)
kproxy whoami               # current server + org
kproxy logout
```

Add `--json` to any command for scriptable output.

## What's next?
- [CLI Commands](../cli/commands.md) — the full command reference
- [Architecture](./architecture.md) — how routing, TLS, and the gossip mesh work
- [Deploy your own cluster](../deployment/digitalocean-cloudflare.md) — 3 nodes on DigitalOcean + Cloudflare
