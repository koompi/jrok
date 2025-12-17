# Production Deployment Quick Reference Card

## Emergency Commands

```bash
# Service Status
sudo systemctl status jrok
sudo journalctl -u jrok -f

# Restart Service
sudo systemctl restart jrok

# Check Health
curl http://localhost:3000/health

# View Logs (last 50 lines)
sudo journalctl -u jrok -n 50

# Check MongoDB
mongosh "mongodb+srv://jrok:password@cluster0.xxxxx.mongodb.net/jrok"

# Check Certificate Expiry
sudo openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -dates

# List Tunnels
curl http://localhost:3000/tunnels -H "Authorization: Bearer $API_KEY"
```

## Critical Contacts

```
Admin Name: ________________
Slack: ____________________
Email: ____________________

On-Call: __________________
Phone: ____________________

Escalation: ________________
Email: ____________________
```

## Server IPs & Credentials

```
Control Server IP: _______________
VPS 1 IP: _______________
VPS 2 IP: _______________
VPS 3 IP: _______________

Domain: tunnel.koompi.cloud
MongoDB: cluster0.xxxxx.mongodb.net
Cloudflare Account: _______________
```

## 5-Minute Troubleshooting Flow

```
Problem: Service not responding
├─ Check status: sudo systemctl status jrok
├─ View logs: sudo journalctl -u jrok -f
├─ Check MongoDB: curl https://cluster0.mongodb.com
├─ Restart: sudo systemctl restart jrok
└─ Still failing? → See COMPLETE_SETUP_GUIDE.md Troubleshooting section

Problem: Certificate error
├─ Check expiry: sudo openssl x509 -noout -dates -in /etc/letsencrypt/live/koompi.cloud/cert.pem
├─ Renew: sudo certbot renew --force-renewal
├─ Copy to VPS: scp -r /etc/letsencrypt/live/koompi.cloud/ root@1.2.3.4:/etc/letsencrypt/live/
├─ Restart nginx: ssh root@1.2.3.4 "sudo systemctl restart nginx"
└─ Verify: openssl s_client -connect 1.2.3.4:443

Problem: Tunnel not accessible
├─ Check DNS: nslookup tunnel.koompi.cloud
├─ Check nginx on VPS: ssh root@1.2.3.4 "sudo nginx -t && sudo systemctl restart nginx"
├─ Check firewall: ssh root@1.2.3.4 "sudo ufw status | grep 443"
└─ Test directly: curl -k https://1.2.3.4

Problem: High resource usage
├─ Check CPU: top -p $(pgrep -f "bun run")
├─ Check memory: free -h
├─ Check disk: df -h
└─ Restart if needed: sudo systemctl restart jrok
```

## Daily Checks (2 minutes)

```bash
#!/bin/bash
echo "=== Daily Health Check ==="
echo "1. Service Status:"
sudo systemctl status jrok | grep Active

echo "2. Certificate (days remaining):"
sudo openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -dates | grep notAfter

echo "3. Disk Space:"
df -h / | awk 'NR==2 {print $5, "used,", $4, "available"}'

echo "4. Recent Errors:"
sudo journalctl -u jrok -n 20 | grep -i error || echo "No errors found"

echo "5. MongoDB Connection:"
curl -s http://localhost:3000/health | grep -q success && echo "✅ Connected" || echo "❌ Error"
```

## Weekly Checks (5 minutes)

```bash
#!/bin/bash
echo "=== Weekly Health Check ==="

# Certificate renewal test
echo "Testing auto-renewal..."
sudo certbot renew --dry-run

# VPS certificate sync
echo "Checking certificate on all VPS..."
for ip in 1.2.3.4 5.6.7.8 9.10.11.12; do
    echo "VPS at $ip:"
    ssh root@$ip "openssl x509 -in /etc/letsencrypt/live/koompi.cloud/cert.pem -noout -fingerprint" 2>/dev/null
done

# Backup status
echo "Checking backups..."
ls -lt /backups/jrok/ 2>/dev/null | head -5 || echo "No backups found"

# MongoDB backup
echo "MongoDB is auto-backed up (Atlas handles this)"
```

## Rate Limit Reset

```bash
# If someone is rate-limited, reset with:
curl -X POST http://localhost:3000/reset-rate-limit \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"ip":"user-ip-address"}'

# Or for domain:
curl -X POST http://localhost:3000/reset-rate-limit \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"domain":"example.koompi.cloud"}'
```

## Backup/Restore

```bash
# Backup all certificates
tar -czf /backups/certs-$(date +%Y%m%d).tar.gz /etc/letsencrypt/live/koompi.cloud/

# Restore certificates
tar -xzf /backups/certs-YYYYMMDD.tar.gz -C /
sudo systemctl restart jrok

# Backup application data
tar -czf /backups/app-data-$(date +%Y%m%d).tar.gz /root/jrok/data/

# Backup MongoDB (Atlas handles auto-backups)
# Manual export:
mongoexport --uri="$MONGODB_URI" --collection tunnels --out tunnels.json
```

## SSL Certificate Renewal

```bash
# Manual renewal (normally automatic)
sudo certbot renew --force-renewal -v

# If renewal fails:
# 1. Check Cloudflare token: cat /etc/letsencrypt/cloudflare.ini
# 2. Check DNS: nslookup _acme-challenge.koompi.cloud
# 3. Check Let's Encrypt rate limits: https://letsencrypt.org/stats/

# After successful renewal:
# Copy to all VPS servers
for ip in 1.2.3.4 5.6.7.8 9.10.11.12; do
    scp -r /etc/letsencrypt/live/koompi.cloud/ root@$ip:/etc/letsencrypt/live/
    ssh root@$ip "sudo systemctl restart nginx"
done
```

## Add New VPS (Scaling Up)

```bash
# 1. Setup new VPS (follow Step 1 of COMPLETE_SETUP_GUIDE.md)
# 2. Copy certificate
scp -r /etc/letsencrypt/live/koompi.cloud/ root@NEW-VPS-IP:/etc/letsencrypt/live/

# 3. Register in control server
curl -X POST http://localhost:3000/vps \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "vps-new",
    "host": "NEW-VPS-IP",
    "sshUser": "root",
    "sshPort": 22,
    "nginxPath": "/etc/nginx/sites-available",
    "region": "region-name"
  }'

# 4. Add A record in Cloudflare DNS
# 5. Test: nslookup tunnel.koompi.cloud (should show 4 IPs now)
```

## Remove Failed VPS

```bash
# 1. In Cloudflare, remove the A record for that VPS
# 2. Optional: Delete from control server
curl -X DELETE http://localhost:3000/vps/vps-id \
  -H "Authorization: Bearer $API_KEY"

# 3. Test DNS resolution (should show remaining IPs)
nslookup tunnel.koompi.cloud
```

## Environmental Variables Reference

```bash
PORT=3000                           # Application port
VPS_HOST=tunnel.koompi.cloud    # Base domain
VPS_USER=root                       # SSH user
VPS_PORT=22                         # SSH port
NGINX_PATH=/etc/nginx/sites-available
BASE_DOMAIN=tunnel.koompi.cloud
API_KEY=<random-32-char-string>    # ❌ NEVER share
MONGODB_URI=<connection-string>     # ❌ NEVER share
TELEGRAM_BOT_TOKEN=<token>          # ❌ NEVER share
TELEGRAM_CHAT_ID=-12345             # ❌ NEVER share
BACKUP_DIR=./data/cert-backups
NODE_ENV=production
```

## Alert Severity Levels

| Level | Example | Response Time |
|-------|---------|---|
| 🔴 Critical | Service down, cert expired | Immediate (< 5 min) |
| 🟠 High | Certificate expiring soon (< 7 days) | 1 hour |
| 🟡 Medium | High resource usage (> 80%) | 4 hours |
| 🟢 Low | Occasional errors in logs | By end of day |

## Escalation Path

```
Level 1 (On-Call): _________________ (Phone: ______)
  ↓ (if not resolved in 15 min)
Level 2 (Senior): _________________ (Phone: ______)
  ↓ (if not resolved in 30 min)
Level 3 (Manager): ________________ (Phone: ______)
```

## Incident Checklist

When something goes wrong:

```
□ Confirm issue is real (not false alarm)
□ Check systemd logs
□ Check MongoDB connection
□ Check certificate status
□ Gather diagnostics: journalctl, free, df, ps aux
□ Attempt restart
□ If reboot needed: inform stakeholders first
□ Restore from backup if needed
□ Document in incident log
□ Post-mortem within 24 hours
```

## Key Metrics to Monitor

```
✅ Service uptime: Should be > 99.9%
✅ Average response time: Should be < 100ms
✅ Certificate validity: Should be > 30 days
✅ Disk usage: Should be < 80%
✅ Memory usage: Should be < 60%
✅ CPU usage: Should be < 70%
✅ MongoDB latency: Should be < 500ms
✅ Rate limit blocks: Monitor for DDoS patterns
```

## Quick Test Commands

```bash
# Health check
curl http://localhost:3000/health

# List agents
curl http://localhost:3000/agents -H "Authorization: Bearer $API_KEY"

# List tunnels
curl http://localhost:3000/tunnels -H "Authorization: Bearer $API_KEY"

# List domains
curl http://localhost:3000/domains -H "Authorization: Bearer $API_KEY"

# List VPS servers
curl http://localhost:3000/vps -H "Authorization: Bearer $API_KEY"

# Test rate limiter (make 6 requests, 6th should be 429)
for i in {1..6}; do curl -w "Request $i: %{http_code}\n" http://localhost:3000/; done

# Test Telegram
curl -X POST http://localhost:3000/test-notification -H "Authorization: Bearer $API_KEY"
```

---

**Keep this card accessible at all times during operations!**

*Laminate or save as PDF for easy reference*
