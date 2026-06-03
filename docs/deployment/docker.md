# Docker Deployment Guide

Deploy KProxy using Docker and Docker Compose for containerized environments.

KProxy runs as a **single stateless app container** (a Bun process). **Cloudflare is the edge** —
it terminates TLS, load-balances across nodes, and issues certificates (Universal SSL + Cloudflare
for SaaS). You do **not** run nginx, Certbot/Let's Encrypt, or a Traefik-with-ACME sidecar; the
container just listens on its HTTP port and Cloudflare sits in front. See
[Cloudflare Setup](../configuration/cloudflare.md) for the edge configuration.

## Prerequisites

- Docker and Docker Compose installed
- A Cloudflare zone in front of your origin (edge TLS + Load Balancer) — see [Cloudflare Setup](../configuration/cloudflare.md)
- A MongoDB connection string (Atlas or self-hosted) for cold/durable state

## Quick Start

### Using Docker Compose

```bash
# Clone repository
git clone https://github.com/koompi/jrok.git
cd jrok

# Create .env file
cp .env.example .env
# Edit .env with your configuration

# Start services
docker-compose up -d

# View logs
docker-compose logs -f kproxy
```

## Docker Compose Configuration

A minimal, single-container setup (Cloudflare is the edge, so there are **no certificate or
nginx mounts**):

```yaml
services:
  kproxy:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: kproxy-app
    restart: always
    ports:
      - "3000:3000"          # HTTP origin; Cloudflare proxies to this
    volumes:
      # App data and logs only — no /etc/letsencrypt or /etc/nginx mounts
      - ./data:/app/data
      - ./logs:/app/logs
    environment:
      - NODE_ENV=production
      - PORT=3000
      - MONGODB_URI=${MONGODB_URI}
      - MONGO_DB_NAME=${MONGO_DB_NAME:-kproxy}
      - JWT_SECRET=${JWT_SECRET}
      - BASE_DOMAIN=${BASE_DOMAIN}
      - KOOMPI_CLIENT_ID=${KOOMPI_CLIENT_ID}
      - KOOMPI_CLIENT_SECRET=${KOOMPI_CLIENT_SECRET}
      - KOOMPI_REDIRECT_URI=${KOOMPI_REDIRECT_URI}
      - DASHBOARD_URL=${DASHBOARD_URL}
      - ALLOWED_ORIGINS=${ALLOWED_ORIGINS}
      # Cloudflare for SaaS (customer custom domains)
      - CF_API_TOKEN=${CF_API_TOKEN}
      - CF_ZONE_ID=${CF_ZONE_ID}
      - CF_SAAS_FALLBACK_HOSTNAME=${CF_SAAS_FALLBACK_HOSTNAME}
      # Gossip routing mesh (set per node)
      - GOSSIP_SECRET=${GOSSIP_SECRET}
      - VPS_ID=${VPS_ID}
      - VPS_HOST=${VPS_HOST}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    networks:
      - kproxy-net

networks:
  kproxy-net:
    driver: bridge
```

> Each container is a stateless node. To run several nodes, give each a unique `VPS_ID`/`VPS_HOST`
> and the **same `GOSSIP_SECRET`**, then add them to the Cloudflare Load Balancer origin pool.
> See [Multi-Server Deployment](./multi-server.md).

### Optional: local MongoDB

For development you can run MongoDB alongside the app instead of using Atlas:

```yaml
  mongodb:
    image: mongo:7
    container_name: kproxy-mongodb
    restart: always
    volumes:
      - mongodb_data:/data/db
    environment:
      - MONGO_INITDB_ROOT_USERNAME=admin
      - MONGO_INITDB_ROOT_PASSWORD=change-me
    networks:
      - kproxy-net

volumes:
  mongodb_data:
```

Point the app at it with `MONGODB_URI=mongodb://admin:change-me@mongodb:27017/kproxy?authSource=admin`.

### Dockerfile

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Build application
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 kproxy
USER kproxy

EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
```

## Environment Configuration

Create `.env` file:

```bash
# .env

# Required
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/kproxy
MONGO_DB_NAME=kproxy
JWT_SECRET=your-super-secret-jwt-key-at-least-64-characters-long
BASE_DOMAIN=live.yourdomain.com

# KOOMPI OAuth
KOOMPI_CLIENT_ID=your-client-id
KOOMPI_CLIENT_SECRET=your-client-secret
KOOMPI_REDIRECT_URI=https://live.yourdomain.com/auth/callback

# Cloudflare for SaaS (customer custom domains)
CF_API_TOKEN=your-cf-token            # SSL and Certificates: Edit
CF_ZONE_ID=your-zone-id
CF_SAAS_FALLBACK_HOSTNAME=live.yourdomain.com

# Gossip routing mesh
GOSSIP_SECRET=shared-secret-on-every-node
VPS_ID=node-a
VPS_HOST=10.0.0.11

# Application
DASHBOARD_URL=https://live.yourdomain.com
ALLOWED_ORIGINS=https://live.yourdomain.com,http://localhost:5173
PORT=3000
NODE_ENV=production
```

See [Environment Variables](../configuration/environment.md) for the full reference.

## Putting Cloudflare in front of the container

The container speaks plain HTTP on `PORT`; Cloudflare provides TLS and the Load Balancer:

1. Point a **proxied (orange-cloud)** DNS record at the host (or its Load Balancer).
2. Install a **Cloudflare Origin CA cert** on the host, **or** run `cloudflared` next to the
   container so the origin needs no public port and no cert.
3. Set SSL/TLS mode to **Full (strict)** and lock the origin to Cloudflare IPs.

Customer custom domains are handled automatically via Cloudflare for SaaS — the customer adds a
**DNS-only CNAME** to `CF_SAAS_FALLBACK_HOSTNAME` and Cloudflare issues + renews the cert.

### Docker Swarm (multiple replicas)

For production with multiple nodes behind the Cloudflare Load Balancer:

```yaml
services:
  kproxy:
    image: koompi/jrok:latest
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
      restart_policy:
        condition: on-failure
    environment:
      - NODE_ENV=production
      - MONGODB_URI=${MONGODB_URI}
      - GOSSIP_SECRET=${GOSSIP_SECRET}
      # VPS_ID/VPS_HOST must be unique per task — template them per node
    networks:
      - kproxy-net
    ports:
      - "3000:3000"

networks:
  kproxy-net:
    driver: overlay
```

## Building and Running

### Build Image

```bash
# Build locally
docker build -t kproxy:latest .

# Build with docker-compose
docker-compose build
```

### Run Services

```bash
docker-compose up -d         # Start in background
docker-compose logs -f       # View logs
docker-compose restart       # Restart
docker-compose down          # Stop
docker-compose down -v       # Stop and remove volumes
```

### Update Deployment

```bash
git pull origin main
docker-compose up -d --build
```

## Health Checks

```bash
docker ps
docker-compose ps

# Health endpoint (also used by the Cloudflare Load Balancer)
curl http://localhost:3000/health
```

## Troubleshooting

### Container Won't Start

```bash
docker-compose logs kproxy
docker-compose config
docker-compose run --rm kproxy sh
```

### MongoDB Connection Failed

```bash
docker-compose exec kproxy sh
# verify MONGODB_URI is reachable from inside the container
```

### Port Conflicts

```bash
# Check what's using port 3000
lsof -i :3000

# Use a different host port: ports: "3001:3000"
```

---

## Next Steps

- [Cloudflare Setup](../configuration/cloudflare.md) — edge TLS, Load Balancer, Cloudflare for SaaS
- [Environment Variables](../configuration/environment.md) — all configuration options
- [Ansible Deployment](./ansible.md) — native (non-container) deployments
- [Multi-Server Deployment](./multi-server.md) — high availability and scaling
