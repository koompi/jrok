# Complete Setup Guide - jrok with tunnel.koompi.cloud

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Step 1: Prepare Your 3 Ubuntu VPS Servers](#step-1-prepare-your-3-ubuntu-vps-servers)
3. [Step 2: Setup MongoDB Atlas](#step-2-setup-mongodb-atlas)
4. [Step 3: Configure Cloudflare DNS & Get API Token](#step-3-configure-cloudflare-dns--get-api-token)
5. [Step 4: Issue Wildcard Certificate](#step-4-issue-wildcard-certificate)
6. [Step 5: Deploy Control Server](#step-5-deploy-control-server)
7. [Step 6: Deploy VPS Agent Servers](#step-6-deploy-vps-agent-servers)
8. [Step 7: Register VPS Servers in Control](#step-7-register-vps-servers-in-control)
9. [Step 8: Testing](#step-8-testing)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

You will need:
- ✅ 3 new Ubuntu 22.04 LTS VPS servers (minimum 1GB RAM, 20GB SSD each)
- ✅ Cloudflare account with domain `koompi.cloud` (free or paid)
- ✅ MongoDB Atlas free tier account (M0 cluster with 3 replicas)
- ✅ Bun runtime installed on your machine (for development)
- ✅ SSH access to all servers with public key authentication
- ✅ Telegram account for notifications (highly recommended for production)
- ✅ Local machine with curl, openssl, git installed
- ✅ Registered domain and DNS access

**Before You Start:**
- Ensure SSH key-based auth is configured (not password)
- Test SSH connection to each VPS before proceeding
- Verify firewall allows ports 22, 80, 443 on all VPS
- Ensure system clocks are synchronized (critical for certs)

---

## Step 1: Prepare Your 3 Ubuntu VPS Servers

### On Each of Your 3 Ubuntu VPS Servers

Run these commands on **EACH VPS**:

```bash
# SSH into each VPS
ssh root@your-vps-ip

# Update system and install security updates
apt update && apt upgrade -y
apt install -y curl wget git htop nano nginx certbot python3-certbot-nginx python3-certbot-dns-cloudflare ufw fail2ban

# Enable and configure firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp      # SSH
ufw allow 80/tcp      # HTTP
ufw allow 443/tcp     # HTTPS
ufw enable

# Enable Fail2Ban to protect SSH
systemctl start fail2ban
systemctl enable fail2ban

# Configure SSH hardening (edit /etc/ssh/sshd_config)
nano /etc/ssh/sshd_config
# Make sure these lines exist:
# Port 22
# PermitRootLogin no  (if you have sudo user, recommended)
# PasswordAuthentication no
# PubkeyAuthentication yes
# X11Forwarding no

# Restart SSH
systemctl restart sshd

# Start and enable nginx
systemctl start nginx
systemctl enable nginx

# Verify nginx is running
nginx -t
systemctl status nginx

# Create directories for certificates with proper permissions
mkdir -p /etc/letsencrypt/live
mkdir -p /var/log/nginx
chmod 755 /etc/letsencrypt/live
chmod 755 /var/log/nginx

# Create application directories
mkdir -p /opt/jrok
mkdir -p /data/cert-backups
chmod 755 /opt/jrok
chmod 755 /data/cert-backups

# SSH key generation (used for management, not certificate syncing)
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N ""
cat ~/.ssh/id_rsa.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
chmod 700 ~/.ssh

# Install jq (for certificate JSON parsing)
apt install -y jq curl

# Set system timezone to UTC (critical for certificate timestamps)
timedatectl set-timezone UTC
date

# Synchronize system time
apt install -y chrony
systemctl restart chrony
chronyc tracking

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version

# Verify all critical services
echo "=== Verification ==="
echo "UFW Status:"
ufw status
echo "Nginx Status:"
systemctl status nginx
echo "Fail2Ban Status:"
systemctl status fail2ban
echo "Time Sync:"
timedatectl status
echo "Bun Version:"
bun --version
```

**CRITICAL: Document your server details NOW:**

Create a file called `VPS_SERVERS.txt` on your local machine:

```
VPS Server 1:
- Name/ID: vps-us-east
- IP Address: 1.2.3.4
- SSH User: root (or your_user)
- SSH Port: 22
- SSH Key Path: ~/.ssh/id_rsa
- Region: US East
- Specs: 1GB RAM, 20GB SSD
- Status: ✓ Verified working

VPS Server 2:
- Name/ID: vps-eu-west
- IP Address: 5.6.7.8
- SSH User: root
- SSH Port: 22
- SSH Key Path: ~/.ssh/id_rsa
- Region: EU West
- Specs: 1GB RAM, 20GB SSD
- Status: ✓ Verified working

VPS Server 3:
- Name/ID: vps-ap-southeast
- IP Address: 9.10.11.12
- SSH User: root
- SSH Port: 22
- SSH Key Path: ~/.ssh/id_rsa
- Region: Asia-Pacific
- Specs: 1GB RAM, 20GB SSD
- Status: ✓ Verified working
```

### Verify All VPS Are Ready

```bash
# Test SSH to each VPS (run from your local machine)
ssh root@1.2.3.4 "ufw status && nginx -t && date"
ssh root@5.6.7.8 "ufw status && nginx -t && date"
ssh root@9.10.11.12 "ufw status && nginx -t && date"

# All should return:
# - UFW: Status: active
# - nginx: ok
# - Current date/time
```

---

## Step 2: Setup MongoDB Atlas

### Create MongoDB Atlas Free Cluster

1. Go to https://www.mongodb.com/cloud/atlas
2. Sign up or login
3. Click **"Build a Cluster"**
4. Select **"M0 (Free)"** tier
5. Choose region closest to your VPS servers (or use AWS US-East)
6. Click **"Create Cluster"** 
7. Wait 5-10 minutes for cluster to be created

### Configure Network Access (Critical for Production)

1. In MongoDB Atlas, go to **Security → Network Access**
2. Click **"Add IP Address"** or **"Add IP Address List"**
3. **Production Setup - Option A (Recommended): Whitelist specific VPS IPs**
   ```
   Add each VPS IP:
   - 1.2.3.4
   - 5.6.7.8
   - 9.10.11.12
   
   Also add your local IP for testing:
   - your-local-machine-ip
   ```
4. **Or Option B (Less Secure): Allow all IPs**
   ```
   - 0.0.0.0/0 (allows any IP, only for testing)
   ```

### Create Database User with Strong Credentials

1. In MongoDB Atlas, go to **Security → Database Access**
2. Click **"Add New Database User"**
3. Fill in:
   - Username: `jrok` (or more secure: `jrok_prod_user`)
   - Password: Generate a **STRONG** password (20+ characters)
     ```bash
     # Generate on your local machine:
     openssl rand -base64 32
     # Example: 7aB9cD3eF5gH2iJ4kL6mN8pQ0rS2tU4vW6x=
     ```
   - Built-in Role: `Atlas Admin` (for production, use `readWrite` on specific DB)
4. Click **"Add User"**
5. **SAVE THIS PASSWORD IN A SECURE LOCATION** (password manager recommended)

### Get Connection String (Critical for .env)

1. In MongoDB Atlas, go to **Database → Clusters**
2. Click **"Connect"** on your cluster
3. Choose **"Drivers"**
4. Select **"Node.js"** and version **"4.0 or later"**
5. Copy the connection string:
   ```
   mongodb+srv://jrok:YOUR_PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. **Replace `YOUR_PASSWORD` with your actual password from step 3**

### Create Database and Collections

1. Click **"Browse Collections"**
2. Click **"Create Database"**
3. Database name: `jrok`
4. Collection name: `tunnels`
5. Click **"Create"**

The application will auto-create other collections when it runs.

### Verify MongoDB Connection

From your local machine, test the connection string:

```bash
# Using mongosh (MongoDB CLI)
mongosh "mongodb+srv://jrok:yourpassword@cluster0.xxxxx.mongodb.net/jrok"

# You should see:
# > (connected successfully)

# List collections
> show collections

# Exit
> exit
```

If connection fails, check:
- Password is URL-encoded if it contains special characters
- IP address is whitelisted
- Username/password are correct

---

## Step 3: Configure Cloudflare DNS & Get API Token

### Add Your Domain to Cloudflare

1. Go to https://dash.cloudflare.com
2. Click **"Add a site"**
3. Enter domain: `koompi.cloud`
4. Select **"Free"** plan
5. Update your domain registrar's nameservers to Cloudflare's nameservers:
   - `nathan.ns.cloudflare.com`
   - `olivia.ns.cloudflare.com`
   
   (The exact names are shown in Cloudflare)

6. Wait 5 minutes for DNS to propagate

### Create A Records for All 3 VPS Servers (Load Balancing)

For scaling, you need to point all 3 VPS IPs so Cloudflare can load balance traffic across them.

1. In Cloudflare, go to **DNS**
2. Click **"Add record"** three times to add all VPS IPs:

**A Record 1:**
- Type: `A`
- Name: `tunnel` (this creates `tunnel.koompi.cloud`)
- IPv4 address: `<your-vps1-ip>`
- Proxy status: **Proxied** (orange cloud)
- TTL: Auto
- Click **"Save"**

**A Record 2:**
- Type: `A`
- Name: `tunnel` (same as above)
- IPv4 address: `<your-vps2-ip>`
- Proxy status: **Proxied** (orange cloud)
- TTL: Auto
- Click **"Save"**

**A Record 3:**
- Type: `A`
- Name: `tunnel` (same as above)
- IPv4 address: `<your-vps3-ip>`
- Proxy status: **Proxied** (orange cloud)
- TTL: Auto
- Click **"Save"**

Now `tunnel.koompi.cloud` resolves to all 3 VPS IPs via **Cloudflare Load Balancing** (free with any plan).

### About SSL/TLS with Cloudflare Proxy (Orange Cloud)

**Important:** You STILL need the Let's Encrypt certificate even with Cloudflare orange proxy!

Here's why:

```
┌──────────────────────────────────────────────────────────┐
│  SSL/TLS Connection Flow                                  │
└──────────────────────────────────────────────────────────┘

HTTPS Request to: app1.tunnel.koompi.cloud
    ↓
[Client ←→ Cloudflare] ← Cloudflare provides SSL cert
    ↓
[Cloudflare ←→ VPS Nginx] ← YOUR Let's Encrypt cert needed!
    ↓
VPS Nginx reverse proxies to localhost:8080

Two SSL connections are needed:
1. Client → Cloudflare: Cloudflare cert (they provide)
2. Cloudflare → Your VPS: YOUR cert (Let's Encrypt)
```

**What Cloudflare orange proxy does:**
- ✅ Provides SSL between client and Cloudflare
- ✅ Hides your VPS real IP
- ✅ Acts as cache/firewall
- ❌ Does NOT remove need for your own certificate

**What happens if you don't have Let's Encrypt cert:**
```
Client: https://app1.tunnel.koompi.cloud
    ↓
Cloudflare: OK, I'll handle that
    ↓
Cloudflare → VPS: sends request over HTTPS
    ↓
VPS Nginx: "I don't have certificate for app1.tunnel.koompi.cloud"
    ↓
ERROR: SSL certificate problem or connection reset
```

### SSL/TLS Modes in Cloudflare

Cloudflare has different modes for "Client → Cloudflare" connection:

**Flexible** (Not Recommended):
```
Client → Cloudflare (HTTPS) → VPS (HTTP)
Insecure! No encryption between Cloudflare and VPS
```

**Full** (Recommended):
```
Client → Cloudflare (HTTPS) → VPS (HTTPS with self-signed cert)
Good enough, but VPS cert warnings
```

**Full (Strict)** (Best):
```
Client → Cloudflare (HTTPS) → VPS (HTTPS with valid cert)
Most secure, requires Let's Encrypt cert
```

**Your setup needs to be:**
1. Cloudflare SSL/TLS mode: **Full (Strict)** ✅
2. VPS has valid Let's Encrypt certificate ✅
3. Nginx configured with certificate paths ✅

So **YES, you still need Let's Encrypt!** The wildcard certificate for `*.koompi.cloud` is essential.

### How This Scales

```
┌─────────────────────────────────────────────────────────┐
│  Client requests: tunnel.koompi.cloud               │
│  (example: app1.tunnel.koompi.cloud)                │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
         ┌─────────────────────────┐
         │  Cloudflare DNS (Free   │
         │  Load Balancing)        │
         │  - Returns all 3 IPs    │
         │  - Client connects to   │
         │    one randomly         │
         └──────┬────┬────┬────────┘
         ┌──────┘    │    └─────────┐
         ▼           ▼              ▼
    ┌────────┐  ┌────────┐    ┌─────────┐
    │ VPS 1  │  │ VPS 2  │    │ VPS 3   │
    │ Nginx  │  │ Nginx  │    │ Nginx   │
    │(router)│  │(router)│    │(router) │
    └────────┘  └────────┘    └─────────┘
         │           │              │
         └─────┬─────┴─────┬────────┘
               │           │
         ┌─────▼─┐    ┌────▼──┐
         │ App 1 │    │ App 2 │
         │ (8080)│    │(8081) │
         └───────┘    └───────┘
```

**What happens when a client connects:**
1. DNS lookup for `app1.tunnel.koompi.cloud`
2. Cloudflare returns one of the 3 VPS IPs (round-robin or performance-based)
3. Client connects to that VPS's nginx
4. Nginx looks up which local port is hosting the tunnel for `app1`
5. Nginx reverse proxies to the local service

**If one VPS goes down:**
- Cloudflare health checks detect the failure
- Subsequent DNS queries return only the healthy IPs
- Existing connections to failed VPS will timeout (but new ones work)
- For instant failover, see "Advanced Load Balancing" below

### Advanced Load Balancing Options (Optional)

If you want **automatic failover** without client retries:

**Option 1: Cloudflare Load Balancer (Free)**
Already using this with 3 A records - good enough for most uses.

**Option 2: Use Cloudflare CNAME + Geo-routing**
Create multiple CNAME records for different regions:
- `tunnel-us.koompi.cloud` → VPS 1 (US)
- `tunnel-eu.koompi.cloud` → VPS 2 (EU)
- `tunnel-ap.koompi.cloud` → VPS 3 (Asia-Pacific)

**Option 3: AWS/DigitalOcean Load Balancer (Paid, $20-40/month)**
```
Internet → Cloudflare → Load Balancer → VPS 1, 2, 3
```
This gives instant failover detection, but costs extra.

**Option 4: Keep Current Setup (Recommended for free tier)**
3 A records + Cloudflare Proxied = Free load balancing
- Works for 99% of use cases
- Clients load balanced automatically
- Good enough for thousands of concurrent users

### Create API Token for Wildcard Certificate

1. In Cloudflare, go to **My Profile → API Tokens**
2. Click **"Create Token"**
3. Look for **"Edit zone DNS"** template and click **"Use template"**
4. Name: `certbot-wildcard`
5. Permissions:
   - Zone / DNS / Edit
   - Zone / Zone / Read
6. Zone Resources: **Include - Specific zone - koompi.cloud**
7. Click **"Create Token"**
8. **Copy and save the token** - you'll need this

Example token (not real):
```
v1.0_abc123def456xyz789ABC123DEF456XYZ789abc123
```

---

## Step 4: Issue Wildcard Certificate & Configure MongoDB Sync

We'll use Certbot with Cloudflare DNS challenge to issue a wildcard certificate, then configure automatic MongoDB-based sync to all VPS servers (no SSH needed).

### On Your Control Server (or local machine)

```bash
# Install certbot and Cloudflare plugin
sudo apt install -y certbot python3-certbot-dns-cloudflare

# Create Cloudflare credentials file
sudo nano /etc/letsencrypt/cloudflare.ini
```

Paste this:
```ini
# Cloudflare API token for DNS validation
dns_cloudflare_api_token = v1.0_abc123def456xyz789ABC123DEF456XYZ789abc123
```

Replace the token with your actual Cloudflare token from Step 3.

```bash
# Set proper permissions (critical for security)
sudo chmod 600 /etc/letsencrypt/cloudflare.ini
sudo chown root:root /etc/letsencrypt/cloudflare.ini

# Verify permissions are correct
ls -la /etc/letsencrypt/cloudflare.ini
# Should show: -rw------- root root

# Issue wildcard certificate
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d koompi.cloud \
  -d "*.koompi.cloud" \
  --email admin@koompi.cloud \
  --agree-tos \
  --non-interactive \
  --preferred-challenges dns-01 \
  --rsa-key-size 4096

# Verify certificate was created
sudo ls -la /etc/letsencrypt/live/koompi.cloud/
```

You should see:
```
cert.pem -> ../../archive/koompi.cloud/cert1.pem
chain.pem -> ../../archive/koompi.cloud/chain1.pem
fullchain.pem -> ../../archive/koompi.cloud/fullchain1.pem
privkey.pem -> ../../archive/koompi.cloud/privkey1.pem
```

### Verify Certificate Details

```bash
# Check certificate expiration date
sudo openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -dates

# Check certificate domains
sudo openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -text | grep -A1 "Subject Alternative Name"

# Should show:
# notBefore=... (issue date)
# notAfter=... (expiration date - 90 days from now)
# DNS:koompi.cloud, DNS:*.koompi.cloud
```

### Setup Automatic Certificate Renewal (Critical for Production)

```bash
# Certbot auto-renewal runs daily via systemd timer
sudo systemctl status certbot.timer
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

# Verify renewal is working
sudo certbot renew --dry-run

# Should see: (success)

# The renewal will automatically sync to all VPS via your sync scripts
```

### Store Certificates in MongoDB (Cloud-Based Sync)

Instead of using SSH/SCP, we store certificates in MongoDB so all VPS servers can pull them independently without direct connections.

```bash
# Control server uploads certificate to MongoDB
curl -X POST http://localhost:3000/certificates/upload \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "koompi.cloud",
    "certPem": "'"$(cat /etc/letsencrypt/live/koompi.cloud/cert.pem | base64 -w0)"'",
    "chainPem": "'"$(cat /etc/letsencrypt/live/koompi.cloud/chain.pem | base64 -w0)"'",
    "fullchainPem": "'"$(cat /etc/letsencrypt/live/koompi.cloud/fullchain.pem | base64 -w0)"'",
    "privkeyPem": "'"$(cat /etc/letsencrypt/live/koompi.cloud/privkey.pem | base64 -w0)"'"
  }'
```

**Why MongoDB Instead of SCP:**
- ✅ No direct VPS-to-VPS connections needed
- ✅ All servers pull from MongoDB (no pushing)
- ✅ Automatically synced across all servers
- ✅ Secure: certificates encrypted in transit and at rest
- ✅ Scalable: add new servers anytime
- ✅ Auditable: timestamp and version tracking
- ✅ Automatic renewal syncs to all servers

### Setup Certificate Sync on Each VPS

Each VPS runs a daemon that periodically pulls certificates from MongoDB:

```bash
# On each VPS, add this to crontab (runs every 6 hours):
0 */6 * * * /usr/local/bin/sync-certificates-from-mongodb.sh

# Or run immediately to test:
/usr/local/bin/sync-certificates-from-mongodb.sh
```

Create the script on each VPS:

```bash
# On each VPS:
sudo nano /usr/local/bin/sync-certificates-from-mongodb.sh
```

Paste:
```bash
#!/bin/bash
set -e

# Configuration
MONGODB_URI="your-mongodb-connection-string"
DOMAIN="koompi.cloud"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
LOG_FILE="/var/log/cert-sync.log"
TEMP_DIR="/tmp/cert-sync"

# Create temp directory
mkdir -p "$TEMP_DIR"

echo "[$(date)] Starting certificate sync from MongoDB..." >> "$LOG_FILE"

# Download certificates from MongoDB
curl -s "http://control-server:3000/certificates/download/$DOMAIN" \
  -H "Authorization: Bearer $API_KEY" \
  -o "$TEMP_DIR/certs.json"

if [ $? -ne 0 ]; then
    echo "[$(date)] ERROR: Failed to download certificates" >> "$LOG_FILE"
    exit 1
fi

# Extract and decode certificates
cat "$TEMP_DIR/certs.json" | jq -r '.cert' | base64 -d > "$TEMP_DIR/cert.pem"
cat "$TEMP_DIR/certs.json" | jq -r '.chain' | base64 -d > "$TEMP_DIR/chain.pem"
cat "$TEMP_DIR/certs.json" | jq -r '.fullchain' | base64 -d > "$TEMP_DIR/fullchain.pem"
cat "$TEMP_DIR/certs.json" | jq -r '.privkey' | base64 -d > "$TEMP_DIR/privkey.pem"

# Verify certificates are valid
openssl x509 -in "$TEMP_DIR/cert.pem" -noout -dates >> "$LOG_FILE" 2>&1

# Copy to proper location (with backup)
if [ -d "$CERT_DIR" ]; then
    tar -czf "$CERT_DIR/backup-$(date +%Y%m%d-%H%M%S).tar.gz" "$CERT_DIR"
fi

sudo cp "$TEMP_DIR/cert.pem" "$CERT_DIR/cert.pem"
sudo cp "$TEMP_DIR/chain.pem" "$CERT_DIR/chain.pem"
sudo cp "$TEMP_DIR/fullchain.pem" "$CERT_DIR/fullchain.pem"
sudo cp "$TEMP_DIR/privkey.pem" "$CERT_DIR/privkey.pem"

# Fix permissions
sudo chmod 644 "$CERT_DIR/cert.pem"
sudo chmod 644 "$CERT_DIR/chain.pem"
sudo chmod 644 "$CERT_DIR/fullchain.pem"
sudo chmod 600 "$CERT_DIR/privkey.pem"
sudo chown -R root:root "$CERT_DIR"

# Reload nginx if certificates changed
CERT_HASH=$(openssl x509 -in "$CERT_DIR/cert.pem" -noout -fingerprint)
echo "$CERT_HASH" > "$TEMP_DIR/cert.hash"

if ! sudo diff -q "$TEMP_DIR/cert.hash" "/var/cache/cert.hash" > /dev/null 2>&1; then
    echo "[$(date)] Certificates updated, reloading nginx..." >> "$LOG_FILE"
    sudo systemctl reload nginx
    sudo cp "$TEMP_DIR/cert.hash" "/var/cache/cert.hash"
else
    echo "[$(date)] Certificates unchanged" >> "$LOG_FILE"
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo "[$(date)] Certificate sync completed successfully" >> "$LOG_FILE"
```

Make it executable:
```bash
sudo chmod +x /usr/local/bin/sync-certificates-from-mongodb.sh
sudo chown root:root /usr/local/bin/sync-certificates-from-mongodb.sh
```

### Automatic Sync on Certificate Renewal

When certbot renews the certificate on the control server, automatically sync to MongoDB:

```bash
# Add to certbot renewal hook
sudo nano /etc/letsencrypt/renewal-hooks/post/sync-to-mongodb.sh
```

Paste:
```bash
#!/bin/bash
# This runs automatically after certbot renews

DOMAIN="koompi.cloud"
API_KEY="your-api-key"
CONTROL_SERVER="http://localhost:3000"

curl -s -X POST "$CONTROL_SERVER/certificates/upload" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "'$DOMAIN'",
    "certPem": "'"$(cat /etc/letsencrypt/live/$DOMAIN/cert.pem | base64 -w0)"'",
    "chainPem": "'"$(cat /etc/letsencrypt/live/$DOMAIN/chain.pem | base64 -w0)"'",
    "fullchainPem": "'"$(cat /etc/letsencrypt/live/$DOMAIN/fullchain.pem | base64 -w0)"'",
    "privkeyPem": "'"$(cat /etc/letsencrypt/live/$DOMAIN/privkey.pem | base64 -w0)"'"
  }' && \
  
# Notify Telegram
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -d "chat_id=$TELEGRAM_CHAT_ID&text=✅ Certificate renewed and synced to MongoDB for $DOMAIN"

exit 0
```

Make executable:
```bash
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/sync-to-mongodb.sh
```

### Verify Certificates Sync Correctly

```bash
# Check certificate in MongoDB
curl http://localhost:3000/certificates/download/koompi.cloud \
  -H "Authorization: Bearer $API_KEY" \
  | jq '.expiry'

# Check on VPS 1
ssh root@1.2.3.4 "openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -dates"

# Check on VPS 2
ssh root@5.6.7.8 "openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -dates"

# Check on VPS 3
ssh root@9.10.11.12 "openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -dates"

# All should show same expiry date
```

---

## Step 5: Deploy Control Server

This is where the jrok application runs. It manages tunnels, domains, and synchronizes certificates.

### Setup on Control Server

```bash
# Clone the jrok repository
git clone https://github.com/koompi/jrok.git
cd jrok

# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version

# Install dependencies
bun install

# Create data directories
mkdir -p ./data/cert-backups
mkdir -p ./logs
chmod 755 ./data/cert-backups
chmod 755 ./logs

# Create .env file with restricted permissions
touch .env
chmod 600 .env
nano .env
```

### Add to .gitignore (never commit secrets)

```bash
echo ".env" >> .gitignore
echo "logs/" >> .gitignore
echo "data/cert-backups/" >> .gitignore
echo "node_modules/" >> .gitignore
git add .gitignore
git commit -m "Add secrets to gitignore"
```

### Paste your .env configuration

(Use the template from Step 5 "Create .env file")

### Test Locally First (Before Production Deployment)

```bash
# Start the server locally
bun run src/index.ts

# In another terminal, test the health endpoint
curl http://localhost:3000/health

# You should see:
# {"success":true,"message":"Server is running"}

# Test MongoDB connection
curl http://localhost:3000/agents \
  -H "Authorization: Bearer your-api-key-from-env"

# Should connect to MongoDB and return agent list

# If tests pass, stop the server (Ctrl+C)
```

### Deploy as Systemd Service (Production)

```bash
# Create systemd service file
sudo nano /etc/systemd/system/jrok.service
```

Paste:
```ini
[Unit]
Description=Jrok tunnel Service - Production
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/jrok
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=jrok
EnvironmentFile=/root/jrok/.env

# Resource limits (prevent crash)
MemoryLimit=512M
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start the service
sudo systemctl daemon-reload
sudo systemctl enable jrok
sudo systemctl start jrok

# Verify it's running
sudo systemctl status jrok

# View real-time logs
sudo journalctl -u jrok -f

# Should see:
# [info] Server running on http://localhost:3000
```

### Setup Log Rotation (Critical for Production)

```bash
# Create logrotate config
sudo nano /etc/logrotate.d/jrok
```

Paste:
```
/root/jrok/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 root root
    sharedscripts
}

/var/log/journal {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
```

```bash
# Test logrotate
sudo logrotate -f /etc/logrotate.d/jrok

# Verify
ls -la /root/jrok/logs/
```

### Monitor Service Health

```bash
# Create a monitoring script
sudo nano /usr/local/bin/check-jrok.sh
```

Paste:
```bash
#!/bin/bash
# Check if jrok is running and responding

HEALTH_CHECK=$(curl -s http://localhost:3000/health 2>/dev/null)

if echo "$HEALTH_CHECK" | grep -q "success.*true"; then
    echo "✅ jrok is running"
    exit 0
else
    echo "❌ jrok is NOT responding"
    systemctl restart jrok
    sleep 5
    curl http://localhost:3000/health
    exit 1
fi
```

```bash
# Make it executable
sudo chmod +x /usr/local/bin/check-jrok.sh

# Add to crontab (check every 5 minutes)
sudo crontab -e

# Add line:
# */5 * * * * /usr/local/bin/check-jrok.sh >> /var/log/jrok-health.log 2>&1
```

### Setup Firewall for Control Server

```bash
# Allow SSH (already done)
sudo ufw allow 22/tcp

# Allow your application port
sudo ufw allow 3000/tcp

# Allow only from specific IPs (your VPS servers) - recommended
sudo ufw allow from 1.2.3.4 to any port 3000
sudo ufw allow from 5.6.7.8 to any port 3000
sudo ufw allow from 9.10.11.12 to any port 3000

# Verify
sudo ufw status numbered
```

```bash
# ============================================
# PRODUCTION CONFIGURATION
# ============================================

# Server Configuration
PORT=3000
VPS_HOST=tunnel.koompi.cloud
VPS_USER=root
VPS_PORT=22
NGINX_PATH=/etc/nginx/sites-available
BASE_DOMAIN=tunnel.koompi.cloud

# API Security (CRITICAL - change this!)
API_KEY=your-super-secret-api-key-change-this-123456

# MongoDB Atlas Connection String (CRITICAL - keep secret!)
# Format: mongodb+srv://username:password@cluster.xxxxx.mongodb.net/dbname?retryWrites=true&w=majority
MONGODB_URI=mongodb+srv://jrok:your-strong-password-here@cluster0.xxxxx.mongodb.net/jrok?retryWrites=true&w=majority

# Telegram Bot Notifications (RECOMMENDED for production)
# Get token from @BotFather on Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
# Get chat ID from @userinfobot on Telegram (negative for groups)
TELEGRAM_CHAT_ID=-123456789

# Backup Configuration
BACKUP_DIR=./data/cert-backups
MAX_BACKUPS_PER_DOMAIN=10

# Environment
NODE_ENV=production

# ============================================
# SECURITY REQUIREMENTS
# ============================================
# - API_KEY: At least 32 random characters (use: openssl rand -base64 32)
# - MONGODB_URI: Must use strong password (20+ chars)
# - TELEGRAM tokens: Keep secret, never commit to git
# - All URLs must use HTTPS in production
# ============================================
```

### Generate Secure Values

```bash
# 1. Generate secure API key
openssl rand -base64 32
# Example: 7aB9cD3eF5gH2iJ4kL6mN8pQ0rS2tU4vW6xYz1aB3cD=

# 2. Generate secure MongoDB password (if creating user)
openssl rand -base64 20
# Example: 9kL2mN4pQ6rS8tU0vW2x

# 3. For Telegram:
#    - Message @BotFather on Telegram
#    - Type: /newbot
#    - Choose name and username
#    - Copy the token
#
#    - Message @userinfobot on Telegram
#    - It will reply with your chat ID (format: 123456789)
#    - If using group, use negative: -123456789
```

### Store .env Securely

```bash
# Create .env with restricted permissions
touch .env
chmod 600 .env

# Never commit to git
echo ".env" >> .gitignore

# Verify only you can read it
ls -la .env
# Should show: -rw------- (600 permissions)
```

---

## Step 6: Test Control Server Locally

```bash
cd jrok

# Run the server
bun run src/index.ts

# In another terminal, test the health endpoint
curl http://localhost:3000/health

# You should see:
# {"success":true,"message":"Server is running"}
```

If everything works, you can proceed to deployment.

---

## Step 7: Deploy VPS Agent Servers

Choose one approach:

### Option A: Deploy as Systemd Service on Each VPS

On **each VPS**:

```bash
# Clone the project
cd /opt
git clone https://github.com/koompi/jrok.git
cd jrok

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Copy .env from control server and modify
scp your-control-server:/path/to/.env .env

# Create systemd service file
sudo nano /etc/systemd/system/jrok.service
```

Paste:
```ini
[Unit]
Description=Jrok tunnel Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/jrok
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
# Start the service
sudo systemctl daemon-reload
sudo systemctl enable jrok
sudo systemctl start jrok
sudo systemctl status jrok

# View logs
sudo journalctl -u jrok -f
```

### Option B: Run as PM2 (with auto-restart)

```bash
# Install PM2 globally
npm install -g pm2
# OR with Bun
bun add -g pm2

# Start the app
pm2 start src/index.ts --name "jrok" --interpreter "bun"
pm2 save
pm2 startup

# Check status
pm2 status
pm2 logs jrok
```

---

## Step 8: Register VPS Servers in Control

Now tell the control server about your 3 VPS servers.

### Get Control Server API Key

From your `.env` file:
```bash
echo $API_KEY
# Or read from .env:
grep API_KEY .env
```

### Register Each VPS

```bash
# VPS 1 Registration
curl -X POST http://control-server-ip:3000/vps \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-from-env" \
  -d '{
    "name": "vps-us-east",
    "host": "your-vps1-ip",
    "sshUser": "root",
    "sshPort": 22,
    "nginxPath": "/etc/nginx/sites-available",
    "region": "us-east"
  }'

# VPS 2 Registration
curl -X POST http://control-server-ip:3000/vps \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-from-env" \
  -d '{
    "name": "vps-eu-west",
    "host": "your-vps2-ip",
    "sshUser": "root",
    "sshPort": 22,
    "nginxPath": "/etc/nginx/sites-available",
    "region": "eu-west"
  }'

# VPS 3 Registration
curl -X POST http://control-server-ip:3000/vps \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-from-env" \
  -d '{
    "name": "vps-ap-southeast",
    "host": "your-vps3-ip",
    "sshUser": "root",
    "sshPort": 22,
    "nginxPath": "/etc/nginx/sites-available",
    "region": "ap-southeast"
  }'

# Verify all VPS are registered
curl http://control-server-ip:3000/vps \
  -H "Authorization: Bearer your-api-key-from-env"
```

---

## Step 9: Register Base Domain

```bash
# Register koompi.cloud as base domain (no cert needed, using system cert)
curl -X POST http://control-server-ip:3000/domains \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-from-env" \
  -d '{
    "domain": "koompi.cloud",
    "certbotEmail": "admin@koompi.cloud",
    "cloudflareToken": "your-cloudflare-token-from-step-3"
  }'

# You should get response:
# {
#   "success": true,
#   "message": "Custom domain registered successfully",
#   "domain": {
#     "id": "...",
#     "domain": "koompi.cloud",
#     "active": true,
#     "synced": true,
#     ...
#   }
# }
```

### Complete Implementation Reference

For detailed configuration of MongoDB certificate sync, including:
- API endpoint specifications
- Full script implementations  
- Security settings & encryption
- Monitoring & alerting procedures
- Troubleshooting guide
- Performance optimization
- Scaling to multiple domains

👉 **See: `MONGODB_CERTIFICATE_STORAGE.md`**

---

## Step 9: Pre-Production Validation Checklist

**Run these tests BEFORE going live:**

### Network & DNS Validation

```bash
# Test DNS resolution (should return 3 IPs)
nslookup tunnel.koompi.cloud
dig tunnel.koompi.cloud +short

# Should return all 3 VPS IPs (in any order):
# 1.2.3.4
# 5.6.7.8
# 9.10.11.12

# Test SSL/TLS connection to each VPS
openssl s_client -connect 1.2.3.4:443 -servername tunnel.koompi.cloud
# Should show certificate for koompi.cloud with status: Verify return code: 0 (ok)

# Repeat for other VPS:
openssl s_client -connect 5.6.7.8:443 -servername tunnel.koompi.cloud
openssl s_client -connect 9.10.11.12:443 -servername tunnel.koompi.cloud
```

### Certificate Validation

```bash
# Check all certificates are identical and valid
echo "=== VPS 1 Certificate ===" && \
  ssh root@1.2.3.4 "openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -fingerprint"

echo "=== VPS 2 Certificate ===" && \
  ssh root@5.6.7.8 "openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -fingerprint"

echo "=== VPS 3 Certificate ===" && \
  ssh root@9.10.11.12 "openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -fingerprint"

# All fingerprints should be IDENTICAL
```

### MongoDB Connection Validation

```bash
# From control server, verify all VPS can reach MongoDB
ssh root@1.2.3.4 "curl -s https://cluster0.mongodb.com -o /dev/null && echo 'VPS 1: ✅ Can reach MongoDB'"
ssh root@5.6.7.8 "curl -s https://cluster0.mongodb.com -o /dev/null && echo 'VPS 2: ✅ Can reach MongoDB'"
ssh root@9.10.11.12 "curl -s https://cluster0.mongodb.com -o /dev/null && echo 'VPS 3: ✅ Can reach MongoDB'"

# Verify connection string works
bun -e "const uri=process.env.MONGODB_URI; console.log('Testing:', uri.split('@')[0]+'@...')"
```

### Service Health Checks

```bash
# Control server health
curl http://localhost:3000/health -v

# VPS nginx status (should all show 200)
curl -k https://tunnel.koompi.cloud/health -v
curl -k https://1.2.3.4/health -v
curl -k https://5.6.7.8/health -v
curl -k https://9.10.11.12/health -v

# All should return HTTP 200 OK
```

### Rate Limiting Validation

```bash
# Test rate limiter (should allow first 5, block 6th)
for i in {1..6}; do 
  echo "Request $i:"
  curl -X POST http://localhost:3000/domains \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"domain":"test'$i'.koompi.cloud"}' \
    -w "HTTP %{http_code}\n"
  sleep 1
done

# Request 6 should return 429 (Too Many Requests)
```

### Telegram Notification Test

```bash
# If Telegram is configured, test it
curl -X POST http://localhost:3000/test-notification \
  -H "Authorization: Bearer $API_KEY"

# Should send test message to your Telegram chat
```

### Load Test (Optional but Recommended)

```bash
# Install Apache Bench (if not installed)
apt install -y apache2-utils

# Simulate 100 concurrent users
ab -n 1000 -c 100 https://tunnel.koompi.cloud/

# Monitor resource usage
watch -n 1 "free -h && ps aux | grep jrok"
```

### Complete Validation Script

Save this as `validate-production.sh`:

```bash
#!/bin/bash
set -e

echo "========================================"
echo "Production Validation Checklist"
echo "========================================"

echo ""
echo "1️⃣ DNS Resolution..."
if nslookup tunnel.koompi.cloud | grep -q "1.2.3.4"; then
    echo "✅ DNS resolves all VPS"
else
    echo "❌ DNS resolution failed"
    exit 1
fi

echo ""
echo "2️⃣ Certificate Validation..."
for ip in 1.2.3.4 5.6.7.8 9.10.11.12; do
    if ssh root@$ip "openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -dates" > /dev/null; then
        echo "✅ Certificate valid on $ip"
    else
        echo "❌ Certificate missing on $ip"
        exit 1
    fi
done

echo ""
echo "3️⃣ Service Health..."
if curl -s http://localhost:3000/health | grep -q "success"; then
    echo "✅ Control server responding"
else
    echo "❌ Control server not responding"
    exit 1
fi

echo ""
echo "4️⃣ MongoDB Connection..."
if curl -s -I https://cluster0.mongodb.com -o /dev/null; then
    echo "✅ MongoDB reachable"
else
    echo "❌ MongoDB unreachable"
    exit 1
fi

echo ""
echo "5️⃣ Firewall Status..."
if ssh root@1.2.3.4 "ufw status | grep -q active"; then
    echo "✅ Firewall enabled on VPS"
else
    echo "⚠️ Firewall may not be configured"
fi

echo ""
echo "========================================"
echo "✅ All validations passed! Ready for production"
echo "========================================"
```

```bash
# Run validation
chmod +x validate-production.sh
./validate-production.sh
```

### Start a Test Service on Your Local Machine

```bash
# Example: Simple HTTP server on port 8080
cd /tmp
python3 -m http.server 8080

# Or with Node.js
npx http-server -p 8080
```

### Run the Agent

```bash
# In jrok directory
bun client.ts \
  --server http://control-server-ip:3000 \
  --domain testapp \
  --port 8080 \
  --auth "your-api-key-from-env"

# You should see:
# Connected to server as agent: agent-abc123
# Listening on testapp.tunnel.koompi.cloud
```

### Access Your Service

```bash
# In another terminal
curl https://testapp.tunnel.koompi.cloud

# You should see the HTTP server response!
# If you used http-server, you'll see the directory listing HTML
```

---

## Step 11: Test All Features

### 1. Test Multiple Tunnels

```bash
# Terminal 1: Tunnel for service A
bun client.ts --server http://control-server:3000 \
  --domain app-a --port 8080 --auth "your-key"

# Terminal 2: Tunnel for service B
bun client.ts --server http://control-server:3000 \
  --domain app-b --port 8081 --auth "your-key"

# Access both:
curl https://app-a.tunnel.koompi.cloud
curl https://app-b.tunnel.koompi.cloud
```

### 2. Test Domain Transfer

```bash
# Transfer domain from VPS 1 to VPS 2
curl -X POST http://control-server:3000/domains/koompi.cloud/transfer \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "targetVpsId": "vps-2-id",
    "includeOtherServers": true
  }'
```

### 3. Test Backup/Restore

```bash
# Create backup
curl -X POST http://control-server:3000/domains/koompi.cloud/backup \
  -H "Authorization: Bearer your-api-key"

# List backups
curl http://control-server:3000/domains/koompi.cloud/backup \
  -H "Authorization: Bearer your-api-key"

# Restore from backup
curl -X POST http://control-server:3000/domains/koompi.cloud/backups/backup-id-here/restore \
  -H "Authorization: Bearer your-api-key"
```

### 4. Check Telegram Notifications

If you set up Telegram:
- You should receive messages when domains are registered
- Messages when certificates sync
- Messages when transfers happen

---

## Production Monitoring & Maintenance

### Daily Checks

```bash
# Check service is running
sudo systemctl status jrok

# Check certificate expiry (should be 30+ days)
sudo openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -dates

# Check disk space
df -h /
# Should be > 10GB free

# Check MongoDB connection
curl -s http://localhost:3000/health | jq .
```

### Weekly Checks

```bash
# Check logs for errors
sudo journalctl -u jrok --since "7 days ago" | grep -i error

# Test certificate renewal (30 days before expiry)
sudo certbot renew --dry-run

# Verify all VPS are responding
for ip in 1.2.3.4 5.6.7.8 9.10.11.12; do
    echo "Checking $ip:"
    ssh root@$ip "systemctl status nginx && echo 'Nginx OK'"
done

# Review nginx access logs for suspicious activity
ssh root@1.2.3.4 "tail -100 /var/log/nginx/access.log | grep -i error"
```

### Monthly Checks

```bash
# Full backup of MongoDB
# (MongoDB Atlas handles this automatically for you)

# Review rate limiting statistics
curl http://localhost:3000/rate-limit-stats \
  -H "Authorization: Bearer $API_KEY"

# Test disaster recovery (restore from backup)
curl -X POST http://localhost:3000/domains/koompi.cloud/backup \
  -H "Authorization: Bearer $API_KEY"

# Verify certificate backups exist
ls -lah ./data/cert-backups/
```

### Automated Backup Script

Create `/usr/local/bin/jrok-backup.sh`:

```bash
#!/bin/bash
BACKUP_DIR="/backups/jrok"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p $BACKUP_DIR

# Backup certificates
tar -czf $BACKUP_DIR/certs-$DATE.tar.gz /etc/letsencrypt/live/koompi.cloud/

# Backup .env (keep separate, encrypted)
tar -czf $BACKUP_DIR/.env-$DATE.tar.gz /root/jrok/.env

# Backup application data
tar -czf $BACKUP_DIR/app-data-$DATE.tar.gz /root/jrok/data/

# Keep only last 30 days
find $BACKUP_DIR -name "*.tar.gz" -mtime +30 -delete

echo "✅ Backup complete: $BACKUP_DIR/"
```

```bash
# Make executable
sudo chmod +x /usr/local/bin/jrok-backup.sh

# Run daily at 2 AM
sudo crontab -e
# Add: 0 2 * * * /usr/local/bin/jrok-backup.sh >> /var/log/jrok-backup.log 2>&1
```

### Certificate Auto-Renewal Validation

```bash
# Certbot automatically renews 30 days before expiry
# Verify renewal is working:

sudo certbot certificates

# Should show:
# Certificate Name: koompi.cloud
# Domains: koompi.cloud, *.koompi.cloud
# Expiry Date: YYYY-MM-DD (should be ~90 days out)
```

### Monitor Certificate Expiry

Add to crontab to check 14 days before expiry:

```bash
# Create script: /usr/local/bin/check-cert-expiry.sh
#!/bin/bash
CERT="/etc/letsencrypt/live/koompi.cloud/cert.pem"
EXPIRY=$(openssl x509 -in $CERT -noout -dates | grep notAfter | cut -d= -f2)
EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s)
NOW_EPOCH=$(date +%s)
DAYS_LEFT=$(( ($EXPIRY_EPOCH - $NOW_EPOCH) / 86400 ))

if [ $DAYS_LEFT -lt 14 ]; then
    # Send alert (email, Telegram, etc)
    curl -X POST https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage \
      -d "chat_id=$TELEGRAM_CHAT_ID&text=⚠️ Certificate expires in $DAYS_LEFT days"
fi
```

```bash
# Add to crontab:
# 0 8 * * * /usr/local/bin/check-cert-expiry.sh
```

---

## Disaster Recovery Plan

### Certificate Disaster (Lost Certificate)

```bash
# If certificate is lost, regenerate immediately:
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d koompi.cloud \
  -d "*.koompi.cloud" \
  --force-renewal

# Copy to all VPS:
for ip in 1.2.3.4 5.6.7.8 9.10.11.12; do
    scp -r /etc/letsencrypt/live/koompi.cloud/ root@$ip:/etc/letsencrypt/live/
    ssh root@$ip "systemctl restart nginx"
done

# Verify all working
curl -k https://tunnel.koompi.cloud/health
```

### VPS Server Down (Complete Failure)

```bash
# If one VPS goes down completely:

# 1. Cloudflare automatically removes it from DNS responses
# 2. New connections go to remaining 2 VPS
# 3. Existing connections to failed VPS timeout

# Recovery:
# 1. SSH into new replacement VPS
# 2. Run setup from Step 1 & Step 4
# 3. Copy certificate
# 4. Register in control server from Step 7

# The system will automatically balance to 3 again
```

### MongoDB Connection Lost

```bash
# If MongoDB becomes unreachable:

# 1. Check network:
ssh root@1.2.3.4 "ping -c 3 cluster0.mongodb.com"

# 2. Check credentials in .env:
grep MONGODB_URI /root/jrok/.env

# 3. Test locally:
bun -e "import('@mongodb/client').then(({MongoClient})=>new MongoClient(process.env.MONGODB_URI).connect()).then(()=>console.log('✅ Connected')).catch(e=>console.error('❌ Failed:', e.message))"

# 4. Restart service:
sudo systemctl restart jrok

# 5. Check logs:
sudo journalctl -u jrok -f
```

### Control Server Crashes

```bash
# If control server goes down:

# 1. Existing tunnels continue working (no re-registration needed)
# 2. New tunnels cannot be created

# Recovery:
sudo systemctl restart jrok

# If systemd restart doesn't work:
cd /root/jrok
bun run src/index.ts &  # Run in background
pm2 restart jrok  # Or with PM2

# If data is corrupted:
# Restore from backup
tar -xzf /backups/jrok/app-data-YYYYMMDD-HHMMSS.tar.gz -C /
```

---

- [ ] 3 Ubuntu VPS servers are ready with nginx installed
- [ ] MongoDB Atlas cluster is created with database user
- [ ] Domain `koompi.cloud` is added to Cloudflare
- [ ] A record `tunnel.koompi.cloud` points to VPS 1 IP
- [ ] Cloudflare API token is created and saved
- [ ] Wildcard certificate is issued for `*.koompi.cloud`
- [ ] Certificate is copied to all 3 VPS servers
- [ ] Control server is deployed and running
- [ ] All 3 VPS servers are registered in control server
- [ ] Base domain `koompi.cloud` is registered
- [ ] Test tunnel can be created and accessed
- [ ] Telegram bot is connected (optional)

---

## File Structure Overview

```
jrok/
├── src/
│   ├── index.ts              # Main server
│   ├── client.ts             # Agent client
│   ├── types/
│   ├── services/
│   │   ├── domainService.ts
│   │   ├── tunnelService.ts
│   │   ├── agentService.ts
│   │   ├── vpsService.ts
│   │   └── notificationService.ts
│   ├── handlers/
│   ├── utils/
│   │   ├── database.ts
│   │   ├── mongodb.ts
│   │   ├── rateLimiter.ts
│   │   ├── backupUtils.ts
│   │   └── nginxConfig.ts
├── .env                      # Configuration (created by you)
├── package.json
├── tsconfig.json
├── README.md
├── ADVANCED_FEATURES.md      # Features documentation
└── DOMAIN_API.md             # API documentation
```

---

## Environment Variables Reference

```bash
# Required for all deployments
PORT=3000                                    # Control server port
VPS_HOST=tunnel.koompi.cloud             # Base domain
VPS_USER=root                                # SSH user
VPS_PORT=22                                  # SSH port
NGINX_PATH=/etc/nginx/sites-available        # Nginx config location
BASE_DOMAIN=tunnel.koompi.cloud          # Base domain again
API_KEY=your-secret-api-key                  # Your API key
MONGODB_URI=mongodb+srv://...                # MongoDB connection

# Optional but recommended
TELEGRAM_BOT_TOKEN=your-bot-token            # For notifications
TELEGRAM_CHAT_ID=-your-chat-id               # For notifications
BACKUP_DIR=./data/cert-backups               # Backup location
NODE_ENV=production                          # Environment
```

---

## Common Commands

### Check Server Status

```bash
# Health check
curl http://localhost:3000/health

# List all agents
curl http://localhost:3000/agents \
  -H "Authorization: Bearer your-key"

# List all tunnels
curl http://localhost:3000/tunnels \
  -H "Authorization: Bearer your-key"

# List all domains
curl http://localhost:3000/domains \
  -H "Authorization: Bearer your-key"

# List all VPS servers
curl http://localhost:3000/vps \
  -H "Authorization: Bearer your-key"
```

### View Logs

```bash
# Systemd service logs
sudo journalctl -u jrok -f

# PM2 logs
pm2 logs jrok

# Docker logs (if using Docker)
docker logs jrok -f
```

### Restart Services

```bash
# Systemd
sudo systemctl restart jrok

# PM2
pm2 restart jrok

# Nginx on VPS
sudo systemctl restart nginx
```

---

## Troubleshooting Production Issues

### Certificate Issues

**Problem: Certificate expired or renewal failed**
```bash
# Check expiry date
sudo openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -dates

# Manual renewal
sudo certbot renew --force-renewal -v

# If renewal fails, check:
# 1. Cloudflare API token is correct
sudo cat /etc/letsencrypt/cloudflare.ini | head -1

# 2. DNS can be updated
nslookup _acme-challenge.koompi.cloud

# 3. Internet connectivity
ping -c 1 1.1.1.1

# 4. Let's Encrypt rate limits (max 50/week per domain)
# If hit limit, wait and retry later
```

**Problem: Certificate not found on VPS**
```bash
# Check if certificate exists
ssh root@<vps-ip> "ls -la /etc/letsencrypt/live/koompi.cloud/"

# If missing, copy from control server
scp -r /etc/letsencrypt/live/koompi.cloud/ root@<vps-ip>:/etc/letsencrypt/live/
ssh root@<vps-ip> "systemctl restart nginx"
```

**Problem: Certificate mismatch between servers**
```bash
# Get fingerprints from all servers
for ip in 1.2.3.4 5.6.7.8 9.10.11.12; do
    echo "VPS at $ip:"
    ssh root@$ip "openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -fingerprint"
done

# If different:
# 1. Copy correct certificate to mismatched VPS
# 2. Restart nginx on that VPS
# 3. Verify fingerprint matches
```

### DNS & Network Issues

**Problem: tunnel.koompi.cloud doesn't resolve**
```bash
# Check DNS propagation
nslookup tunnel.koompi.cloud
dig tunnel.koompi.cloud +short

# Should return 3 IPs
# If not:
# 1. Wait 5-15 minutes (DNS cache)
# 2. Clear local DNS cache: sudo systemd-resolve --flush-caches
# 3. Verify A records in Cloudflare dashboard
# 4. Check if Cloudflare name servers are correct at registrar
```

**Problem: Cannot connect to VPS on port 443**
```bash
# Test connectivity
openssl s_client -connect 1.2.3.4:443 -servername tunnel.koompi.cloud

# If fails:
# 1. Check firewall on VPS
ssh root@1.2.3.4 "sudo ufw status"
# Should show: 443/tcp ALLOW

# 2. Check nginx is listening
ssh root@1.2.3.4 "sudo netstat -tlnp | grep 443"
# Should show: nginx

# 3. Check nginx config
ssh root@1.2.3.4 "sudo nginx -t"
# Should show: ok

# 4. Restart nginx
ssh root@1.2.3.4 "sudo systemctl restart nginx"
```

### MongoDB Connection Issues

**Problem: Cannot connect to MongoDB**
```bash
# Verify connection string
grep MONGODB_URI /root/jrok/.env | head -1

# Test locally
mongosh "your-connection-string"

# If fails:
# 1. Check credentials
echo $MONGODB_URI | grep -o "://.*@" | sed 's/:.*@/@/g'

# 2. Check VPS IP is whitelisted in MongoDB Atlas
# - Go to MongoDB Atlas > Security > Network Access
# - Verify your VPS IPs are listed (or 0.0.0.0/0 for testing)

# 3. Check MongoDB cluster is running
# - Go to MongoDB Atlas > Database > Clusters
# - Verify cluster status is "ACTIVE"

# 4. Test from VPS
ssh root@1.2.3.4 "curl -s https://cluster0.mongodb.com" > /dev/null && echo "✅ Connected"
```

**Problem: MongoDB high latency or timeouts**
```bash
# Check MongoDB connection options in code
grep "serverSelectionTimeoutMS" src/utils/mongodb.ts

# If experiencing timeouts:
# 1. Check network latency to MongoDB
ping -c 5 cluster0.mongodb.com

# 2. Monitor connection pool
# Logs will show: "No suitable servers found"
# Solution: Increase timeout in connection string:
# Add: ?serverSelectionTimeoutMS=30000&connectTimeoutMS=30000

# 3. Reduce application load during sync
# Schedule heavy operations during off-peak hours
```

### Service & Performance Issues

**Problem: Service using high CPU (>80%)**
```bash
# Find the process
ps aux | grep jrok

# Check what's consuming CPU
top -p <pid>

# Common causes:
# 1. High tunnel throughput - normal
# 2. Certificate sync in progress - temporary
# 3. Runaway process - restart service

sudo systemctl restart jrok
```

**Problem: Service using high memory (>400MB)**
```bash
# Check memory usage
free -h
ps aux | grep jrok | grep -v grep

# Common causes:
# 1. Large number of tunnels (>1000) - split to 2 control servers
# 2. Memory leak - restart weekly
# 3. Backup process running - temporary

# Add memory limit to systemd service:
sudo nano /etc/systemd/system/jrok.service
# Add line: MemoryLimit=512M

sudo systemctl daemon-reload
sudo systemctl restart jrok
```

**Problem: Disk space full (99%)**
```bash
# Check usage
df -h

# Find large files
du -sh /root/jrok/*
du -sh /var/log/*

# Clean up:
# 1. Old logs
sudo journalctl --vacuum=time=7d  # Keep 7 days

# 2. Old backups
rm /root/jrok/data/cert-backups/backup-*.tar.gz

# 3. Nginx logs
ssh root@<vps-ip> "rm /var/log/nginx/*.log.1 /var/log/nginx/*.log.2*"

# Prevent future issues:
# 1. Increase disk size on VPS
# 2. Mount separate /backups partition
# 3. Implement log rotation
```

### Tunnel/Routing Issues

**Problem: 404 error when accessing tunnel**
```bash
# Check tunnel is registered
curl http://localhost:3000/tunnels \
  -H "Authorization: Bearer $API_KEY" \
  | grep <tunnel-name>

# If not registered:
# 1. Create new tunnel
bun client.ts --server http://localhost:3000 \
  --domain <tunnel-name> --port 8080 --auth "$API_KEY"

# 2. Verify tunnel is running
ps aux | grep client.ts
```

**Problem: 502 Bad Gateway error**
```bash
# Check nginx error log on VPS
ssh root@<vps-ip> "tail -50 /var/log/nginx/error.log"

# Common causes:
# 1. Backend service not running
# 2. Tunnel not connected to control server
# 3. Nginx proxy misconfigured

# Solution:
# 1. Verify backend service is listening
curl http://localhost:8080

# 2. Restart tunnel agent
pkill -f "client.ts"
bun client.ts --server http://localhost:3000 \
  --domain <tunnel-name> --port 8080 --auth "$API_KEY"

# 3. Restart nginx
ssh root@<vps-ip> "sudo systemctl restart nginx"
```

**Problem: SSL certificate errors in browser**
```bash
# Check certificate is valid
openssl s_client -connect tunnel.koompi.cloud:443

# Common causes:
# 1. Certificate doesn't match domain
# Check: Subject/SAN contains *.koompi.cloud

# 2. Certificate expired
# Check: notAfter date is in future

# 3. Certificate not on VPS
# Check: ls /etc/letsencrypt/live/koompi.cloud/

# Solutions:
# 1. Copy valid certificate
scp -r /etc/letsencrypt/live/koompi.cloud/ root@<vps-ip>:/etc/letsencrypt/live/

# 2. Restart nginx
ssh root@<vps-ip> "sudo systemctl restart nginx"

# 3. Clear browser cache and retry
```

### Monitoring & Alerting Issues

**Problem: Telegram notifications not sending**
```bash
# Check Telegram token and chat ID
grep TELEGRAM /root/jrok/.env

# Test notification manually
curl -X POST http://localhost:3000/test-notification \
  -H "Authorization: Bearer $API_KEY" -v

# If fails:
# 1. Check internet connectivity
ping -c 1 api.telegram.org

# 2. Verify token format (should start with number:)
# 3. Verify chat ID is negative for groups
# 4. Verify bot is in the chat group
# 5. Restart service
sudo systemctl restart jrok
```

**Problem: High rate limit false positives**
```bash
# Check rate limiter status
curl http://localhost:3000/rate-limit-stats \
  -H "Authorization: Bearer $API_KEY"

# If many blocks:
# 1. Increase rate limit in src/utils/rateLimiter.ts
# 2. Reset specific IP
curl -X POST http://localhost:3000/reset-rate-limit \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"ip":"1.2.3.4"}'

# 3. Monitor for DDoS attacks
# Check: sudo tcpdump -i any -n 'src 1.2.3.4'
```

### Advanced Debugging

**Enable verbose logging:**
```bash
# Restart with debug mode
sudo systemctl stop jrok

cd /root/jrok
DEBUG=* bun run src/index.ts &

# Watch real-time logs
tail -f /var/log/syslog | grep jrok

# Restore normal logging
fg  # Bring to foreground
Ctrl+C  # Stop
sudo systemctl start jrok
```

**Network packet capture:**
```bash
# Capture traffic to/from MongoDB
sudo tcpdump -i any -n "host cluster0.mongodb.com" -w /tmp/mongodb.pcap

# Capture traffic to/from Telegram
sudo tcpdump -i any -n "host api.telegram.org" -w /tmp/telegram.pcap

# Analyze
sudo tcpdump -r /tmp/mongodb.pcap | head -20
```

**Database inspection:**
```bash
# Connect to MongoDB
mongosh "your-connection-string"

# List all collections
show collections

# Check tunnels count
db.tunnels.countDocuments()

# Find specific tunnel
db.tunnels.findOne({_id: ObjectId("...")})

# Check domains
db.customdomains.find()

# Check agents
db.agents.find()
```

### When All Else Fails

1. **Check systemd logs (first place to look):**
```bash
sudo journalctl -u jrok -n 100  # Last 100 lines
sudo journalctl -u jrok -f      # Follow in real-time
```

2. **Restart all services in order:**
```bash
# 1. Control server
sudo systemctl restart jrok

# 2. All VPS nginx
for ip in 1.2.3.4 5.6.7.8 9.10.11.12; do
    ssh root@$ip "sudo systemctl restart nginx"
done

# 3. Wait for services to stabilize
sleep 10

# 4. Verify health
curl http://localhost:3000/health
```

3. **Restore from backup:**
```bash
# List available backups
ls -la /backups/jrok/

# Restore latest application data
tar -xzf /backups/jrok/app-data-*.tar.gz -C /

# Restore latest certificates
tar -xzf /backups/jrok/certs-*.tar.gz -C /

# Restart services
sudo systemctl restart jrok
```

4. **Contact support with logs:**
```bash
# Gather diagnostic info
mkdir /tmp/diagnostics
journalctl -u jrok > /tmp/diagnostics/systemd.log
curl http://localhost:3000/health > /tmp/diagnostics/health.json
df -h > /tmp/diagnostics/disk.txt
free -h > /tmp/diagnostics/memory.txt
uname -a > /tmp/diagnostics/system.txt

# Tar everything (no secrets!)
tar -czf diagnostics.tar.gz /tmp/diagnostics/
```

---

---

## Complete Production-Ready Checklist

**INFRASTRUCTURE SETUP:**
- [ ] 3 Ubuntu 22.04 LTS VPS servers provisioned
- [ ] Minimum specs verified: 1GB RAM, 20GB SSD each
- [ ] SSH key-based authentication configured
- [ ] Password authentication disabled on all servers
- [ ] Firewall (UFW) enabled on all servers
- [ ] Ports 22 (SSH), 80 (HTTP), 443 (HTTPS) open
- [ ] Fail2Ban installed and protecting SSH
- [ ] System time synchronized across all servers (UTC)
- [ ] Nginx installed and tested on all VPS
- [ ] Bun runtime installed on all servers

**MONGODB ATLAS CONFIGURATION:**
- [ ] MongoDB Atlas M0 free cluster created
- [ ] 3-node replica set configured (auto)
- [ ] Database user `jrok` created
- [ ] Strong password generated (20+ characters)
- [ ] VPS server IPs whitelisted in Network Access
- [ ] Local machine IP whitelisted for testing
- [ ] Connection string retrieved and tested
- [ ] Database `jrok` created manually
- [ ] Collection `tunnels` created
- [ ] All other collections auto-created on first run

**CLOUDFLARE DOMAIN SETUP:**
- [ ] Domain `koompi.cloud` added to Cloudflare
- [ ] Nameservers updated at registrar
- [ ] DNS propagation confirmed (nslookup test passed)
- [ ] 3 A records created for all VPS IPs
- [ ] All records set to "Proxied" (orange cloud)
- [ ] Cloudflare SSL/TLS mode set to "Full (Strict)"
- [ ] Cloudflare API token created for Certbot
- [ ] API token stored securely (not in git)

**CERTIFICATE MANAGEMENT:**
- [ ] Certbot installed on control server
- [ ] Cloudflare credentials file configured (600 permissions)
- [ ] Wildcard certificate issued: `*.koompi.cloud`
- [ ] Base domain certificate issued: `koompi.cloud`
- [ ] Certificate valid date verified (90-day lifetime)
- [ ] Certificate covers both domains (SAN)
- [ ] Certificate copied to all 3 VPS servers
- [ ] Certificate copied to: `/etc/letsencrypt/live/koompi.cloud/`
- [ ] Certificate permissions correct (644 for certs, 600 for private key)
- [ ] Certificate fingerprint identical on all servers
- [ ] Nginx restarted after certificate copy
- [ ] Certbot auto-renewal configured (systemd timer)
- [ ] Renewal test passed: `certbot renew --dry-run`
- [ ] Renewal will auto-sync to all VPS via scripts

**CONTROL SERVER DEPLOYMENT:**
- [ ] Application repository cloned
- [ ] Dependencies installed: `bun install`
- [ ] Data directories created: `./data/cert-backups`, `./logs`
- [ ] `.env` file created with all required variables
- [ ] `.env` file permissions: 600 (owner read-write only)
- [ ] API_KEY generated (32+ random characters)
- [ ] MONGODB_URI set with correct password
- [ ] TELEGRAM_BOT_TOKEN configured
- [ ] TELEGRAM_CHAT_ID configured
- [ ] `.env` added to `.gitignore` (never committed)
- [ ] `.env` stored in password manager as backup
- [ ] Application tested locally: `bun run src/index.ts`
- [ ] Health endpoint responds: `curl http://localhost:3000/health`
- [ ] MongoDB connection verified
- [ ] Systemd service file created
- [ ] Service enabled: `systemctl enable jrok`
- [ ] Service started: `systemctl start jrok`
- [ ] Service status verified: `systemctl status jrok`
- [ ] Log rotation configured
- [ ] Backup script created and scheduled
- [ ] Monitoring/health check script running

**SECURITY CONFIGURATION:**
- [ ] SSH port changed from 22 (optional but recommended)
- [ ] SSH permit root login disabled (use sudo user)
- [ ] SSH X11 forwarding disabled
- [ ] Firewall blocks all incoming by default
- [ ] Firewall allows only needed ports
- [ ] Rate limiting enabled (5 reqs/hour per IP)
- [ ] API authentication required (Bearer token)
- [ ] Secrets never logged or printed
- [ ] Backup encryption enabled (openssl)
- [ ] Backup stored on separate location
- [ ] SSH keys have 4096-bit encryption
- [ ] Sudo password required (no passwordless sudo)
- [ ] Regular security updates scheduled
- [ ] Audit logging configured

**VALIDATION & TESTING:**
- [ ] DNS resolution tested: `nslookup tunnel.koompi.cloud`
- [ ] Returns all 3 VPS IPs (round-robin)
- [ ] SSL certificate valid: `openssl s_client` on all VPS
- [ ] Certificate chain complete (fullchain.pem)
- [ ] HTTPS connection succeeds with no warnings
- [ ] Control server health endpoint responds
- [ ] Control server connects to MongoDB successfully
- [ ] All VPS nginx responding on ports 80 and 443
- [ ] Rate limiting test passed (6th request returns 429)
- [ ] Telegram test notification sent successfully
- [ ] Domain registration endpoint works
- [ ] Domain transfer endpoint works
- [ ] Backup/restore endpoints work
- [ ] Certificate sync to VPS works
- [ ] First tunnel created and accessible
- [ ] Multiple tunnels on same VPS work
- [ ] Tunnel accessible via HTTPS (green lock)
- [ ] Certificate valid for both domains
- [ ] Load balancing working (requests to different VPS)

**MONITORING & OPERATIONS:**
- [ ] Health check script running every 5 minutes
- [ ] Alert triggers on service failure
- [ ] Telegram alerts enabled for critical events
- [ ] Logs being collected to systemd journal
- [ ] Log files being rotated automatically
- [ ] Backup script running daily
- [ ] Backup retention policy: last 30 days
- [ ] Certificate expiry monitoring configured
- [ ] Alert 14 days before certificate expiry
- [ ] Certificate renewal happens automatically
- [ ] Resource usage monitored (CPU, RAM, disk)
- [ ] Disk space alerts configured (>80% usage)
- [ ] MongoDB backup tested (restore procedure)

**DISASTER RECOVERY:**
- [ ] Disaster recovery plan documented
- [ ] Certificate backup procedure tested
- [ ] VPS failure recovery procedure documented
- [ ] MongoDB restoration procedure tested
- [ ] Control server crash recovery verified
- [ ] Data recovery procedure documented
- [ ] Emergency contacts listed
- [ ] Recovery time objective (RTO): 30 minutes
- [ ] Recovery point objective (RPO): daily backups

**PRE-LAUNCH VALIDATION:**
- [ ] Run `./validate-production.sh` - all pass
- [ ] All checklist items above complete
- [ ] Team trained on operations
- [ ] Runbook created and shared
- [ ] Contact information updated
- [ ] Status page created (optional)
- [ ] Incident response plan created
- [ ] Approved for production by team lead

**AFTER GOING LIVE (First 24 Hours):**
- [ ] Monitor logs continuously
- [ ] Watch CPU/RAM usage
- [ ] Test tunnel creation multiple times
- [ ] Simulate VPS failure (disable one)
- [ ] Verify automatic failover works
- [ ] Monitor certificate auto-renewal process
- [ ] Check Telegram alerts are sending
- [ ] Verify backups running successfully
- [ ] Test health check script
- [ ] Document any issues encountered
- [ ] Performance baseline measurements taken

---

## Production Deployment Confidence Level

If you've checked all items above: **✅ 100% READY FOR PRODUCTION**

Your Jrok tunnel service is production-grade and ready to handle real users!

---
