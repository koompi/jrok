> ⚠️ HISTORICAL — describes the pre-kproxy nginx + Certbot/Let's Encrypt (leader-based) design that was removed. See ../docs/getting-started/architecture.md for the current architecture.

# Docker & Ansible Integration Guide - jrok

Detailed guide explaining how Docker containerization integrates with Ansible automation for both single-node and multi-node deployments.

## Overview

The jrok project uses a two-tier deployment strategy:

1. **Docker Layer**: Containerizes the application with all runtime dependencies
2. **Ansible Layer**: Automates infrastructure provisioning and service orchestration

```
┌─────────────────────────────────────────────────────────────┐
│                    Deployment Layers                         │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Application (jrok)                         │
│           - Bun.js TypeScript runtime                       │
│           - Certificate sync logic                          │
│           - REST API endpoints                              │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Services (Docker Compose)                         │
│           - jrok container (app)                     │
│           - nginx container (reverse proxy)                 │
│           - mongodb container (optional, uses Atlas)        │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Infrastructure (Ansible)                          │
│           - OS configuration                                │
│           - Docker installation                             │
│           - SSL certificates (Certbot)                      │
│           - Service management                              │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Cloud Infrastructure (Terraform)                  │
│           - DigitalOcean VPS creation                       │
│           - Network configuration                           │
│           - SSH key setup                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Docker Architecture

### Dockerfile Overview

The `Dockerfile` uses a **multi-stage build pattern** for optimization:

```dockerfile
# Stage 1: Builder
FROM oven/bun:latest AS builder
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --production
COPY src ./src
RUN bun build ./src/index.ts --target=bun

# Stage 2: Production
FROM oven/bun:latest
WORKDIR /app
# Only copy built artifacts and dependencies
COPY --from=builder /app /app
# ... runtime setup
```

**Benefits**:
- Final image size: ~200MB (vs 500MB+ without optimization)
- No build tools in production image
- Minimal attack surface
- Fast startup time

### Docker Compose Services

```yaml
services:
  jrok:
    # Application container
    - Exposes port 3000
    - Health check every 30s
    - Mounts /etc/letsencrypt (read-only, for certificates)
    - Environment: MONGODB_URI, CERT_SYNC_API_KEY, SERVER_ID
    
  nginx:
    # Reverse proxy container
    - Exposes ports 80 (HTTP) and 443 (HTTPS)
    - Proxies to jrok:3000
    - Serves SSL certificates from host /etc/letsencrypt
    - Rate limiting and security headers
    
  mongodb:
    # Optional - commented by default
    - Use MongoDB Atlas (M0 free tier) instead
    - MONGODB_URI points to Atlas
```

---

## Ansible Architecture

### Role Structure

```
ansible/
├── playbook.yml              # Main orchestration playbook
├── inventory.ini             # Host definitions and variables
└── roles/
    ├── docker/               # Docker engine setup
    │   └── tasks/main.yml
    ├── certbot/              # SSL certificate management
    │   └── tasks/main.yml
    ├── nginx/                # Reverse proxy configuration
    │   └── tasks/main.yml
    └── app/                  # Application deployment
        └── tasks/main.yml
```

### Role Responsibilities

#### 1. Docker Role (`ansible/roles/docker/tasks/main.yml`)

**What it does**:
- Adds Docker's official repository to Ubuntu
- Installs Docker engine, CLI, and docker-compose
- Enables Docker service to start on boot
- Adds ubuntu user to docker group (sudoless access)

**Key tasks**:
```yaml
- Add Docker GPG key and repository
- Install docker-ce, docker-ce-cli, containerd.io
- Install docker-compose-plugin and standalone binary
- Start docker service
- Add ubuntu user to docker group
```

**Result**: Docker is installed and ready for containers

#### 2. Certbot Role (`ansible/roles/certbot/tasks/main.yml`)

**What it does**:
- Installs Certbot and Cloudflare DNS plugin
- Creates Cloudflare API configuration
- Issues wildcard SSL certificates (example.com and *.example.com)
- Sets up automatic renewal with MongoDB sync hooks

**Key tasks**:
```yaml
- Install certbot and python3-certbot-dns-cloudflare
- Create /etc/letsencrypt/secrets with Cloudflare credentials
- Issue wildcard certificate with Cloudflare DNS challenge
- Create renewal hook script (mongodb-sync.sh)
- Enable automatic renewal timer
```

**Renewal Hook** (`/etc/letsencrypt/renewal-hooks/post/mongodb-sync.sh`):
```bash
# When certificate renews:
1. Base64 encode: cert, chain, privkey, fullchain
2. POST to http://localhost:3000/certificates/upload
3. Header: Authorization: Bearer $CERT_SYNC_API_KEY
4. Log success/failure
```

**Result**: Valid SSL certificates and automatic renewal with MongoDB sync

#### 3. Nginx Role (`ansible/roles/nginx/tasks/main.yml`)

**What it does**:
- Installs and configures Nginx
- Creates reverse proxy configuration
- Enables SSL/TLS termination
- Implements rate limiting
- Adds security headers

**Key configuration**:
```nginx
# Upstream to Bun app on port 3000
upstream jrok {
    server 127.0.0.1:3000;
}

# HTTP → HTTPS redirect
server {
    listen 80;
    return 301 https://$host$request_uri;
}

# HTTPS with SSL termination
server {
    listen 443 ssl http2;
    
    # SSL certificates from Certbot
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    
    # Proxy to application
    location / {
        proxy_pass http://jrok;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    # Rate limiting zones
    limit_req zone=general burst=20 nodelay;
}
```

**Result**: HTTPS reverse proxy with security hardening

#### 4. App Role (`ansible/roles/app/tasks/main.yml`)

**What it does**:
- Clones application repository
- Creates environment configuration
- Generates docker-compose.yml
- Builds Docker images
- Starts application services
- Creates systemd service for auto-restart

**Key tasks**:
```yaml
- Clone git repository
- Create .env with MONGODB_URI, CERT_SYNC_API_KEY, etc.
- Generate docker-compose.yml with volume mounts
- Build Docker image
- Start services with docker-compose up -d
- Create systemd service for persistent management
- Verify application health
```

**Result**: Application running in Docker containers, managed by systemd

---

## Integration Workflow

### Single-Node Deployment (Docker Compose)

```
┌──────────────────────────────────────┐
│  Developer's Machine (Local Dev)    │
├──────────────────────────────────────┤
│                                      │
│  git clone jrok              │
│  docker-compose up -d               │
│                                      │
│  Services running:                   │
│  - jrok:3000 ✓               │
│  - nginx:443 ✓                      │
│  - mongodb (optional)               │
│                                      │
│  Access: http://localhost           │
│         https://localhost (self-signed)│
│                                      │
└──────────────────────────────────────┘
```

**Flow**:
1. Clone repository
2. Configure `.env` with MongoDB URI
3. Run `docker-compose up -d`
4. All services start in containers
5. Nginx proxies to app on port 3000
6. Self-signed certificate for testing

---

### Multi-Node Deployment (Terraform + Ansible + Docker)

```
┌─────────────────────────────────────────────────────────────┐
│  Developer's Machine (Control Node)                        │
├─────────────────────────────────────────────────────────────┤
│  1. Run Terraform                                           │
│     tofu apply -var="vps_count=3"                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────┬──────────────────────┐
        ↓                     ↓                      ↓
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  VPS-SGP1    │    │  VPS-NYC1    │    │  VPS-LON1    │
│ (Singapore)  │    │ (New York)   │    │  (London)    │
├──────────────┤    ├──────────────┤    ├──────────────┤
│              │    │              │    │              │
│ 2. Ansible   │    │ 2. Ansible   │    │ 2. Ansible   │
│  - Docker    │    │  - Docker    │    │  - Docker    │
│  - Certbot   │    │  - Certbot   │    │  - Certbot   │
│  - Nginx     │    │  - Nginx     │    │  - Nginx     │
│  - App       │    │  - App       │    │  - App       │
│              │    │              │    │              │
│ 3. Services: │    │ 3. Services: │    │ 3. Services: │
│  ✓ Docker    │    │  ✓ Docker    │    │  ✓ Docker    │
│  ✓ Certbot   │    │  ✓ Certbot   │    │  ✓ Certbot   │
│  ✓ Nginx     │    │  ✓ Nginx     │    │  ✓ Nginx     │
│  ✓ App (3000)│    │  ✓ App (3000)│    │  ✓ App (3000)│
│              │    │              │    │              │
│ Certs ───────┼────┼─────────────┼────┼──────→ MongoDB Atlas
│              │    │              │    │   (Sync certificates)
│ Logs ────────→ Centralized Logging Service
│              │    │              │    │
└──────────────┘    └──────────────┘    └──────────────┘
```

**Flow**:
1. **Terraform Phase**: Create 3 DigitalOcean VPS servers
2. **Ansible Phase** (parallel on all 3):
   - Install Docker
   - Issue SSL certificate (one per domain, synced to MongoDB)
   - Configure Nginx reverse proxy
   - Deploy application in docker-compose
3. **Leader Election**: MongoDB-based certificate management
   - Only 1 VPS renews certificates per domain
   - Others pull from MongoDB when needed
   - 30-second lease prevents race conditions

---

## Certificate Management Integration

### Single-Node Certificate Flow

```
Local Certificate Renewal
├─ Certbot renews certificate
├─ Renewal hook runs (if configured)
└─ Nginx reloads configuration
   └─ Serves new certificate on HTTPS
```

### Multi-Node Certificate Flow (With MongoDB)

```
VPS-1 (Leader)
├─ Certbot renews certificate
├─ Renewal hook script:
│  ├─ Base64 encode cert/key
│  ├─ POST to app:3000/certificates/upload
│  └─ App stores in MongoDB
│
VPS-2 (Follower)
├─ Poll or webhook: New certificate available?
├─ Fetch certificate from MongoDB
├─ Update /etc/letsencrypt/live/
└─ Nginx reloads
│
VPS-3 (Follower)
├─ Same as VPS-2
└─ All VPS have synchronized certificates
```

**Benefits**:
- ✅ No SSH/SCP between servers (secure)
- ✅ Single source of truth (MongoDB)
- ✅ Leader election prevents race conditions
- ✅ Automatic failover if leader goes down
- ✅ No manual certificate copying needed

---

## Environment Variable Configuration

### Single-Node (.env file)

```bash
NODE_ENV=production
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/jrok
CERT_SYNC_API_KEY=secure-random-key-here
SERVER_ID=local-development
LOG_LEVEL=info
```

### Multi-Node (Ansible Variables)

```yaml
# ansible/inventory.ini variables
[JROK_SERVERs:vars]
domain_name=example.com
certbot_email=admin@example.com
cloudflare_token=CLOUDFLARE_API_TOKEN
cloudflare_email=cloudflare-account-email
mongodb_uri=mongodb+srv://user:pass@cluster.mongodb.net/jrok
cert_sync_api_key=secure-random-key-here
repo_url=https://github.com/user/jrok.git
repo_branch=main
app_dir=/home/ubuntu/jrok
```

---

## Health Checks & Monitoring

### Docker Compose Health Checks

```yaml
services:
  jrok:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
  
  nginx:
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

**Result**: Docker automatically restarts unhealthy containers

### Monitoring Commands

```bash
# Check container status
docker-compose ps

# View logs in real-time
docker-compose logs -f jrok

# Check specific service health
curl http://localhost:3000/health

# View Docker resource usage
docker stats

# Inspect container details
docker inspect jrok-app
```

---

## Scaling Strategies

### Horizontal Scaling (Multi-Node)

```bash
# Deploy on N servers
tofu apply -var="vps_count=5"

# Configure Ansible inventory with all 5 IPs
# Run playbook
ansible-playbook ansible/playbook.yml -i inventory.ini

# All 5 servers will have identical setup
# Certificate synced via MongoDB
```

### Vertical Scaling (Single VPS)

```bash
# Increase container resources in docker-compose.yml
deploy:
  resources:
    limits:
      cpus: '4'
      memory: 8G
    reservations:
      cpus: '2'
      memory: 4G

# Rebuild and restart
docker-compose up -d --force-recreate
```

### Load Balancing

For production, add a load balancer:

```
Internet
  ↓
Load Balancer (DigitalOcean / Cloudflare)
  ├─ VPS-1:443
  ├─ VPS-2:443
  └─ VPS-3:443
  
Each VPS:
- Independent Nginx instance
- Shared MongoDB for certificates
- Automatic failover
```

---

## Security Considerations

### Docker Security

1. **Non-root User**: App runs as unprivileged user (if configured)
2. **Read-Only Filesystem**: Production image has minimal write access
3. **Health Checks**: Ensure containers are responsive
4. **Image Scanning**: Regularly scan for vulnerabilities

### Ansible Security

1. **No-Log for Sensitive Data**: Cloudflare token, API keys not logged
2. **SSH Key-Based Auth**: Only SSH keys, no passwords
3. **UFW Firewall**: Only ports 22, 80, 443 open
4. **Become Method**: Elevated privileges only when needed

### Network Security

1. **HTTPS Only**: HTTP redirects to HTTPS
2. **Rate Limiting**: Prevent abuse (10r/s general, 5r/s API)
3. **Security Headers**: X-Frame-Options, X-Content-Type-Options
4. **Certificate Pinning**: Optional for API clients

---

## Troubleshooting Docker + Ansible Integration

### Problem: Docker not starting after Ansible

```bash
# Check Docker service status
sudo systemctl status docker

# Verify Ansible docker role executed
ansible all -i inventory.ini -m shell -a "docker --version" -v

# Check Docker daemon logs
sudo journalctl -u docker -n 50
```

### Problem: Container crashes immediately

```bash
# View container logs
docker-compose logs jrok

# Rebuild image
docker-compose build --no-cache

# Inspect environment variables
docker-compose exec jrok env
```

### Problem: Certificate not mounted in container

```bash
# Verify host certificate exists
ls -la /etc/letsencrypt/live/example.com/

# Check volume mount in docker-compose
docker-compose exec jrok ls -la /etc/letsencrypt/

# Restart with fresh mount
docker-compose down && docker-compose up -d
```

### Problem: Nginx proxying to wrong port

```bash
# Check Nginx config
docker-compose exec nginx cat /etc/nginx/nginx.conf | grep upstream

# Verify app is listening
docker-compose exec jrok netstat -tlnp

# Test local proxy
curl http://127.0.0.1:3000/health (from inside nginx container)
```

---

## Next Steps

1. **Test Locally**: Use docker-compose for testing before deploying to VPS
2. **Deploy to Single VPS**: Test Ansible on one server first
3. **Scale to 3 VPS**: Once working, deploy full 3-node cluster
4. **Add Monitoring**: Set up Prometheus/Grafana for metrics
5. **CI/CD Integration**: Automate image builds and deployments

---

## References

- [Docker Documentation](https://docs.docker.com/)
- [Docker Compose Reference](https://docs.docker.com/compose/compose-file/)
- [Ansible Documentation](https://docs.ansible.com/)
- [Certbot Documentation](https://certbot.eff.org/docs/)
- [Nginx Reverse Proxy](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/)
