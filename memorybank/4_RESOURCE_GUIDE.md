> ⚠️ HISTORICAL — describes the pre-kproxy nginx + Certbot/Let's Encrypt (leader-based) design that was removed. See ../docs/getting-started/architecture.md for the current architecture.

# Resource Guide - jrok Complete Automation Suite

Quick reference guide for all created resources, files, and documentation.

## 📚 Documentation Files

All documentation files are in the root directory:

### 1. **AUTOMATION_SUITE_SUMMARY.md** ⭐ START HERE
- Overview of all created components
- Feature summary
- Deployment options comparison
- File structure and metrics
- Production readiness checklist
- Integration with previous work

### 2. **DEPLOYMENT_GUIDE.md** - STEP-BY-STEP
- Prerequisites for all deployment types
- Single-node deployment (Docker Compose)
- Multi-node deployment (Terraform + Ansible)
- Automated deployment script usage
- Verification and testing procedures
- Comprehensive troubleshooting section
- Cleanup procedures

### 3. **DOCKER_ANSIBLE_GUIDE.md** - TECHNICAL DEEP-DIVE
- Deployment layer architecture
- Dockerfile optimization explanation
- Ansible role structure and responsibilities
- Integration workflow (single-node & multi-node)
- Certificate management with MongoDB sync
- Environment variable configuration
- Health checks and monitoring
- Scaling strategies
- Security considerations
- Detailed troubleshooting guide

---

## 🐳 Docker Files

Located in project root:

### `Dockerfile` (45 lines)
Multi-stage build for Bun.js application:
- **Stage 1 (Builder)**: Compiles application, installs dependencies
- **Stage 2 (Production)**: Minimal runtime with essential tools
- **Health Check**: Monitors application availability
- **Exposes**: Port 3000

### `docker-compose.yml` (75 lines)
Service orchestration:
- **Services**: jrok (app), nginx (proxy), mongodb (optional)
- **Networking**: Bridge network for inter-service communication
- **Volumes**: Certificate mounts, data persistence
- **Environment**: All configuration via environment variables
- **Health Checks**: Automatic container restart if unhealthy

### `.dockerignore` (35 lines)
Build context optimization:
- Excludes unnecessary files to speed up builds
- Reduces final image size
- Keeps essential configuration files

---

## 🤖 Ansible Automation

Located in `ansible/` directory:

### `playbook.yml` (90 lines)
Main orchestration playbook:
- **Pre-tasks**: System updates, base package installation
- **Roles**: Docker, Certbot, Nginx, App (4 complete roles)
- **Post-tasks**: Firewall setup, service verification
- **Tags**: Selective execution (`docker`, `certbot`, `nginx`, `app`)
- **Variables**: Configurable for all environments

### `inventory.ini` (50 lines)
Host configuration template:
- `[JROK_SERVERs]` group with 3 example VPS
- Global variables for all servers
- SSH configuration
- MongoDB and API credentials
- Domain and email settings
- **Ready to customize** with your actual VPS IPs

### Ansible Roles (4 complete roles)

#### `roles/docker/tasks/main.yml` (40 lines)
Docker installation and configuration:
1. Adds Docker official repository
2. Installs Docker engine, CLI, and docker-compose
3. Configures Docker service
4. Enables ubuntu user sudoless Docker access
5. Verifies installation

**Time**: ~2-3 minutes per server

#### `roles/certbot/tasks/main.yml` (100 lines)
SSL certificate management:
1. Installs Certbot and Cloudflare DNS plugin
2. Creates Cloudflare API credentials
3. Issues wildcard certificates
4. Sets up automatic renewal hooks
5. Creates MongoDB sync script
6. Enables certbot.timer for daily renewal
7. Lists and verifies certificates

**Time**: ~3-5 minutes per server (first run slower due to cert issuance)

**Features**:
- Wildcard cert: `-d domain -d *.domain`
- Cloudflare DNS challenge (no port forwarding needed)
- MongoDB sync via HTTP API (secure, no SSH)
- Automatic renewal every 60 days

#### `roles/nginx/tasks/main.yml` (150 lines)
Nginx reverse proxy configuration:
1. Installs Nginx
2. Creates full nginx.conf with:
   - Upstream to Bun app on port 3000
   - HTTP → HTTPS redirect
   - SSL/TLS termination (TLSv1.2+)
   - Rate limiting zones (10r/s general, 5r/s API)
   - Security headers (X-Frame-Options, etc.)
   - Proxy settings (X-Real-IP, X-Forwarded-For)
   - Health check endpoint
3. Tests configuration
4. Starts nginx service

**Time**: ~1-2 minutes per server

**Security Features**:
- Only TLSv1.2 and TLSv1.3
- Strong cipher suites
- Security headers
- Rate limiting to prevent abuse
- ACME challenge support for renewals

#### `roles/app/tasks/main.yml` (70 lines)
Application deployment:
1. Creates application directory
2. Clones git repository
3. Creates environment configuration (.env)
4. Generates docker-compose.yml
5. Builds Docker images
6. Starts services
7. Creates systemd service
8. Verifies health
9. Displays logs

**Time**: ~5-10 minutes per server (depends on image size)

**Features**:
- Auto-restart on failure (systemd)
- Volume mounts for persistent data
- Environment variable configuration
- Health checks every 30 seconds
- Logs accessible via docker-compose

---

## 🚀 Deployment Automation Scripts

Located in `scripts/` directory (executable):

### `deploy.sh` (200 lines)
One-command automated deployment:

**Usage**:
```bash
./scripts/deploy.sh
```

**What it does**:
1. **Interactive prompts**:
   - Domain name
   - Admin email
   - Cloudflare API token
   - MongoDB URI
   - Number of VPS (1-10)
   - Role selection

2. **Terraform phase**:
   - Initializes Terraform
   - Plans VPS creation
   - Applies to create servers
   - Extracts VPS IPs

3. **Ansible phase**:
   - Validates playbook syntax
   - Runs on all servers in parallel
   - Configures all roles
   - Verifies services

4. **Output**:
   - Deployment summary
   - Next steps and commands
   - Service URLs and verification methods

**Time**: 15-30 minutes for 3 servers

### `cleanup.sh` (180 lines)
Infrastructure cleanup script:

**Usage**:
```bash
./scripts/cleanup.sh
```

**Options**:
1. **local**: Remove Docker containers, volumes, networks
2. **remote**: Stop services on VPS servers (via Ansible)
3. **terraform**: Destroy VPS infrastructure
4. **all**: Everything (local + remote + terraform)

**Safety Features**:
- Confirmation prompts for all operations
- Prevents accidental infrastructure destruction
- Checks dependencies before cleanup
- Displays what will be deleted

---

## 📁 Complete File Structure

```
jrok/
├── Dockerfile                      # Application container
├── docker-compose.yml              # Service orchestration
├── .dockerignore                   # Build optimization
│
├── ansible/
│   ├── playbook.yml                # Main orchestration (90 lines)
│   ├── inventory.ini               # Host configuration (50 lines)
│   └── roles/
│       ├── docker/
│       │   └── tasks/main.yml      # Docker installation (40 lines)
│       ├── certbot/
│       │   └── tasks/main.yml      # SSL certificates (100 lines)
│       ├── nginx/
│       │   └── tasks/main.yml      # Reverse proxy (150 lines)
│       └── app/
│           └── tasks/main.yml      # App deployment (70 lines)
│
├── scripts/
│   ├── deploy.sh                   # Automated deployment (200 lines)
│   └── cleanup.sh                  # Infrastructure cleanup (180 lines)
│
├── AUTOMATION_SUITE_SUMMARY.md     # Overview and summary (250 lines)
├── DEPLOYMENT_GUIDE.md             # Complete walkthrough (400 lines)
├── DOCKER_ANSIBLE_GUIDE.md         # Technical guide (500 lines)
└── RESOURCE_GUIDE.md               # This file
```

---

## 🎯 Deployment Methods

### Method 1: Local Testing (Fastest)
```bash
docker-compose up -d
curl http://localhost:3000/health
```
**Time**: 2-3 minutes
**Cost**: Free

### Method 2: Single VPS (Most Common)
```bash
tofu apply -var="vps_count=1"
ansible-playbook ansible/playbook.yml -i ansible/inventory.ini
```
**Time**: 10-15 minutes
**Cost**: $5-12/month

### Method 3: Multi-Node Cluster (Recommended)
```bash
tofu apply -var="vps_count=3" -var="regions=['sgp1','nyc1','lon1']"
ansible-playbook ansible/playbook.yml -i ansible/inventory.ini
```
**Time**: 15-20 minutes
**Cost**: $15-36/month
**Benefit**: Geographic redundancy

### Method 4: Fully Automated (Recommended for Beginners)
```bash
./scripts/deploy.sh
```
**Time**: 20-30 minutes
**Effort**: Minimal (just answer prompts)

---

## 📋 Configuration Files to Customize

### For Single-Node Deployment:

**`.env`** (create manually):
```bash
NODE_ENV=production
MONGODB_URI=mongodb+srv://user:password@...
CERT_SYNC_API_KEY=your-secure-key
SERVER_ID=local-server
```

### For Multi-Node Deployment:

**`ansible/inventory.ini`** (customize with your VPS IPs):
```ini
[JROK_SERVERs]
vps-sgp1 ansible_host=YOUR_IP_1
vps-nyc1 ansible_host=YOUR_IP_2
vps-lon1 ansible_host=YOUR_IP_3

[JROK_SERVERs:vars]
domain_name=example.com
certbot_email=admin@example.com
cloudflare_token=YOUR_TOKEN
mongodb_uri=YOUR_MONGODB_URI
```

---

## 🔍 Verification Commands

### After Deployment:

```bash
# Test application health
curl https://your-domain/health

# Check certificate status
ssh ubuntu@VPS_IP sudo certbot certificates

# View Docker services
ssh ubuntu@VPS_IP docker-compose ps

# Monitor certificate renewal logs
ssh ubuntu@VPS_IP sudo tail -f /var/log/certbot-sync.log

# Check MongoDB sync
mongosh --uri "mongodb+srv://..." 
db.certificates.find().pretty()
```

---

## 🛠️ Troubleshooting Quick Links

| Issue | Location |
|-------|----------|
| Docker won't start | DEPLOYMENT_GUIDE.md → Docker Issues |
| Certificate not issued | DEPLOYMENT_GUIDE.md → Certificate Issues |
| Nginx not proxying | DEPLOYMENT_GUIDE.md → Nginx Issues |
| Ansible connection failed | DEPLOYMENT_GUIDE.md → Ansible Issues |
| MongoDB connection error | DEPLOYMENT_GUIDE.md → MongoDB Issues |
| Container crashes | DOCKER_ANSIBLE_GUIDE.md → Troubleshooting |

---

## 📞 Support Resources

### Reading Order:
1. **Start**: AUTOMATION_SUITE_SUMMARY.md (overview)
2. **Then**: DEPLOYMENT_GUIDE.md (your deployment method)
3. **Deep-dive**: DOCKER_ANSIBLE_GUIDE.md (understand architecture)
4. **Reference**: This file (RESOURCE_GUIDE.md)

### External Resources:
- Docker: https://docs.docker.com/
- Ansible: https://docs.ansible.com/
- Certbot: https://certbot.eff.org/docs/
- Nginx: https://docs.nginx.com/
- Terraform: https://www.terraform.io/docs

---

## 🎓 Features Summary

✅ **Containerization**: Multi-stage Docker builds
✅ **Infrastructure**: Terraform dynamic VPS creation
✅ **Configuration**: Ansible role-based automation
✅ **SSL/TLS**: Certbot with Cloudflare DNS
✅ **Reverse Proxy**: Nginx with rate limiting
✅ **Certificate Sync**: MongoDB-based leader election
✅ **Health Checks**: Automatic container restart
✅ **Firewall**: UFW with port restrictions
✅ **Service Management**: systemd persistence
✅ **Documentation**: 1,500+ lines of guides
✅ **Automation**: One-command deployment
✅ **Cleanup**: Safe infrastructure teardown

---

## 📊 Statistics

| Category | Count | Lines |
|----------|-------|-------|
| Docker files | 3 | 155 |
| Ansible playbook | 1 | 90 |
| Ansible roles | 4 | 360 |
| Ansible inventory | 1 | 50 |
| Deployment scripts | 2 | 380 |
| Documentation | 4 | 1,550 |
| **TOTAL** | **15 files** | **~2,585 lines** |

---

## 🚀 Next Steps

1. **Read**: Start with AUTOMATION_SUITE_SUMMARY.md
2. **Choose**: Pick a deployment method (local, single, multi, auto)
3. **Follow**: Use DEPLOYMENT_GUIDE.md for step-by-step instructions
4. **Deploy**: Run docker-compose or ./scripts/deploy.sh
5. **Verify**: Test with curl https://your-domain/health
6. **Monitor**: Watch logs and certificate renewals
7. **Scale**: Add more VPS as needed with Terraform

---

**Status**: ✅ Complete and ready for deployment!
