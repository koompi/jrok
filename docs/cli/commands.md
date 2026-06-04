# CLI Commands Reference

`kproxy <command> [options]`. Run `kproxy <command> --help` for the full options of any command.

## Quick reference

| Command | Description |
| --- | --- |
| `kproxy http <port>` | Expose a local HTTP service |
| `kproxy tcp <port>` | Expose a local TCP service (SSH, databases, …) |
| `kproxy connect` | Omnibus form (`--port`, `--tcp`, `--docker-service`, `--k8s-service`) |
| `kproxy login` / `logout` | Authenticate / sign out |
| `kproxy whoami` | Show the current auth context |
| `kproxy config` | Show or set stored config |
| `kproxy list` (`ls`) | List active tunnels |
| `kproxy disconnect <domain>` (`rm`) | Disconnect a tunnel |
| `kproxy org list\|create\|use` | Organizations |
| `kproxy apikey list\|create\|revoke` | API keys |
| `kproxy domain register\|status\|verify\|list` | Custom domains |
| `kproxy doctor` | Diagnose environment + connectivity |
| `kproxy completion <shell>` | Shell completion script |

## Global flags

Valid on every command (pass them **after** the command, e.g. `kproxy list --json`):

| Flag | Meaning |
| --- | --- |
| `--server <url>` | kproxy server URL |
| `--auth <key>` | API key |
| `--org <id>` | organization id |
| `--json` | machine-readable JSON output |
| `-q, --quiet` | suppress non-essential output |
| `--verbose` | verbose output |
| `--no-color` | disable colored output |

## Tunnels

### `kproxy http <port>`
Expose a local HTTP/HTTPS/WebSocket service.

```bash
kproxy http 3000
kproxy http 3000 --domain myapp          # request a subdomain
kproxy http 8080 --inspect               # local request inspector at 127.0.0.1:4040
kproxy http 3000 --host 0.0.0.0          # forward to a non-localhost address
```

Options: `-d, --domain`, `-H, --host` (default `localhost`), `--force-new`,
`--restrict`, `--allow-ip <ips>`, `--block-ip <ips>`, `--retries <n>`,
`--inspect`, `--inspect-port <port>` (default `4040`).

### `kproxy tcp <port>`
Expose a raw TCP service. The CLI prints a `host:port`; **connect to the node's public IP**
on that port (raw TCP does not go through Cloudflare).

```bash
kproxy tcp 22        # SSH    →  ssh -p <port> user@<node-ip>
kproxy tcp 5432      # Postgres
```

Same access-control options as `http` (`--domain`, `--allow-ip`, `--block-ip`, `--retries`).

### `kproxy connect`
Omnibus form, including Docker Swarm / Kubernetes targets:

```bash
kproxy connect --port 3000
kproxy connect --tcp --port 5432
kproxy connect --domain api --docker-service my-api
kproxy connect --domain app --k8s-service my-svc
```

### Access control
```bash
kproxy http 3000 --allow-ip 203.0.113.4,198.51.100.0/24   # allowlist
kproxy http 3000 --block-ip 203.0.113.7                   # blocklist
kproxy http 3000 --restrict                               # allowlist mode (deny by default)
```

## Auth & config

```bash
kproxy login --server https://live.example.com   # browser device-flow login
kproxy login --token kproxy_xxx                  # non-interactive
kproxy logout
kproxy whoami
kproxy config                                    # show effective config
kproxy config --server https://live.example.com  # set defaults
kproxy config --auth kproxy_xxx
kproxy config --org <org-id>
kproxy config --clear
```

Config lives at `~/.kproxy/config.json` (mode `0600`). Resolution order for every setting:
**flag → `KPROXY_*` env → stored config → default**.

## Organizations & API keys

```bash
kproxy org list
kproxy org create "My Team"        # creates and sets as default
kproxy org use <org-id>

kproxy apikey list
kproxy apikey create "ci-key" --permissions tunnel:create,tunnels:read,tunnels:delete
kproxy apikey revoke <key-id>
```

## Custom domains

```bash
kproxy domain register app.yoursite.com --email you@yoursite.com [--subdomain app]
kproxy domain status   app.yoursite.com    # CNAME + SSL state
kproxy domain verify   app.yoursite.com    # activate once the CNAME resolves
kproxy domain list
```

Add a **DNS-only (grey cloud)** CNAME from your domain to the server's fallback hostname
(shown by `register`/`status`); Cloudflare then issues and renews the certificate.

## Diagnostics

```bash
kproxy doctor                 # node version, server reachability, key validity
kproxy doctor --port 3000     # also check a local port is listening
kproxy completion zsh         # >> ~/.zshrc:  source <(kproxy completion zsh)
```

## Tunnels list / teardown

```bash
kproxy list           # or: ls
kproxy disconnect <domain>    # or: rm <domain>
```
