# Self-Hosting Guide

Deploy your own KProxy server for complete control over your tunnel infrastructure. This guide covers everything from zero to production.

KProxy puts **Cloudflare** in front of every node for edge TLS and load balancing, and routes
across nodes with an in-memory **gossip mesh**. There is **no nginx and no Certbot/Let's Encrypt** —
Cloudflare owns every public certificate. For the full picture see [Architecture](../getting-started/architecture.md)
and [Cloudflare Setup](../configuration/cloudflare.md).

## 🚀 Quick Deploy (Recommended)

If you have all the required credentials ready, use our automated deploy script:

```bash
git clone https://github.com/koompi/jrok.git
cd jrok
./scripts/deploy.sh
```

The script will interactively guide you through:
- Creating VPS servers on DigitalOcean (via Terraform)
- Configuring proxied Cloudflare DNS and the Load Balancer origin pool
- Deploying the application (via Ansible)
- Verifying the deployment

**Required credentials for automated deploy:**
- DigitalOcean API Token
- Cloudflare API Token (with **SSL and Certificates: Edit** for custom hostnames) and Zone ID
- MongoDB Atlas Connection String
- KOOMPI ID OAuth Credentials (Client ID & Secret)

See [Getting Credentials](#step-1-get-required-credentials) below for how to obtain each.

---

## Prerequisites

Before you begin, you'll need:

| Requirement | Where to Get It |
|-------------|-----------------|
| Domain name | Any domain registrar |
| DigitalOcean account | [digitalocean.com](https://cloud.digitalocean.com) |
| Cloudflare account (zone added) | [cloudflare.com](https://dash.cloudflare.com) |
| MongoDB Atlas account | [mongodb.com/atlas](https://cloud.mongodb.com) (free tier) |
| KOOMPI ID developer account | [dash.koompi.org](https://dash.koompi.org) |
| SSH key pair | Generate with `ssh-keygen -t rsa -b 4096` |

## Deployment Options

| Method | Best For | Time |
|--------|----------|------|
| **[Automated Script](#automated-deployment)** | Most users | ~10 min |
| **[Manual Setup](#manual-deployment)** | Custom configurations | ~30 min |
| **[Docker](./docker.md)** | Container environments | ~15 min |

---

## Step 1: Get Required Credentials

### 1.1 DigitalOcean API Token

1. Log in to [DigitalOcean](https://cloud.digitalocean.com)
2. Go to **API** → **Tokens**
3. Click **Generate New Token**
4. Name it (e.g., "kproxy-terraform")
5. Select **Read & Write** scope
6. Copy and save the token securely

### 1.2 Cloudflare API Token + Zone ID

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Go to your domain → **Overview**
3. Copy your **Zone ID** (right sidebar) — this is `CF_ZONE_ID`
4. Go to **My Profile** → **API Tokens** → **Create Token**
5. Grant **SSL and Certificates: Edit** (and **Zone: Read**) scoped to your zone — this is `CF_API_TOKEN`
6. Create the token and copy it

> The Cloudflare token here is used by KProxy at runtime to register **Custom Hostnames**
> (Cloudflare for SaaS) for customer custom domains. There is no Certbot/DNS-01 challenge anymore.

### 1.3 MongoDB Atlas Connection String

1. Log in to [MongoDB Atlas](https://cloud.mongodb.com)
2. Create a free cluster (or use existing)
3. Go to **Database Access** → Create a database user
4. Go to **Network Access** → Add your VPS IPs (or `0.0.0.0/0` for dynamic IPs)
5. Go to **Database** → **Connect** → **Connect your application**
6. Copy the connection string (replace `<password>` with your password). MongoDB holds only
   cold/durable state — it is **off the request hot path**.

### 1.4 KOOMPI ID OAuth Credentials

1. Log in to [KOOMPI Developer Dashboard](https://dash.koompi.org)
2. Create a new project/application
3. Set the OAuth redirect URI:
   ```
   https://live.yourdomain.com/auth/callback
   ```
4. Copy **Client ID** and **Client Secret**

## Step 2: Provision VPS with Terraform

### 2.1 Install Terraform/OpenTofu

```bash
# macOS
brew install opentofu

# Linux
curl -fsSL https://get.opentofu.org/install-opentofu.sh | bash

# Verify installation
tofu version
```

### 2.2 Configure Terraform

Clone the repository and navigate to the project:

```bash
git clone https://github.com/koompi/jrok.git
cd jrok
```

### 2.3 Deploy Infrastructure

```bash
# Initialize Terraform
tofu init

# Preview changes
tofu plan -out=tfplan

# Apply changes
tofu apply tfplan
```

**Output:**
```
vps_servers = [
  {
    "ip_address" = "152.42.226.37"
    "name"       = "kproxy-1"
    "region"     = "sgp1"
  }
]
```

Save the IP address(es) for the next steps.

---

## Automated Deployment

### Using the Deploy Script

The easiest way to deploy KProxy is using our automated script:

```bash
./scripts/deploy.sh
```

#### What the Script Does

1. **Prompts for configuration** — Domain, credentials, etc.
2. **Saves configuration** — To `.deploy.env` for future runs
3. **Creates VPS servers** — Using Terraform/OpenTofu
4. **Syncs application code** — Via rsync to a staging directory
5. **Configures servers** — Using Ansible (`docker` + `app` roles)
6. **Starts services** — The `kproxy` systemd service on each node

Edge TLS, the Load Balancer, and customer-domain certificates are all handled by **Cloudflare**
(see [Cloudflare Setup](../configuration/cloudflare.md)); there is no Certbot or nginx to install.

#### Interactive Prompts

```
╔════════════════════════════════════════╗
║  kproxy Deployment Script                ║
╚════════════════════════════════════════╝

Step 1: Configuration

Base domain (e.g., live.yourdomain.com): live.yourdomain.com
Cloudflare API token (SSL and Certificates: Edit): xxxxxx
Cloudflare Zone ID: xxxxxx
Cloudflare for SaaS fallback hostname [live.yourdomain.com]:
MongoDB Atlas URI: mongodb+srv://user:pass@cluster.mongodb.net/kproxy

--- KOOMPI OAuth Configuration ---
Please go to https://dash.koompi.org to create an account and project.

KOOMPI Client ID: koompi_xxxxx
KOOMPI Client Secret: secret_xxxxx
KOOMPI Redirect URI [https://live.yourdomain.com/auth/callback]:
Dashboard URL [https://live.yourdomain.com]:

✓ Configuration saved

Step 2: Infrastructure Settings

Number of VPS servers to create [1]: 1
✓ Will create 1 VPS server(s)

Run Terraform to create VPS servers? (yes/no): yes
```

#### Re-running the Script

Configuration is saved to `.deploy.env`. On subsequent runs:

```bash
./scripts/deploy.sh

# Output:
Found existing configuration in .deploy.env
Use saved configuration? (yes/no): yes
✓ Using saved configuration
```

#### Selective Deployment

The script lets you choose which Ansible roles to run:

```
Select which roles to configure:
  1) All roles (recommended for fresh servers)
  2) Docker only
  3) App only

Select option (1-3) [1]:
```

> Only the `docker` and `app` roles exist. The old `certbot` and `nginx` roles were removed when
> TLS moved to Cloudflare and routing moved to the gossip mesh.

---

## Manual Deployment

If you prefer manual control, follow these steps.

### Step 2.1: Create terraform.tfvars

Create a `terraform.tfvars` file:

```hcl
# terraform.tfvars
do_token  = "your-digitalocean-api-token"
vps_count = 1                           # Number of VPS servers
regions   = ["sgp1"]                    # DigitalOcean regions
```

Then `tofu init && tofu apply` as in Step 2.3 above.

## Step 3: Configure Cloudflare DNS + Load Balancer

### 3.1 Add DNS Records in Cloudflare (proxied)

1. Go to your domain in Cloudflare → **DNS**
2. Add these records as **Proxied (orange cloud)** so the edge terminates TLS:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A / CNAME | `live` | your LB / node | **Proxied (orange)** |
| A / CNAME | `*.live` | your LB / node | **Proxied (orange)** |

Universal SSL automatically covers `live.yourdomain.com` and one wildcard level
`*.live.yourdomain.com` — auto-renewed, zero work.

### 3.2 Origin TLS + Load Balancer

- Install **one Cloudflare Origin CA certificate** on each node (or run `cloudflared` for zero certs).
- Create a **Load Balancer origin pool** containing every node with a `GET /health` check.
- Lock origins to **Cloudflare IPs** so nobody bypasses the edge.

Full steps are in [Cloudflare Setup](../configuration/cloudflare.md).

### 3.3 Verify DNS Propagation

```bash
# Check main domain
dig live.yourdomain.com +short

# Check wildcard
dig test.live.yourdomain.com +short
```

## Step 4: Deploy with Ansible

### 4.1 Install Ansible

```bash
# macOS
brew install ansible

# Linux
pip3 install ansible

# Verify
ansible --version
```

### 4.2 Configure Ansible Inventory

Edit `ansible/inventory.ini`:

```ini
[kproxy_servers]
vps-1 ansible_host=YOUR_VPS_IP ansible_user=root ansible_ssh_private_key_file=~/.ssh/id_rsa

[kproxy_servers:vars]
# Domain configuration
base_domain=live.yourdomain.com

# Cloudflare for SaaS (customer custom domains)
cf_api_token=YOUR_CLOUDFLARE_API_TOKEN     # SSL and Certificates: Edit
cf_zone_id=YOUR_CLOUDFLARE_ZONE_ID
cf_saas_fallback_hostname=live.yourdomain.com

# Gossip routing mesh (same secret on every node)
gossip_secret=YOUR_SHARED_GOSSIP_SECRET

# Per-node identity (unique VPS_ID, reachable VPS_HOST for /_gossip)
vps_id=node-a
vps_host=10.0.0.11
vps_name=kproxy-1
vps_region=sgp1

# MongoDB (cold/durable state)
mongodb_uri=mongodb+srv://user:password@cluster.mongodb.net/kproxy?retryWrites=true&w=majority

# KOOMPI OAuth (dashboard login)
koompi_client_id=YOUR_KOOMPI_CLIENT_ID
koompi_client_secret=YOUR_KOOMPI_CLIENT_SECRET
koompi_redirect_uri=https://live.yourdomain.com/auth/callback

# Dashboard URL
dashboard_url=https://live.yourdomain.com

# Security secret (generate with: openssl rand -base64 64)
jwt_secret=generate-a-secure-64-char-random-string

# Repository settings
repo_url=https://github.com/koompi/jrok.git
repo_branch=main
app_dir=/opt/kproxy
```

> For multi-node deployments, give **each node a unique `vps_id`/`vps_host`** and the **same
> `gossip_secret`**. See [Multi-Server Deployment](./multi-server.md).

### 4.3 Generate Secure Secrets

```bash
# Generate JWT secret
openssl rand -base64 64

# Generate gossip secret
openssl rand -hex 32
```

### 4.4 Run Ansible Playbook

```bash
cd ansible

# Test connection
ansible -i inventory.ini all -m ping

# Run full deployment
ansible-playbook -i inventory.ini playbook.yml

# Or run specific roles
ansible-playbook -i inventory.ini playbook.yml --tags "docker,app"
```

### 4.5 Verify Deployment

```bash
# SSH into server
ssh root@YOUR_VPS_IP

# Check service status
systemctl status kproxy

# Check logs (look for "gossip: connected to peer" in multi-node setups)
journalctl -u kproxy -f
```

## Step 5: Deploy Dashboard (Optional)

The dashboard is a static Vite build. Host it on Cloudflare Pages, an object store, or any
static host, and point it at your KProxy API:

```bash
# On your local machine
cd dashboard
npm install
npm run build
# Deploy ./dist to your static host of choice
```

## Step 6: Test Your Deployment

### 6.1 Test API Health

```bash
curl https://live.yourdomain.com/health
```

Expected response:
```json
{"success": true, "message": "Server is running"}
```

### 6.2 Test CLI Connection

```bash
# Install CLI
npm install -g kproxy

# Configure
kproxy config --server https://live.yourdomain.com --auth YOUR_API_KEY

# Connect a service
kproxy http 3000
```

---

## Troubleshooting

### TLS / Certificate Issues

Certificates are managed by Cloudflare, not on the node:

- **Your subdomains** → check **SSL/TLS → Edge Certificates** (Universal SSL) in the dashboard.
- **Customer custom domains** → check **SSL/TLS → Custom Hostnames** for the hostname status.
- Confirm SSL/TLS mode is **Full (strict)** and the Origin CA cert (or `cloudflared`) is in place.

```bash
# Edge cert is live (browser ⇄ Cloudflare)
curl -I https://live.yourdomain.com/health        # HTTP/2 200
```

### Connection Refused

```bash
# Check if service is running
systemctl status kproxy

# Check firewall (allow :443 from Cloudflare IPs, plus your TCP tunnel range)
sudo ufw status

# Check if the app port is listening
ss -tlnp | grep 3000
```

### Gossip Peers Not Connecting (multi-node)

```bash
# Confirm VPS_HOST:PORT/_gossip is reachable node-to-node (private network)
# Confirm GOSSIP_SECRET is identical on every node (mismatch → 403 on /_gossip)
# Confirm each VPS_ID is unique
journalctl -u kproxy | grep gossip
```

### MongoDB Connection Failed

```bash
# Test MongoDB connection
mongosh "YOUR_CONNECTION_STRING"

# Check if your VPS IP is whitelisted in Atlas (Network Access)
```

---

## Next Steps

- [Cloudflare Setup](../configuration/cloudflare.md) — edge TLS, Load Balancer, Cloudflare for SaaS
- [Environment Variables](../configuration/environment.md) — all configuration options
- [Multi-Server Deployment](./multi-server.md) — the gossip mesh and scaling
