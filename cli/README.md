# kproxy CLI

Expose local services (HTTP, raw TCP, Docker Swarm, Kubernetes) to the public internet
through a secure reverse proxy — like ngrok, for the KProxy network.

## Install

```bash
npm install -g kproxy
# or run without installing
npx kproxy http 3000
```

A self-contained binary (no Node required) can be built with `npm run bundle`.

## Quick start

```bash
kproxy login                     # authenticate (opens your dashboard to create an API key)
kproxy http 3000                 # expose http://localhost:3000 over HTTPS
kproxy http 8080 --inspect       # …with a local request inspector at http://127.0.0.1:4040
kproxy tcp 22 --domain ssh       # expose SSH over a raw TCP tunnel
kproxy list                      # list your active tunnels
```

## Commands

| Command | Description |
| --- | --- |
| `kproxy http <port>` | Expose a local HTTP service |
| `kproxy tcp <port>` | Expose a local TCP service (SSH, databases, …) |
| `kproxy connect` | Legacy omnibus (`--port`, `--tcp`, `--docker-service`, `--k8s-service`) |
| `kproxy login` / `logout` | Manage authentication |
| `kproxy whoami` | Show the current auth context |
| `kproxy config` | Show or set stored config (`--server`, `--auth`, `--org`, `--clear`) |
| `kproxy list` (`ls`) | List active tunnels |
| `kproxy disconnect <domain>` (`rm`) | Disconnect a tunnel |
| `kproxy org list\|create\|use` | Manage organizations |
| `kproxy apikey list\|create\|revoke` | Manage API keys |
| `kproxy domain register\|status\|verify\|list` | Manage custom domains |
| `kproxy doctor` | Diagnose environment + connectivity |
| `kproxy completion <bash\|zsh\|fish>` | Shell completion script |

Run `kproxy <command> --help` for full options.

## Tunnel options

```
-d, --domain <subdomain>   request a specific subdomain
-H, --host <host>          local host to forward to (default: localhost)
--force-new                force a new subdomain
--restrict                 allowlist mode
--allow-ip <ips>           comma-separated IPs/CIDRs to allow
--block-ip <ips>           comma-separated IPs/CIDRs to block
--retries <n>              max reconnect attempts (default: unlimited)
--inspect                  open the local request inspector (http only)
--inspect-port <port>      inspector port (default: 4040)
```

## Global flags

Available on every command (pass them after the command, e.g. `kproxy list --json`):

```
--server <url>   server URL          --json       machine-readable JSON output
--auth <key>     API key             -q, --quiet  suppress non-essential output
--org <id>       organization id     --verbose    verbose output
                                      --no-color   disable colors
```

## Configuration & environment

Config is stored at `~/.kproxy/config.json` (mode `0600`). Resolution order for every
setting: **flag → env → stored config → default**.

| Env | Purpose |
| --- | --- |
| `KPROXY_SERVER` | default server URL |
| `KPROXY_AUTH` | API key |
| `KPROXY_ORG` | organization id |
| `KPROXY_DASHBOARD` | dashboard URL used by `kproxy login` |

## Development

```bash
npm install
npm run dev -- http 3000   # run from source
npm run typecheck          # strict TypeScript
npm test                   # vitest
npm run build              # bundle to dist/index.js
npm run bundle             # standalone binary (bin/kproxy-standalone)
```
