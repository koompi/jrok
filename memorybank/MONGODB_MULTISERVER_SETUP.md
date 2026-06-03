> ⚠️ HISTORICAL — describes the pre-kproxy nginx + Certbot/Let's Encrypt (leader-based) design that was removed. See ../docs/getting-started/architecture.md for the current architecture.

# Jrok - Multi-Server Setup Guide

Complete guide to setting up Jrok with MongoDB Atlas and 3-5 VPS servers.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│         Control Plane (Your Local Machine)      │
│  - Runs Jrok server                      │
│  - Manages agents & tunnels                     │
└──────┬──────────────────────────────────────────┘
       │
       ├─────────────────────────────────────────────┐
       │         MongoDB Atlas (Cloud)               │
       │  - Stores tunnels, agents, VPS servers      │
       │  - 3 automatic replicas                     │
       │  - Built-in failover                        │
       └──────┬────────────────────────────────────┘
              │
       ┌──────┴──────┬──────────┬──────────┐
       │             │          │          │
       ▼             ▼          ▼          ▼
     VPS1          VPS2       VPS3      VPS4
   (nginx)        (nginx)    (nginx)   (nginx)
   (agent)        (agent)    (agent)   (agent)
```

## Prerequisites

1. **Cloudflare Account** - For DNS and SSL
2. **MongoDB Atlas Account** - Free tier
3. **3-5 VPS Servers** - DigitalOcean/Linode/AWS (optional for testing, use 1 for now)
4. **SSH Access** - To all VPS servers
5. **Bun** - Installed locally

## Step 1: Create MongoDB Atlas Cluster

### 1.1 Create Free Account
- Go to: https://www.mongodb.com/cloud/atlas
- Sign up for free
- Create an organization

### 1.2 Create Cluster
1. Click "Create" → Choose "Free" tier
2. Cloud Provider: AWS
3. Region: Closest to your VPS servers (or US East for global)
4. Cluster Name: `jrok-prod`
5. Click "Create Cluster"

Wait 5-10 minutes for cluster creation...

### 1.3 Create Database User
1. Go to "Database Access"
2. Click "Add New Database User"
3. Username: `jrok`
4. Password: Generate strong password (save it!)
5. Permissions: `Atlas admin`
6. Click "Add User"

### 1.4 Setup Network Access
1. Go to "Network Access"
2. Click "Add IP Address"
3. Choose "Allow Access from Anywhere" (0.0.0.0/0)
   - ⚠️ For production, use specific IPs of your servers
4. Click "Confirm"

### 1.5 Get Connection String
1. Go to "Clusters"
2. Click "Connect" button
3. Choose "Drivers"
4. Select "Node.js" version "4.0 or later"
5. Copy the connection string

Example:
```
mongodb+srv://jrok:PASSWORD@cluster.mongodb.net/jrok?retryWrites=true&w=majority
```

Replace `PASSWORD` with your actual password.

## Step 2: Setup VPS Servers

### 2.1 Initial VPS Setup (on each VPS)

SSH into your VPS:

```bash
ssh root@your-vps-ip
```

Install dependencies:

```bash
apt update
apt install -y nginx certbot python3-certbot-dns-cloudflare git curl wget
```

### 2.2 Create SSH User for jrok

```bash
# Create user
useradd -m -s /bin/bash jrok

# Add to sudoers (for nginx reload)
usermod -aG sudo jrok

# Create .ssh directory
mkdir -p /home/jrok/.ssh
chmod 700 /home/jrok/.ssh

# Give permission for nginx config directory
chown -R jrok:jrok /etc/nginx/sites-available
chmod 755 /etc/nginx/sites-available
```

### 2.3 Setup SSH Keys (Local Machine)

On your local machine:

```bash
# Generate SSH key (if you don't have one)
ssh-keygen -t ed25519 -f ~/.ssh/jrok -C "jrok"

# Copy public key to each VPS
for vps in vps1.example.com vps2.example.com vps3.example.com; do
  ssh-copy-id -i ~/.ssh/jrok root@$vps
done

# Test connection
ssh -i ~/.ssh/jrok root@vps1.example.com "echo 'SSH works!'"
```

## Step 3: Setup SSL Certificates

### 3.1 Get Cloudflare API Token

1. Go to: https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Template: "Edit zone DNS"
4. Zone Resources: Select your domain
5. Copy the token

### 3.2 Install Certbot on Each VPS

```bash
ssh root@vps1.example.com

# Install
apt install -y certbot python3-certbot-dns-cloudflare

# Create secrets directory
mkdir -p /etc/letsencrypt/secrets/

# Create credentials file
cat > /etc/letsencrypt/secrets/cloudflare.ini << 'EOF'
dns_cloudflare_api_token = YOUR_CLOUDFLARE_TOKEN
EOF

chmod 600 /etc/letsencrypt/secrets/cloudflare.ini
```

### 3.3 Get Wildcard Certificate

```bash
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/secrets/cloudflare.ini \
  --email your-email@example.com \
  --agree-tos \
  --non-interactive \
  -d tunnel.example.com \
  -d '*.tunnel.example.com'
```

Verify:

```bash
sudo certbot certificates
```

## Step 4: Setup Local jrok Server

### 4.1 Clone Repository

```bash
git clone <your-repo> jrok
cd jrok
bun install
```

### 4.2 Configure Environment

Create `.env`:

```bash
cp .env.example .env
nano .env
```

Set MongoDB URI (from Step 1.5):

```env
MONGODB_URI=mongodb+srv://jrok:PASSWORD@cluster.mongodb.net/jrok?retryWrites=true&w=majority
BASE_DOMAIN=tunnel.example.com
API_KEY=your-super-secret-key-here
PORT=3000
```

### 4.3 Register VPS Servers

You can register VPS servers via API or directly in MongoDB. Let's use the API:

```bash
# Start server first
bun run src/index.ts
```

In another terminal, register each VPS:

```bash
curl -X POST http://localhost:3000/vps/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "id": "vps1",
    "name": "Primary VPS (US-East)",
    "host": "vps1.example.com",
    "sshUser": "root",
    "sshPort": 22,
    "nginxPath": "/etc/nginx/sites-available",
    "region": "us-east"
  }'
```

Repeat for VPS2, VPS3, etc. with different IDs and hosts.

### 4.4 Verify VPS Registration

```bash
curl http://localhost:3000/vps/list \
  -H "Authorization: Bearer your-api-key"
```

Should return:

```json
{
  "success": true,
  "servers": [
    {
      "id": "vps1",
      "name": "Primary VPS (US-East)",
      "host": "vps1.example.com",
      "healthy": true,
      ...
    }
  ]
}
```

## Step 5: Setup DNS

### 5.1 Configure Cloudflare DNS

1. Go to your domain in Cloudflare
2. DNS Records → Add Record
3. Type: A
4. Name: `tunnel`
5. IPv4: Add all VPS IPs (Cloudflare will do round-robin)
   - `vps1.example.com` IP
   - `vps2.example.com` IP
   - `vps3.example.com` IP
6. TTL: 300 (5 minutes)
7. Click Save

## Step 6: Test Everything

### 6.1 Start Server

```bash
bun run src/index.ts
```

### 6.2 Connect Agent

```bash
bun client.ts \
  --server http://localhost:3000 \
  --domain testapp \
  --port 3000 \
  --auth your-api-key
```

### 6.3 Create Tunnel

Get agent ID from client output, then:

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "domain": "testapp",
    "agentId": "agent-uuid-from-client"
  }'
```

### 6.4 Test Access

```bash
# Should route to your local app
curl https://testapp.tunnel.example.com

# Should have valid SSL certificate
curl -vI https://testapp.tunnel.example.com
```

## Step 7: Production Deployment

### 7.1 Use PM2 for Server

```bash
npm install -g pm2

pm2 start "bun run src/index.ts" --name jrok
pm2 save
pm2 startup
```

### 7.2 Use Systemd for Agent

Create `/etc/systemd/system/jrok-agent.service`:

```ini
[Unit]
Description=jrok Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/jrok
ExecStart=/usr/local/bin/bun client.ts --server http://server-ip:3000 --domain myapp --port 8080 --auth your-key
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
systemctl enable jrok-agent
systemctl start jrok-agent
```

### 7.3 Monitor

```bash
# View PM2 logs
pm2 logs jrok

# View systemd agent logs
journalctl -u jrok-agent -f

# Monitor MongoDB
Go to MongoDB Atlas → Monitoring → Charts
```

## Troubleshooting

### MongoDB Connection Issues

```bash
# Test connection
mongo "mongodb+srv://jrok:PASSWORD@cluster.mongodb.net/jrok"

# Check firewall/IP whitelist in MongoDB Atlas
# Network Access → IP Whitelist
```

### SSH Issues to VPS

```bash
# Test SSH key
ssh -vvv -i ~/.ssh/jrok root@vps1.example.com

# Check authorized_keys on VPS
cat ~/.ssh/authorized_keys
```

### Nginx Config Issues

```bash
# On VPS, check config
sudo nginx -t

# View generated configs
sudo ls -la /etc/nginx/sites-available/

# View specific config
sudo cat /etc/nginx/sites-available/myapp_tunnel_example_com.conf
```

### Certificate Issues

```bash
# On VPS, check certificates
sudo certbot certificates

# View renewal logs
sudo tail -f /var/log/letsencrypt/letsencrypt.log

# Force renewal
sudo certbot renew --force-renewal
```

## Performance Tips

1. **Use closest VPS region** - Lower latency for agents
2. **Enable HTTP/2** - Done automatically in nginx config
3. **Use load balancing** - DNS round-robin or Cloudflare LB
4. **Monitor MongoDB** - Use Atlas monitoring dashboard
5. **SSL session caching** - Already configured in nginx

## Security Checklist

- [ ] Strong `API_KEY` (32+ random characters)
- [ ] MongoDB IP whitelist (restrict to your servers)
- [ ] SSH keys with passphrases
- [ ] Firewall rules on VPS (only open 22, 80, 443)
- [ ] Regular Certbot auto-renewal testing
- [ ] MongoDB backups enabled (Atlas does this)
- [ ] Monitor unauthorized access attempts
- [ ] Use Cloudflare WAF rules

## Scaling Further

When you reach capacity:

1. **Add more VPS** - Just register them in MongoDB
2. **Add load balancer** - Use Cloudflare LB or HAProxy
3. **Separate control plane** - Run server on dedicated VPS
4. **Add Redis** - For agent session caching
5. **Add metrics** - Prometheus + Grafana monitoring
