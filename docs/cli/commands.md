# CLI Commands Reference

Complete reference for all Jrok CLI commands.

## Quick Reference

| Command | Description |
|---------|-------------|
| `jrok --port 3000` | Expose localhost:3000 (simplest usage) |
| `jrok --port 5432 --tcp` | Expose TCP service (databases, SSH, etc.) |
| `jrok connect` | Connect with full options |
| `jrok list` | List active tunnels |
| `jrok disconnect` | Disconnect a tunnel |
| `jrok config` | Manage CLI configuration |
| `jrok org` | Organization management |
| `jrok apikey` | API key management |
| `jrok domain` | Custom domain management |
| `jrok whoami` | Show current user info |
| `jrok version` | Show version |
| `jrok help` | Show help |

---

## Connect Commands

### Quick Connect

The simplest way to expose a local service:

```bash
jrok --port 3000
```

This will:
1. Prompt for API key if not configured
2. Auto-generate a random subdomain
3. Connect and display the public URL

**Output:**
```
🎲 Generated subdomain: a1b2c3d4
🔌 Connecting to jrok server...
📍 Domain: a1b2c3d4
🏠 Local Service: localhost:3000

https://tunnel.koompi.cloud

✅ Connected to server!
🌐 Your service is now available at: https://a1b2c3d4.tunnel.koompi.cloud
✨ Connected to jrok
🆔 Agent ID: aa01ea7c-70ef-403e-8720-6729bfef5d95
```

### Connect with Custom Subdomain

```bash
jrok --port 3000 --domain myapp
```

Access at: `https://myapp.tunnel.koompi.cloud`

### TCP Tunnel (Databases, SSH, etc.)

Expose raw TCP services like databases:

```bash
jrok --port 5432 --tcp
```

**Output:**
```
🔌 Creating TCP tunnel...
📍 TCP Port Assigned: 54321
🏠 Local Service: localhost:5432

✅ TCP tunnel established!
🌐 Connect via: tcp://tunnel.koompi.cloud:54321
```

### Force New Subdomain

When you already own a subdomain but want a fresh tunnel:

```bash
jrok --port 3000 --domain myapp --force-new
```

This creates a new tunnel with a suffix (e.g., `myapp-a7b3`) instead of updating the existing one.

### Connect with All Options

```bash
jrok connect \
  --server https://tunnel.koompi.cloud \
  --auth jrok_xxxx \
  --domain myapp \
  --port 3000 \
  --host localhost \
  --force-new          # Optional: force new subdomain
```

### Connect Docker Swarm Service

```bash
jrok connect --domain api --docker-service my-api-service
```

### Connect Kubernetes Service

```bash
jrok connect --domain app --k8s-service my-service:8080
```

### Connect Options

| Option | Description | Default |
|--------|-------------|---------|
| `--server` | Jrok server URL | `https://tunnel.koompi.cloud` |
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
jrok list
```

**Output:**
```
📋 Active Tunnels:

Domain                                        Local                Status       Created
───────────────────────────────────────────────────────────────────────────────────────────
myapp.tunnel.koompi.cloud                     localhost:3000       ✅ Online    12/18/2025
api.tunnel.koompi.cloud                       localhost:8080       ❌ Offline   12/17/2025
```

---

## Disconnect Command

Disconnect a specific tunnel:

```bash
jrok disconnect --domain myapp
```

**Output:**
```
✅ Tunnel disconnected: myapp
```

---

## Config Commands

### Show Current Configuration

```bash
jrok config
```

**Output:**
```
⚙️  Current Configuration:

Server URL:      https://tunnel.koompi.cloud
API Key:         jrok_abc123def45...
Organization ID: org_xxxxxxxxxxxx
Organization:    My Company

Config file: /home/user/.jrok/config.json
```

### Set Server URL

```bash
jrok config --server https://tunnel.yourdomain.com
```

### Set API Key

```bash
jrok config --auth jrok_your_api_key_here
```

### Set Default Organization

```bash
jrok config --org org_xxxxxxxxxxxx
```

### Set Multiple Options

```bash
jrok config \
  --server https://tunnel.yourdomain.com \
  --auth jrok_xxxx \
  --org org_xxxx
```

### Clear Configuration

```bash
jrok config --clear
```

---

## Organization Commands

### List Organizations

```bash
jrok org list
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
jrok org create --name "My New Organization"
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
jrok org use --id org_abc123def456
```

---

## API Key Commands

### List API Keys

```bash
jrok apikey list --org org_abc123def456
```

**Output:**
```
🔑 API Keys:

ID                        Prefix           Name                 Permissions
─────────────────────────────────────────────────────────────────────────────────────
key_abc123def456          jrok_abc...      Production Key       tunnel:create, tunnel:read
key_xyz789ghi012          jrok_xyz...      CI/CD Key            tunnel:create
```

### Create API Key

```bash
jrok apikey create --org org_abc123def456 --name "My New Key"
```

**Output:**
```
✅ API Key created: My New Key

⚠️  IMPORTANT: Save this key now! It will only be shown once.

🔑 API Key: jrok_abc123def456789xyz

To use this key:
  jrok config --auth jrok_abc123def456789xyz
  # or
  export JROK_AUTH=jrok_abc123def456789xyz
```

### Create Key with Custom Permissions

```bash
jrok apikey create \
  --org org_abc123def456 \
  --name "Read Only Key" \
  --permissions tunnel:read
```

### Revoke API Key

```bash
jrok apikey revoke --org org_abc123def456 --id key_abc123def456
```

---

## Domain Commands

Manage custom domains that point to your tunnels.

### Register Custom Domain

Register a custom domain with auto-generated subdomain target:

```bash
jrok domain register --domain mysite.com
```

**Output:**
```
✅ Custom domain registered: mysite.com

📋 Next Steps:
1. Add CNAME record to your DNS:
   mysite.com → myapp-auto.tunnel.koompi.cloud

2. Wait for DNS propagation (usually 1-10 minutes)

3. Verify and issue SSL certificate:
   jrok domain verify --domain mysite.com
```

### Register with Specific Subdomain

Target a specific subdomain:

```bash
jrok domain register --domain mysite.com --subdomain myapp
```

### Verify Domain (CNAME + SSL)

After configuring DNS, verify and issue SSL:

```bash
jrok domain verify --domain mysite.com
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

Expected CNAME target: myapp.tunnel.koompi.cloud
Current resolution: (not found)

💡 DNS propagation can take up to 48 hours.
   Run this command again once DNS is configured.
```

### Check Domain Status

Check verification status without attempting to issue SSL:

```bash
jrok domain status --domain mysite.com
```

**Output:**
```
📋 Domain Status: mysite.com

CNAME Target:   myapp.tunnel.koompi.cloud
CNAME Verified: ✅ Yes (verified 2 hours ago)
SSL Status:     ✅ Issued
Subdomain:      myapp
Organization:   My Company
```

### List Custom Domains

```bash
jrok domain list
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
│     jrok domain register --domain mysite.com                 │
│                          ↓                                   │
│  2. Configure DNS (at your registrar)                        │
│     mysite.com CNAME → myapp.tunnel.koompi.cloud            │
│                          ↓                                   │
│  3. Verify CNAME & Issue SSL                                 │
│     jrok domain verify --domain mysite.com                   │
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
jrok whoami
```

**For API Key:**
```
🔑 Using API Key authentication
Key prefix: jrok_abc123def...
✅ API Key is valid
📋 Access to 2 organization(s)

Organizations:
  - My Company (my-company)
  - Client Project (client-project)
```

### Version

```bash
jrok version
```

**Output:**
```
jrok v2.3.0
Node v20.10.0
```

### Help

```bash
jrok help
```

---

## Environment Variables

All CLI options can be set via environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `JROK_SERVER` | Server URL | `https://tunnel.koompi.cloud` |
| `JROK_AUTH` | API key | `jrok_xxxx` |
| `JROK_DOMAIN` | Default subdomain | `myapp` |
| `JROK_PORT` | Default port | `3000` |
| `JROK_HOST` | Default host | `localhost` |
| `JROK_TCP` | Enable TCP mode | `true` |
| `JROK_FORCE_NEW` | Force new subdomain | `true` |

### Using Environment Variables

```bash
export JROK_SERVER=https://tunnel.koompi.cloud
export JROK_AUTH=jrok_your_api_key

# Now just run:
jrok --port 3000
```

### In CI/CD

```yaml
# GitHub Actions example
- name: Start tunnel
  env:
    JROK_SERVER: https://tunnel.koompi.cloud
    JROK_AUTH: ${{ secrets.JROK_API_KEY }}
  run: |
    jrok --port 3000 --domain preview-${{ github.sha }}
```

---

## Config File

Configuration is stored in `~/.jrok/config.json`:

```json
{
  "serverUrl": "https://tunnel.koompi.cloud",
  "apiKey": "jrok_xxxxxxxxxxxx",
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
jrok --port 3000

# Django
python manage.py runserver &
jrok --port 8000

# Rails
rails server &
jrok --port 3000
```

### Webhook Testing

```bash
# Expose local webhook handler
jrok --port 3000 --domain webhook-test

# Use https://webhook-test.tunnel.koompi.cloud in webhook settings
```

### Share with Team

```bash
# Use memorable subdomain
jrok --port 3000 --domain demo

# Share: https://demo.tunnel.koompi.cloud
```

### Multiple Services

```bash
# Terminal 1: Frontend
jrok --port 3000 --domain frontend

# Terminal 2: Backend
jrok --port 8080 --domain backend

# Terminal 3: Database admin (HTTP)
jrok --port 5432 --domain db-admin
```

### TCP Tunnels (Databases)

```bash
# PostgreSQL
jrok --port 5432 --tcp

# MySQL
jrok --port 3306 --tcp

# Redis
jrok --port 6379 --tcp

# SSH
jrok --port 22 --tcp
```

### Custom Domains

```bash
# Register and verify a custom domain
jrok domain register --domain api.mycompany.com --subdomain api
# Configure DNS: api.mycompany.com CNAME → api.tunnel.koompi.cloud
jrok domain verify --domain api.mycompany.com

# Now api.mycompany.com routes to your api subdomain tunnel
```

---

## Troubleshooting

### Connection Refused

```bash
# Check if local service is running
curl localhost:3000

# Check if port is correct
jrok --port 8080  # Try different port
```

### Authentication Error

```bash
# Verify API key
jrok whoami

# Re-configure
jrok config --auth jrok_new_api_key
```

### WebSocket Disconnects

The CLI automatically reconnects. If issues persist:

```bash
# Check server status
curl https://tunnel.koompi.cloud/health

# Try explicit server
jrok --port 3000 --server https://tunnel.koompi.cloud
```

---

## Next Steps

- [CLI Installation](./installation.md) - Install the CLI
- [CLI Configuration](./configuration.md) - Advanced configuration
- [Quick Start](../getting-started/quick-start.md) - Get started guide
