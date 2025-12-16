# JROK - Agent-Based Tunnel Service

A lightweight tunnel orchestration service where clients run agents that connect via WebSocket to your Bun server, which manages SSH reverse tunnels and automatically configures nginx on your VPS.

## How It Works

```
Client Agent (WebSocket) → Your Bun Server → SSH → VPS (nginx)
```

**Client** runs a simple agent that connects to your server.
**Server** manages all SSH tunnels and nginx configuration.
**VPS** runs nginx to route traffic to client machines.

## Architecture

```
├── src/
│   ├── types/           # TypeScript interfaces
│   ├── services/        # tunnelService, agentService
│   ├── handlers/        # HTTP & WebSocket handlers
│   ├── utils/           # database & helpers
│   └── index.ts         # Main server
├── data/
│   └── tunnels.json     # Persistent state
├── client.ts            # Agent client script
└── .env.example         # Configuration template
```

## Quick Start (Server)

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your VPS details
```

### 3. Setup SSH Key Auth

```bash
ssh-copy-id -i ~/.ssh/id_rsa root@your-vps.com
```

### 4. Run Server

```bash
bun run src/index.ts
```

## Quick Start (Client Agent)

### Run Agent on Your Machine

```bash
bun client.ts \
  --server http://your-server.com:3000 \
  --domain myapp \
  --port 3000 \
  --auth your-api-key
```

Or using environment variables:

```bash
export JROK_SERVER=http://your-server.com:3000
export JROK_DOMAIN=myapp
export JROK_PORT=3000
export JROK_AUTH=your-api-key

bun client.ts
```

## Server API

### Health Check (No Auth)

```bash
curl http://localhost:3000/health
```

### Create Tunnel

Associates a connected agent with a domain.

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "domain": "myapp",
    "agentId": "agent-uuid-from-client"
  }'
```

### List Tunnels

```bash
curl http://localhost:3000/tunnels \
  -H "Authorization: Bearer your-api-key"
```

### List Connected Agents

```bash
curl http://localhost:3000/agents \
  -H "Authorization: Bearer your-api-key"
```

### Delete Tunnel

```bash
curl -X DELETE http://localhost:3000/tunnels/{tunnel-id} \
  -H "Authorization: Bearer your-api-key"
```

## Custom Domains & SSL Certificates

Support for custom domains with automatic SSL certificate management via Let's Encrypt and Certbot.

### Register Custom Domain

Registers a new custom domain with automatic wildcard SSL certificate issuance. The certificate is automatically synced to all healthy VPS servers.

```bash
curl -X POST http://localhost:3000/domains \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "domain": "yourdomain.com",
    "certbotEmail": "admin@yourdomain.com",
    "cloudflareToken": "your-cloudflare-api-token"
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Custom domain registered successfully",
  "domain": {
    "id": "domain-123",
    "domain": "yourdomain.com",
    "baseDomain": false,
    "certPath": "/etc/letsencrypt/live/yourdomain.com",
    "certExpiry": 1735689600000,
    "active": true,
    "synced": true,
    "lastSyncedAt": 1704153600000,
    "createdAt": 1704067200000
  }
}
```

**Key Fields:**
- `synced`: When true, certificate is synced to all VPS servers
- `lastSyncedAt`: Timestamp of last successful sync
- `certExpiry`: Unix timestamp when certificate expires

### List Custom Domains

```bash
curl http://localhost:3000/domains \
  -H "Authorization: Bearer your-api-key"
```

### Get Domain Details

```bash
curl http://localhost:3000/domains/yourdomain.com \
  -H "Authorization: Bearer your-api-key"
```

### Resync Domain Certificates

Force resync of certificates to all VPS servers. Useful for recovery or after adding new servers:

```bash
curl -X POST http://localhost:3000/domains/yourdomain.com/resync \
  -H "Authorization: Bearer your-api-key"
```

### Delete Custom Domain

Removes the domain and cleans up certificates from all VPS servers:

```bash
curl -X DELETE http://localhost:3000/domains/yourdomain.com \
  -H "Authorization: Bearer your-api-key"
```

### Create Tunnel on Custom Domain

Create a tunnel that uses a custom domain's SSL certificate:

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "domain": "myapp",
    "agentId": "agent-456",
    "customDomain": "yourdomain.com",
    "expiresIn": 86400
  }'
```

This creates a tunnel accessible at `myapp.yourdomain.com` with automatic SSL certificate.

## Flow

1. **Agent connects** → Client runs agent, connects via WebSocket to server
2. **Get agent ID** → Server sends welcome message with agent ID
3. **Create tunnel** → POST to `/tunnels` with agent ID and domain
4. **Server configures** → nginx config uploaded and reloaded on VPS
5. **Traffic flows** → nginx routes `domain.example.com` → agent's local service

## Environment Variables

### Server

| Variable      | Description                    | Default              |
| ------------- | ------------------------------ | -------------------- |
| VPS_HOST      | VPS hostname or IP            | your-vps.com         |
| VPS_USER      | SSH user                      | root                 |
| VPS_PORT      | SSH port                      | 22                   |
| NGINX_PATH    | Nginx config directory       | /etc/nginx/sites-available |
| BASE_DOMAIN   | Base domain for tunnels      | tunnel.example.com   |
| API_KEY       | Bearer token for auth        | your-secret-key      |
| PORT          | Server port                  | 3000                 |

### Client

| Variable          | CLI Flag | Description                    |
| ----------------- | -------- | ------------------------------ |
| JROK_SERVER    | --server | Server URL (required)          |
| JROK_DOMAIN    | --domain | Domain name (required)         |
| JROK_PORT      | --port   | Local port (required)          |
| JROK_HOST      | --host   | Local host (default: localhost)|
| JROK_AUTH      | --auth   | API key (required)             |

## Example Workflow

### Server Setup

```bash
# Terminal 1: Start server
VPS_HOST=my-vps.com BASE_DOMAIN=tunnel.example.com API_KEY=mysecret bun run src/index.ts
```

### Client Setup

```bash
# Terminal 2: Start a local service (e.g., Node app on 3000)
# YOUR_APP_HERE listening on localhost:3000

# Terminal 3: Start agent to expose it
bun client.ts --server http://localhost:3000 --domain myapp --port 3000 --auth mysecret
```

### Access from VPS

```bash
# Access your service via domain
curl http://myapp.tunnel.example.com
```

## Benefits Over SSH Reverse Tunnels

- ✅ **No SSH setup** - Client just runs a simple script
- ✅ **Persistent connections** - Automatic reconnect on failure
- ✅ **Better performance** - WebSocket instead of SSH overhead
- ✅ **Works everywhere** - Works behind firewalls, NAT, etc.
- ✅ **Easy auth** - API key instead of SSH keys
- ✅ **Same principle** - Server manages all VPS interaction

This project was created using `bun init` in bun v1.3.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
