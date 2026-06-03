> ⚠️ HISTORICAL — describes the pre-kproxy nginx + Certbot/Let's Encrypt (leader-based) design that was removed. See ../docs/getting-started/architecture.md for the current architecture.

# Jrok Setup Guide

## Prerequisites

- A VPS with Ubuntu/Debian
- A domain with Cloudflare DNS
- Cloudflare API token (with Zone:DNS edit permissions)
- SSH access to your VPS
- Bun installed locally

## Step 1: VPS Setup

SSH into your VPS and run:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-dns-cloudflare git
```

## Step 2: Generate SSL Certificate (On VPS)

Create `/root/setup-ssl.sh` on your VPS with the script content, then:

```bash
sudo bash /root/setup-ssl.sh
```

Follow the prompts:
- Domain: `tunnel.example.com`
- Email: `your-email@example.com`
- Cloudflare API Token: (get from Cloudflare dashboard)

Verify certificate was created:

```bash
ls -la /etc/letsencrypt/live/tunnel.example.com/
```

Test auto-renewal:

```bash
sudo certbot renew --dry-run
```

## Step 3: Clone & Setup Jrok (Locally)

```bash
git clone <your-repo> jrok
cd jrok
bun install
```

## Step 4: Configure Environment

Create `.env`:

```bash
cp .env.example .env
nano .env
```

Update with:

```env
VPS_HOST=your-vps-ip.com
VPS_USER=root
VPS_PORT=22
NGINX_PATH=/etc/nginx/sites-available
BASE_DOMAIN=tunnel.example.com
API_KEY=your-super-secret-key-here
PORT=3000
```

## Step 5: Test SSH Connection

Ensure passwordless SSH works:

```bash
ssh -i ~/.ssh/id_rsa root@your-vps-ip.com "echo 'SSH works!'"
```

If prompted for password, setup SSH key:

```bash
ssh-copy-id -i ~/.ssh/id_rsa root@your-vps-ip.com
```

## Step 6: Run Server

```bash
bun run src/index.ts
```

Should see:

```
🚀 Server running at http://localhost:3000
📝 Base domain: tunnel.example.com
🔐 Auth enabled with API key
🔌 WebSocket agent endpoint: ws://localhost:3000/ws/agent
✅ Auto-cleanup enabled (every 30 seconds for agents, 5 minutes for tunnels)
```

## Step 7: Connect Agent (From Your Machine)

In a new terminal:

```bash
bun client.ts \
  --server http://localhost:3000 \
  --domain myapp \
  --port 3000 \
  --auth your-super-secret-key-here
```

Should see:

```
🔌 Connecting to http://localhost:3000
📍 Domain: myapp
🏠 Local: localhost:3000
✅ Connected to server!
✨ Connected to jrok
🆔 Agent ID: <uuid>
```

## Step 8: Create Tunnel

In another terminal, grab the agent ID from step 7, then:

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-super-secret-key-here" \
  -d '{
    "domain": "myapp",
    "agentId": "paste-agent-uuid-here"
  }'
```

Response:

```json
{
  "success": true,
  "message": "Tunnel created successfully",
  "tunnel": {
    "id": "tunnel-uuid",
    "domain": "myapp.tunnel.example.com",
    "agentId": "agent-uuid",
    "createdAt": 1702672800000,
    "active": true
  }
}
```

## Step 9: Access Your App

Visit: `https://myapp.tunnel.example.com`

SSL certificate is automatically applied! 🔒

## Troubleshooting

### SSH Connection Issues

```bash
# Test SSH
ssh -v root@your-vps-ip.com

# Check SSH key permissions
chmod 600 ~/.ssh/id_rsa
chmod 644 ~/.ssh/id_rsa.pub
```

### Nginx Config Issues

```bash
# On VPS, test nginx
sudo nginx -t

# View active configs
sudo ls -la /etc/nginx/sites-available/

# Check specific config
sudo cat /etc/nginx/sites-available/myapp_tunnel_example_com.conf
```

### Certificate Issues

```bash
# Check certificate status
sudo certbot certificates

# Force renewal
sudo certbot renew --force-renewal

# Check Certbot logs
sudo tail -f /var/log/letsencrypt/letsencrypt.log
```

### Agent Connection Issues

```bash
# Check connected agents
curl http://localhost:3000/agents \
  -H "Authorization: Bearer your-api-key"

# Check all tunnels
curl http://localhost:3000/tunnels \
  -H "Authorization: Bearer your-api-key"
```

## Production Deployment

### Use PM2 or Supervisor for Server

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start "bun run src/index.ts" --name jrok

# Save PM2 config
pm2 save

# Auto-start on reboot
pm2 startup
```

### Use Systemd Timer for Agents

Create `/etc/systemd/system/jrok-agent.service`:

```ini
[Unit]
Description=Jrok Agent
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/jrok
ExecStart=/usr/local/bin/bun client.ts --server http://server-ip:3000 --domain myapp --port 3000 --auth your-key
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable jrok-agent
sudo systemctl start jrok-agent
```

## Security Checklist

- [ ] Change `API_KEY` to a strong random value
- [ ] Use SSH key-based auth (no passwords)
- [ ] Restrict Cloudflare API token to specific domain only
- [ ] Use HTTPS for agent connections in production
- [ ] Setup firewall rules on VPS
- [ ] Monitor nginx logs for suspicious activity
- [ ] Enable automatic certificate renewal
