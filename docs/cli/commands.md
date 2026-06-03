# CLI Commands Reference

Complete reference for all KProxy CLI commands.

## Quick Reference

| Command | Description |
|---------|-------------|
| `kproxy --port 3000` | Expose localhost:3000 (simplest usage) |
| `kproxy --port 5432 --tcp` | Expose TCP service (databases, SSH, etc.) |
| `kproxy connect` | Connect with full options |
| `kproxy list` | List active tunnels |
| `kproxy disconnect` | Disconnect a tunnel |
| `kproxy config` | Manage CLI configuration |
| `kproxy org` | Organization management |
| `kproxy apikey` | API key management |
| `kproxy domain` | Custom domain management |
| `kproxy whoami` | Show current user info |
| `kproxy version` | Show version |
| `kproxy help` | Show help |

---

## Connect Commands

### Quick Connect

The simplest way to expose a local service:

```bash
kproxy --port 3000
```

This will:
1. Prompt for API key if not configured
2. Auto-generate a random subdomain
3. Connect and display the public URL

**Output:**
```
🎲 Generated subdomain: a1b2c3d4
🔌 Connecting to kproxy server...
📍 Domain: a1b2c3d4
🏠 Local Service: localhost:3000

https://live.koompi.cloud

✅ Connected to server!
🌐 Your service is now available at: https://a1b2c3d4.live.koompi.cloud
✨ Connected to kproxy
🆔 Agent ID: aa01ea7c-70ef-403e-8720-6729bfef5d95
```

### Connect with Custom Subdomain

```bash
kproxy --port 3000 --domain myapp
```

Access at: `https://myapp.live.koompi.cloud`

### TCP Tunnel (Databases, SSH, etc.)

Expose raw TCP services like databases:

```bash
kproxy --port 5432 --tcp
```

**Output:**
```
🔌 Creating TCP tunnel...
📍 TCP Port Assigned: 54321
🏠 Local Service: localhost:5432

✅ TCP tunnel established!
🌐 Connect via: tcp://live.koompi.cloud:54321
```

### Force New Subdomain

When you already own a subdomain but want a fresh tunnel:

```bash
kproxy --port 3000 --domain myapp --force-new
```

This creates a new tunnel with a suffix (e.g., `myapp-a7b3`) instead of updating the existing one.

### Connect with All Options

```bash
kproxy connect \
  --server https://live.koompi.cloud \
  --auth kproxy_xxxx \
  --domain myapp \
  --port 3000 \
  --host localhost \
  --force-new          # Optional: force new subdomain
```

### Connect Docker Swarm Service

```bash
kproxy connect --domain api --docker-service my-api-service
```

### Connect Kubernetes Service

```bash
kproxy connect --domain app --k8s-service my-service:8080
```

### Connect Options

| Option | Description | Default |
|--------|-------------|---------|
| `--server` | KProxy server URL | `https://live.koompi.cloud` |
| `--auth` | API key | From config/env |
| `--domain` | Subdomain name | Auto-generated |
| `--port` | Local port | `3000` |
| `--host` | Local host | `localhost` |
| `--tcp` | Create TCP tunnel (for databases, SSH) | `false` |
| `--force-new` | Force new subdomain even if you own existing | `false` |
| `--docker-service` | Docker Swarm service name | - |
| `--k8s-service` | Kubernetes service:port | - |

### Subdomain Conflict Handling

| Scenario | Behavior |
|----------|----------|
| Subdomain available | Assigned as requested |
| Subdomain owned by you | Updates existing tunnel (or use `--force-new`) |
| Subdomain owned by another org | Auto-generates suffix (e.g., `myapp-a7b3`) |

---

## List Command

Show all active tunnels for your account:

```bash
kproxy list
```

**Output:**
```
📋 Active Tunnels:

Domain                                        Local                Status       Created
───────────────────────────────────────────────────────────────────────────────────────────
myapp.live.koompi.cloud                     localhost:3000       ✅ Online    12/18/2025
api.live.koompi.cloud                       localhost:8080       ❌ Offline   12/17/2025
```

---

## Disconnect Command

Disconnect a specific tunnel:

```bash
kproxy disconnect --domain myapp
```

**Output:**
```
✅ Tunnel disconnected: myapp
```

---

## Config Commands

### Show Current Configuration

```bash
kproxy config
```

**Output:**
```
⚙️  Current Configuration:

Server URL:      https://live.koompi.cloud
API Key:         kproxy_abc123def45...
Organization ID: org_xxxxxxxxxxxx
Organization:    My Company

Config file: /home/user/.kproxy/config.json
```

### Set Server URL

```bash
kproxy config --server https://live.yourdomain.com
```

### Set API Key

```bash
kproxy config --auth kproxy_your_api_key_here
```

### Set Default Organization

```bash
kproxy config --org org_xxxxxxxxxxxx
```

### Set Multiple Options

```bash
kproxy config \
  --server https://live.yourdomain.com \
  --auth kproxy_xxxx \
  --org org_xxxx
```

### Clear Configuration

```bash
kproxy config --clear
```

---

## Organization Commands

### List Organizations

```bash
kproxy org list
```

**Output:**
```
📋 Your Organizations:

ID                        Name                      Slug                 Role
─────────────────────────────────────────────────────────────────────────────────────
org_abc123def456          My Company                my-company           owner
org_xyz789ghi012          Client Project            client-project       member
```

### Create Organization

```bash
kproxy org create --name "My New Organization"
```

**Output:**
```
✅ Organization created: My New Organization
🆔 ID: org_abc123def456
🔗 Slug: my-new-organization
💾 Set as default organization
```

### Set Default Organization

```bash
kproxy org use --id org_abc123def456
```

---

## API Key Commands

### List API Keys

```bash
kproxy apikey list --org org_abc123def456
```

**Output:**
```
🔑 API Keys:

ID                        Prefix           Name                 Permissions
─────────────────────────────────────────────────────────────────────────────────────
key_abc123def456          kproxy_abc...      Production Key       tunnel:create, tunnel:read
key_xyz789ghi012          kproxy_xyz...      CI/CD Key            tunnel:create
```

### Create API Key

```bash
kproxy apikey create --org org_abc123def456 --name "My New Key"
```

**Output:**
```
✅ API Key created: My New Key

⚠️  IMPORTANT: Save this key now! It will only be shown once.

🔑 API Key: kproxy_abc123def456789xyz

To use this key:
  kproxy config --auth kproxy_abc123def456789xyz
  # or
  export KPROXY_AUTH=kproxy_abc123def456789xyz
```

### Create Key with Custom Permissions

```bash
kproxy apikey create \
  --org org_abc123def456 \
  --name "Read Only Key" \
  --permissions tunnel:read
```

### Revoke API Key

```bash
kproxy apikey revoke --org org_abc123def456 --id key_abc123def456
```

---

## Domain Commands

Manage custom domains that point to your tunnels.

### Register Custom Domain

Register a custom domain with auto-generated subdomain target:

```bash
kproxy domain register --domain mysite.com
```

**Output:**
```
✅ Custom domain registered: mysite.com

📋 Next Steps:
1. Add CNAME record to your DNS:
   mysite.com → myapp-auto.live.koompi.cloud

2. Wait for DNS propagation (usually 1-10 minutes)

3. Verify and issue SSL certificate:
   kproxy domain verify --domain mysite.com
```

### Register with Specific Subdomain

Target a specific subdomain:

```bash
kproxy domain register --domain mysite.com --subdomain myapp
```

### Verify Domain (CNAME + SSL)

After configuring DNS, verify and issue SSL:

```bash
kproxy domain verify --domain mysite.com
```

**Output (success):**
```
✅ CNAME verified for mysite.com
🔐 SSL certificate issued successfully!
🌐 Your domain is now active: https://mysite.com
```

**Output (pending):**
```
⏳ CNAME not yet verified for mysite.com

Expected CNAME target: myapp.live.koompi.cloud
Current resolution: (not found)

💡 DNS propagation can take up to 48 hours.
   Run this command again once DNS is configured.
```

### Check Domain Status

Check verification status without attempting to issue SSL:

```bash
kproxy domain status --domain mysite.com
```

**Output:**
```
📋 Domain Status: mysite.com

CNAME Target:   myapp.live.koompi.cloud
CNAME Verified: ✅ Yes (verified 2 hours ago)
SSL Status:     ✅ Issued
Subdomain:      myapp
Organization:   My Company
```

### List Custom Domains

```bash
kproxy domain list
```

**Output:**
```
📋 Your Custom Domains:

Domain                  Target Subdomain       CNAME Status    SSL Status
────────────────────────────────────────────────────────────────────────────
mysite.com              myapp                  ✅ Verified     ✅ Issued
api.mycompany.com       api                    ⏳ Pending      ❌ None
staging.example.org     staging-test           ✅ Verified     ✅ Issued
```

### Domain Options

| Option | Description | Required |
|--------|-------------|:--------:|
| `--domain` | The custom domain (e.g., mysite.com) | ✅ |
| `--subdomain` | Target subdomain (auto-generated if not specified) | ❌ |

### Custom Domain Flow

```
┌─────────────────────────────────────────────────────────────┐
│  1. Register Domain                                          │
│     kproxy domain register --domain mysite.com                 │
│                          ↓                                   │
│  2. Configure DNS (at your registrar)                        │
│     mysite.com CNAME → myapp.live.koompi.cloud            │
│                          ↓                                   │
│  3. Verify CNAME & Issue SSL                                 │
│     kproxy domain verify --domain mysite.com                   │
│                          ↓                                   │
│  4. Domain Active! 🎉                                        │
│     https://mysite.com → your tunnel                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Utility Commands

### Whoami

Show current user or API key info:

```bash
kproxy whoami
```

**For API Key:**
```
🔑 Using API Key authentication
Key prefix: kproxy_abc123def...
✅ API Key is valid
📋 Access to 2 organization(s)

Organizations:
  - My Company (my-company)
  - Client Project (client-project)
```

### Version

```bash
kproxy version
```

**Output:**
```
kproxy v2.3.0
Node v20.10.0
```

### Help

```bash
kproxy help
```

---

## Environment Variables

All CLI options can be set via environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `KPROXY_SERVER` | Server URL | `https://live.koompi.cloud` |
| `KPROXY_AUTH` | API key | `kproxy_xxxx` |
| `KPROXY_DOMAIN` | Default subdomain | `myapp` |
| `KPROXY_PORT` | Default port | `3000` |
| `KPROXY_HOST` | Default host | `localhost` |
| `KPROXY_TCP` | Enable TCP mode | `true` |
| `KPROXY_FORCE_NEW` | Force new subdomain | `true` |

### Using Environment Variables

```bash
export KPROXY_SERVER=https://live.koompi.cloud
export KPROXY_AUTH=kproxy_your_api_key

# Now just run:
kproxy --port 3000
```

### In CI/CD

```yaml
# GitHub Actions example
- name: Start tunnel
  env:
    KPROXY_SERVER: https://live.koompi.cloud
    KPROXY_AUTH: ${{ secrets.KPROXY_API_KEY }}
  run: |
    kproxy --port 3000 --domain preview-${{ github.sha }}
```

---

## Config File

Configuration is stored in `~/.kproxy/config.json`:

```json
{
  "serverUrl": "https://live.koompi.cloud",
  "apiKey": "kproxy_xxxxxxxxxxxx",
  "organizationId": "org_xxxxxxxxxxxx",
  "organizationName": "My Company"
}
```

### Priority Order

1. Command line arguments (highest)
2. Environment variables
3. Config file
4. Default values (lowest)

---

## Examples

### Development Server

```bash
# React/Vue/Next.js
npm run dev &
kproxy --port 3000

# Django
python manage.py runserver &
kproxy --port 8000

# Rails
rails server &
kproxy --port 3000
```

### Webhook Testing

```bash
# Expose local webhook handler
kproxy --port 3000 --domain webhook-test

# Use https://webhook-test.live.koompi.cloud in webhook settings
```

### Share with Team

```bash
# Use memorable subdomain
kproxy --port 3000 --domain demo

# Share: https://demo.live.koompi.cloud
```

### Multiple Services

```bash
# Terminal 1: Frontend
kproxy --port 3000 --domain frontend

# Terminal 2: Backend
kproxy --port 8080 --domain backend

# Terminal 3: Database admin (HTTP)
kproxy --port 5432 --domain db-admin
```

### TCP Tunnels (Databases)

```bash
# PostgreSQL
kproxy --port 5432 --tcp

# MySQL
kproxy --port 3306 --tcp

# Redis
kproxy --port 6379 --tcp

# SSH
kproxy --port 22 --tcp
```

### Custom Domains

```bash
# Register and verify a custom domain
kproxy domain register --domain api.mycompany.com --subdomain api
# Configure DNS: api.mycompany.com CNAME → api.live.koompi.cloud
kproxy domain verify --domain api.mycompany.com

# Now api.mycompany.com routes to your api subdomain tunnel
```

---

## Troubleshooting

### Connection Refused

```bash
# Check if local service is running
curl localhost:3000

# Check if port is correct
kproxy --port 8080  # Try different port
```

### Authentication Error

```bash
# Verify API key
kproxy whoami

# Re-configure
kproxy config --auth kproxy_new_api_key
```

### WebSocket Disconnects

The CLI automatically reconnects. If issues persist:

```bash
# Check server status
curl https://live.koompi.cloud/health

# Try explicit server
kproxy --port 3000 --server https://live.koompi.cloud
```

---

## Next Steps

- [CLI Installation](./installation.md) - Install the CLI
- [CLI Configuration](./configuration.md) - Advanced configuration
- [Quick Start](../getting-started/quick-start.md) - Get started guide
