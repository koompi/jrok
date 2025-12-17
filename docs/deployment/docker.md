# Docker Deployment Guide

Deploy Jrok using Docker and Docker Compose for containerized environments.

## Prerequisites

- Docker and Docker Compose installed
- Domain configured with DNS pointing to your server
- SSL certificates (or use with reverse proxy)

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
docker-compose logs -f jrok
```

## Docker Compose Configuration

### docker-compose.yml

```yaml
version: '3.8'

services:
  jrok:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: jrok-app
    restart: always
    ports:
      - "3000:3000"
    volumes:
      # Mount SSL certificates (for direct SSL termination)
      - /etc/letsencrypt:/etc/letsencrypt:ro
      # Mount nginx configs (for dynamic nginx updates)
      - /etc/nginx:/etc/nginx
      # Persistent data
      - ./data:/app/data
      - ./logs:/app/logs
    environment:
      - NODE_ENV=production
      - PORT=3000
      - MONGODB_URI=${MONGODB_URI}
      - JWT_SECRET=${JWT_SECRET}
      - BASE_DOMAIN=${BASE_DOMAIN}
      - KOOMPI_CLIENT_ID=${KOOMPI_CLIENT_ID}
      - KOOMPI_CLIENT_SECRET=${KOOMPI_CLIENT_SECRET}
      - KOOMPI_REDIRECT_URI=${KOOMPI_REDIRECT_URI}
      - DASHBOARD_URL=${DASHBOARD_URL}
      - ALLOWED_ORIGINS=${ALLOWED_ORIGINS}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    networks:
      - jrok-net

networks:
  jrok-net:
    driver: bridge
```

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
RUN adduser --system --uid 1001 jrok
USER jrok

EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
```

## Environment Configuration

Create `.env` file:

```bash
# .env

# Required
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/jrok
JWT_SECRET=your-super-secret-jwt-key-at-least-64-characters-long
BASE_DOMAIN=tunnel.yourdomain.com

# KOOMPI OAuth
KOOMPI_CLIENT_ID=your-client-id
KOOMPI_CLIENT_SECRET=your-client-secret
KOOMPI_REDIRECT_URI=https://tunnel.yourdomain.com/auth/callback

# Application
DASHBOARD_URL=https://tunnel.yourdomain.com
ALLOWED_ORIGINS=https://tunnel.yourdomain.com,http://localhost:5173
PORT=3000
NODE_ENV=production
```

## Deployment Options

### Option 1: Docker with Nginx (Recommended)

Run Jrok in Docker with external Nginx handling SSL:

```yaml
# docker-compose.yml
version: '3.8'

services:
  jrok:
    build: .
    container_name: jrok-app
    restart: always
    expose:
      - "3000"
    environment:
      - NODE_ENV=production
      - MONGODB_URI=${MONGODB_URI}
      # ... other env vars
    networks:
      - jrok-net

  nginx:
    image: nginx:alpine
    container_name: jrok-nginx
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    depends_on:
      - jrok
    networks:
      - jrok-net

networks:
  jrok-net:
    driver: bridge
```

### Option 2: Docker with Traefik

Use Traefik for automatic SSL and routing:

```yaml
version: '3.8'

services:
  traefik:
    image: traefik:v2.10
    command:
      - "--providers.docker=true"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.email=admin@yourdomain.com"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"
    environment:
      - CF_API_EMAIL=${CF_API_EMAIL}
      - CF_API_KEY=${CF_API_KEY}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    networks:
      - jrok-net

  jrok:
    build: .
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.jrok.rule=Host(`tunnel.yourdomain.com`) || HostRegexp(`{subdomain:.+}.tunnel.yourdomain.com`)"
      - "traefik.http.routers.jrok.tls=true"
      - "traefik.http.routers.jrok.tls.certresolver=letsencrypt"
      - "traefik.http.services.jrok.loadbalancer.server.port=3000"
    environment:
      - NODE_ENV=production
      - MONGODB_URI=${MONGODB_URI}
    networks:
      - jrok-net

networks:
  jrok-net:
    driver: bridge
```

### Option 3: Docker Swarm

For production with multiple replicas:

```yaml
version: '3.8'

services:
  jrok:
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
    networks:
      - jrok-net
    ports:
      - "3000:3000"

networks:
  jrok-net:
    driver: overlay
```

## Building and Running

### Build Image

```bash
# Build locally
docker build -t jrok:latest .

# Build with docker-compose
docker-compose build
```

### Run Services

```bash
# Start in background
docker-compose up -d

# View logs
docker-compose logs -f

# Restart
docker-compose restart

# Stop
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

### Update Deployment

```bash
# Pull latest code
git pull origin main

# Rebuild and restart
docker-compose up -d --build
```

## Health Checks

### Check Container Status

```bash
docker ps
docker-compose ps
```

### Check Health

```bash
curl http://localhost:3000/health
```

### View Logs

```bash
# All logs
docker-compose logs

# Follow logs
docker-compose logs -f jrok

# Last 100 lines
docker-compose logs --tail=100 jrok
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker-compose logs jrok

# Check environment
docker-compose config

# Interactive shell
docker-compose run --rm jrok sh
```

### MongoDB Connection Failed

```bash
# Test from container
docker-compose exec jrok sh
curl -v $MONGODB_URI
```

### Port Conflicts

```bash
# Check what's using port 3000
lsof -i :3000

# Use different port
# Update docker-compose.yml: ports: "3001:3000"
```

---

## Next Steps

- [Environment Variables](../configuration/environment.md) - All configuration options
- [Ansible Deployment](./ansible.md) - For native deployments
- [Multi-Server Setup](../advanced/multi-server.md) - High availability
