# Self-Hosting Guide

Deploy your own Jrok server for complete control over your tunnel infrastructure. This guide covers everything from zero to production.

## 🚀 Quick Deploy (Recommended)

If you have all the required credentials ready, use our automated deploy script:

```bash
git clone https://github.com/koompi/jrok.git
cd jrok
./scripts/deploy.sh
```

The script will interactively guide you through:
- Creating VPS servers on DigitalOcean (via Terraform)
- Configuring DNS and SSL certificates
- Deploying the application (via Ansible)
- Verifying the deployment

**Required credentials for automated deploy:**
- DigitalOcean API Token
- Cloudflare API Token
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
| Cloudflare account | [cloudflare.com](https://dash.cloudflare.com) |
| MongoDB Atlas account | [mongodb.com/atlas](https://cloud.mongodb.com) (free tier) |
| KOOMPI ID developer account | [dash.koompi.org](https://dash.koompi.org) |
| SSH key pair | Generate with `ssh-keygen -t rsa -b 4096` |

## Deployment Options

| Method | Best For | Time |
|--------|----------|------|
| **[Automated Script](#automated-deployment)** | Most users | ~10 min |
| **[Manual Setup](#manual-deployment)** | Custom configurations | ~30 min |
| **[Docker](#docker-deployment)** | Container environments | ~15 min |

---

## Step 1: Get Required Credentials

## Step 1: Get Required Credentials

### 1.1 DigitalOcean API Token

1. Log in to [DigitalOcean](https://cloud.digitalocean.com)
2. Go to **API** → **Tokens**
3. Click **Generate New Token**
4. Name it (e.g., "jrok-terraform")
5. Select **Read & Write** scope
6. Copy and save the token securely

### 1.2 Cloudflare API Token

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Go to your domain → **Overview**
3. Copy your **Zone ID** (right sidebar)
4. Go to **My Profile** → **API Tokens**
5. Click **Create Token**
6. Use **Edit zone DNS** template
7. Select your specific zone
8. Create token and copy it

### 1.3 MongoDB Atlas Connection String

1. Log in to [MongoDB Atlas](https://cloud.mongodb.com)
2. Create a free cluster (or use existing)
3. Go to **Database Access** → Create a database user
4. Go to **Network Access** → Add IP `0.0.0.0/0` (allow all)
5. Go to **Database** → **Connect** → **Connect your application**
6. Copy the connection string (replace `<password>` with your password)

### 1.4 KOOMPI ID OAuth Credentials

1. Log in to [KOOMPI Developer Dashboard](https://dash.koompi.org)
2. Create a new project/application
3. Set the OAuth redirect URI:
   ```
   https://tunnel.yourdomain.com/auth/callback
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

---

## Automated Deployment

### Using the Deploy Script

The easiest way to deploy Jrok is using our automated script:

```bash
./scripts/deploy.sh
```

#### What the Script Does

1. **Prompts for configuration** - Domain, credentials, etc.
2. **Saves configuration** - To `.deploy.env` for future runs
3. **Creates VPS servers** - Using Terraform/OpenTofu
4. **Syncs application code** - Via rsync to staging directory
5. **Configures servers** - Using Ansible playbooks
6. **Issues SSL certificates** - Via Certbot + Cloudflare DNS
7. **Starts services** - Jrok server + Nginx

#### Interactive Prompts

```
╔════════════════════════════════════════╗
║  jrok Deployment Script                ║
╚════════════════════════════════════════╝

Step 1: Configuration

Domain name (e.g., example.com): tunnel.yourdomain.com
Admin email (for Let's Encrypt): admin@yourdomain.com
Cloudflare API token: xxxxxx
Cloudflare email address: admin@yourdomain.com
MongoDB Atlas URI: mongodb+srv://user:pass@cluster.mongodb.net/jrok

--- KOOMPI OAuth Configuration ---
Please go to https://dash.koompi.org to create an account and project.

KOOMPI Client ID: koompi_xxxxx
KOOMPI Client Secret: secret_xxxxx
KOOMPI Redirect URI [https://tunnel.yourdomain.com/auth/callback]: 
Dashboard URL [https://tunnel.yourdomain.com]: 

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

The script lets you choose which components to deploy:

```
Select which roles to configure:
  1) All roles (recommended for fresh servers)
  2) Docker only
  3) Certbot only
  4) Nginx only
  5) App only

Select option (1-5) [1]: 
```

---

## Manual Deployment

If you prefer manual control, follow these steps:

### Step 2.1: Create terraform.tfvars

Create a `terraform.tfvars` file:

```hcl
# terraform.tfvars
do_token  = "your-digitalocean-api-token"
vps_count = 1                           # Number of VPS servers
regions   = ["sgp1"]                    # DigitalOcean regions
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
    "name"       = "jrok-1"
    "region"     = "sgp1"
  }
]
```

Save the IP address for the next steps.

## Step 3: Configure DNS

### 3.1 Add DNS Records in Cloudflare

1. Go to your domain in Cloudflare → **DNS**
2. Add these records:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | tunnel | `YOUR_VPS_IP` | DNS only (gray cloud) |
| A | *.tunnel | `YOUR_VPS_IP` | DNS only (gray cloud) |

> ⚠️ **Important**: Disable Cloudflare proxy (orange cloud) for wildcard SSL to work with Let's Encrypt.

### 3.2 Verify DNS Propagation

```bash
# Check main domain
dig tunnel.yourdomain.com +short

# Check wildcard
dig test.tunnel.yourdomain.com +short
```

Both should return your VPS IP address.

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
[jrok_servers]
vps-1 ansible_host=YOUR_VPS_IP ansible_user=root ansible_ssh_private_key_file=~/.ssh/id_rsa

[jrok_servers:vars]
# Domain configuration
domain_name=tunnel.yourdomain.com
certbot_email=your-email@example.com

# Cloudflare (for wildcard SSL)
cloudflare_token=YOUR_CLOUDFLARE_TOKEN

# MongoDB
mongodb_uri=mongodb+srv://user:pass@cluster.mongodb.net/jrok?retryWrites=true&w=majority

# KOOMPI OAuth
koompi_client_id=YOUR_CLIENT_ID
koompi_client_secret=YOUR_CLIENT_SECRET
koompi_redirect_uri=https://tunnel.yourdomain.com/auth/callback

# Dashboard URL
dashboard_url=https://tunnel.yourdomain.com

# Security
jwt_secret=generate-a-secure-64-char-random-string
cert_sync_api_key=generate-another-secure-string

# Application
repo_url=https://github.com/koompi/jrok.git
repo_branch=main
app_dir=/opt/jrok
```

### 4.3 Generate Secure Secrets

```bash
# Generate JWT secret
openssl rand -base64 64

# Generate API key
openssl rand -hex 32
```

### 4.4 Run Ansible Playbook

```bash
cd ansible

# Test connection
ansible -i inventory.ini all -m ping

# Run full deployment
ansible-playbook -i inventory.ini playbook.yml

# Or run specific tasks
ansible-playbook -i inventory.ini playbook.yml --tags "certbot,nginx,app"
```

### 4.5 Verify Deployment

```bash
# SSH into server
ssh root@YOUR_VPS_IP

# Check service status
systemctl status jrok

# Check logs
journalctl -u jrok -f

# Check nginx
nginx -t
systemctl status nginx

# Check certificate
certbot certificates
```

## Step 5: Deploy Dashboard (Optional)

If you want to host the dashboard on the same server:

```bash
# On your local machine
cd dashboard
npm install
npm run build

# Copy build to server
scp -r dist/* root@YOUR_VPS_IP:/var/www/dashboard/
```

Update Nginx to serve the dashboard at the root domain.

## Step 6: Test Your Deployment

### 6.1 Test API Health

```bash
curl https://tunnel.yourdomain.com/health
```

Expected response:
```json
{"success": true, "message": "Server is running"}
```

### 6.2 Test CLI Connection

```bash
# Install CLI
npm install -g @koompi/jrok

# Configure
jrok config --server https://tunnel.yourdomain.com --auth YOUR_API_KEY

# Connect a service
jrok --port 3000
```

---

## Troubleshooting

### SSL Certificate Issues

```bash
# Check certificate
sudo certbot certificates

# Force renewal
sudo certbot renew --force-renewal

# Check Cloudflare token
cat /etc/letsencrypt/secrets/cloudflare.ini
```

### Connection Refused

```bash
# Check if service is running
systemctl status jrok

# Check firewall
sudo ufw status
sudo ufw allow 3000

# Check if port is listening
ss -tlnp | grep 3000
```

### MongoDB Connection Failed

```bash
# Test MongoDB connection
mongosh "YOUR_CONNECTION_STRING"

# Check if IP is whitelisted in Atlas
# Network Access → Add Current IP Address
```

---

## Next Steps

- [Environment Variables](../configuration/environment.md) - All configuration options
- [Multi-Server Setup](../advanced/multi-server.md) - High availability
- [Custom Domains](../advanced/custom-domains.md) - User-provided domains
