# Architecture Overview

Jrok is an agent-based tunnel service that exposes local services to the public internet through a lightweight WebSocket connection.

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              INTERNET                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         YOUR VPS / CLOUD SERVER                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                           NGINX                                       │   │
│  │  • SSL Termination (Let's Encrypt)                                   │   │
│  │  • Wildcard Certificate (*.tunnel.example.com)                       │   │
│  │  • Reverse Proxy                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        JROK SERVER                                    │   │
│  │  • WebSocket Connection Manager                                      │   │
│  │  • Request Routing                                                   │   │
│  │  • Authentication (KOOMPI ID OAuth / API Keys)                       │   │
│  │  • MongoDB (tunnels, users, organizations)                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
           ▲                    ▲                    ▲
           │                    │                    │
      WebSocket            WebSocket            WebSocket
           │                    │                    │
           ▼                    ▼                    ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   JROK AGENT 1   │  │   JROK AGENT 2   │  │   JROK AGENT 3   │
│   (Your laptop)  │  │   (Dev server)   │  │   (CI/CD runner) │
│                  │  │                  │  │                  │
│   localhost:3000 │  │   localhost:8080 │  │   localhost:5000 │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

## Traffic Flow

### 1. Agent Connection
```
Client → jrok CLI → WebSocket → Jrok Server → Registered in MongoDB
```

When you run `jrok --port 3000`:
1. CLI establishes a WebSocket connection to the Jrok server
2. Server authenticates via API key
3. Server registers the agent with assigned subdomain
4. Server sends back the public URL

### 2. Incoming Request
```
Browser → https://myapp.tunnel.example.com → Nginx → Jrok Server
```

When someone visits your tunnel URL:
1. DNS resolves `*.tunnel.example.com` to your VPS
2. Nginx terminates SSL and proxies to Jrok server
3. Jrok server extracts subdomain from Host header

### 3. Request Forwarding
```
Jrok Server → WebSocket → Jrok Agent → Local Service → Response
```

The server:
1. Looks up the agent for the subdomain
2. Forwards the HTTP request through WebSocket
3. Agent makes local HTTP request to your service
4. Response flows back through the same path

## Components

### Jrok Server
The main server application built with [Bun](https://bun.sh):

- **WebSocket Manager**: Handles persistent connections with agents
- **HTTP Router**: Routes incoming requests to correct agents
- **Auth Service**: KOOMPI ID OAuth + API key authentication
- **Organization Service**: Multi-tenant organization management
- **Stats Service**: Bandwidth tracking and usage analytics

### Jrok CLI Agent
A lightweight Node.js CLI that:

- Establishes WebSocket connection to server
- Receives HTTP requests from server
- Forwards to local service
- Returns response through WebSocket
- Auto-reconnects on disconnect

### Dashboard
React-based web dashboard for:

- User authentication (KOOMPI ID)
- Organization management
- API key management
- Tunnel monitoring
- Usage statistics

### Infrastructure
- **Nginx**: SSL termination, wildcard certificates, load balancing
- **Certbot**: Automatic Let's Encrypt certificate management
- **MongoDB**: Persistent storage for users, organizations, tunnels
- **Cloudflare**: DNS management for wildcard domains

## Security Model

### Authentication Layers

1. **KOOMPI ID OAuth**: Dashboard login for users
2. **API Keys**: CLI authentication with scoped permissions
3. **Organization Isolation**: Resources scoped to organizations
4. **Rate Limiting**: Protection against abuse

### Data Flow Security

- All public connections use HTTPS (TLS 1.2+)
- WebSocket connections use WSS (encrypted)
- API keys are hashed before storage
- Sessions expire after 7 days

## Scalability

### Single Server
For most use cases, a single VPS handles:
- Hundreds of concurrent agents
- Thousands of requests per second
- Automatic cleanup of stale connections

### Multi-Server (High Availability)
For production deployments:
- Multiple VPS servers behind load balancer
- Shared MongoDB (Atlas recommended)
- Nginx upstream configuration
- Health checks and failover

See [Multi-Server Setup](../advanced/multi-server.md) for details.

---

## Technology Stack

| Component | Technology |
|-----------|------------|
| Server Runtime | [Bun](https://bun.sh) |
| Database | MongoDB (Atlas) |
| Web Server | Nginx |
| SSL | Let's Encrypt + Certbot |
| DNS | Cloudflare |
| Dashboard | React + Vite |
| CLI | Node.js + TypeScript |
| IaC | Terraform + Ansible |

---

## Next Steps

- [Self-Hosting Guide](../deployment/self-hosting.md) - Deploy your own server
- [Terraform Setup](../deployment/terraform.md) - Provision infrastructure
- [Environment Variables](../configuration/environment.md) - Configuration options
