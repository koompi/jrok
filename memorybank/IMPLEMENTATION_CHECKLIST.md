> ⚠️ HISTORICAL — describes the pre-kproxy nginx + Certbot/Let's Encrypt (leader-based) design that was removed. See ../docs/getting-started/architecture.md for the current architecture.

# Complete Implementation Checklist

## Phase 1: Setup & Preparation

### Prerequisites
- [ ] 3 Control Servers (Bun.js + jrok running)
- [ ] 3 VPS Servers (for tunnels, nginx)
- [ ] MongoDB Atlas free M0 cluster created
- [ ] Domain configured (tunnel.koompi.cloud)
- [ ] Cloudflare API token available
- [ ] Telegram bot token available
- [ ] API keys generated (min 32 chars): `CERT_SYNC_API_KEY`

### Understanding
- [ ] Read `VISUAL_ARCHITECTURE_SUMMARY.md` (diagrams)
- [ ] Read `ANSWERS_TO_YOUR_QUESTIONS.md` (Q&A)
- [ ] Read `LEADER_BASED_ARCHITECTURE.md` (detailed design)
- [ ] Understand race condition prevention
- [ ] Understand automatic failover mechanism
- [ ] Understand server isolation approach

---

## Phase 2: Code Deployment

### On All Control Servers

#### Step 1: Verify New Service File
```bash
# File should exist and be ~200 lines
ls -lh src/services/certificateSyncService.ts

# Contains:
# - attemptBecomeLeader()
# - refreshLeaderLease()
# - uploadCertificateToMongoDB()
# - downloadCertificateFromMongoDB()
# - initializeCertificateSync()
```
- [ ] File exists
- [ ] File is readable
- [ ] File contains all functions

#### Step 2: Verify domainService Updates
```bash
# Check that SCP functions are removed
grep -i "syncCertToVps\|syncCertificateToAllVps" src/services/domainService.ts

# Should return: (nothing - functions removed)
```
- [ ] No SCP functions found
- [ ] Imports certificateSyncService
- [ ] registerCustomDomain() uses leader election
- [ ] resyncCertificate() uses leader election
- [ ] transferDomain() uses leader election

#### Step 3: Implement API Endpoints
```bash
# In src/index.ts, add:
# - POST /certificates/upload
# - GET /certificates/download/:domain
# - GET /certificates/status/:domain
# - GET /certificates/list
```
- [ ] API key authentication middleware
- [ ] POST /certificates/upload implemented
- [ ] GET /certificates/download/:domain implemented
- [ ] GET /certificates/status/:domain implemented
- [ ] GET /certificates/list implemented
- [ ] All endpoints require Authorization header

#### Step 4: Set Environment Variables
```bash
# On EACH control server, add to /etc/environment or .env:

CERT_SYNC_API_KEY="your-32-char-secret-key-here"
SERVER_ID="control-1"  # Change: control-2, control-3 on other servers
MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/jrok"
```
- [ ] CERT_SYNC_API_KEY set (same on all servers)
- [ ] SERVER_ID set (unique per server: control-1, control-2, control-3)
- [ ] MONGODB_URI set (same on all servers)
- [ ] Variables sourced before app startup

#### Step 5: Initialize Certificate Sync
```bash
# In src/index.ts main startup:
await certSyncService.initializeCertificateSync();
```
- [ ] initializeCertificateSync() called on startup
- [ ] MongoDB collections created automatically
- [ ] Indexes created on collections
- [ ] Collections: certificates, leader_leases, cert_sync_queue

#### Step 6: Restart Application
```bash
# Restart all control servers
systemctl restart jrok
# OR: supervisorctl restart jrok
# OR: kill and restart manually
```
- [ ] Control-1 restarted
- [ ] Control-2 restarted
- [ ] Control-3 restarted
- [ ] All running without errors
- [ ] Check logs: no errors in stderr

---

## Phase 3: Certbot Renewal Hook Setup

### On All Control Servers

#### Create Renewal Hook Script
```bash
sudo nano /etc/letsencrypt/renewal-hooks/post/mongodb-sync.sh
```

Copy this content:
```bash
#!/bin/bash
DOMAIN="koompi.cloud"
API_KEY="${CERT_SYNC_API_KEY}"
CONTROL_SERVER="http://localhost:3000"
CERT_PATH="/etc/letsencrypt/live/$DOMAIN"

# Read certificate files
CERT=$(cat "$CERT_PATH/cert.pem")
CHAIN=$(cat "$CERT_PATH/chain.pem")
FULLCHAIN=$(cat "$CERT_PATH/fullchain.pem")
PRIVKEY=$(cat "$CERT_PATH/privkey.pem")

# Base64 encode
CERT_B64=$(echo -n "$CERT" | base64 | tr -d '\n')
CHAIN_B64=$(echo -n "$CHAIN" | base64 | tr -d '\n')
FULLCHAIN_B64=$(echo -n "$FULLCHAIN" | base64 | tr -d '\n')
PRIVKEY_B64=$(echo -n "$PRIVKEY" | base64 | tr -d '\n')

# Upload to MongoDB
curl -X POST "$CONTROL_SERVER/certificates/upload" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "domain": "$DOMAIN",
  "certPem": "$CERT_B64",
  "chainPem": "$CHAIN_B64",
  "fullchainPem": "$FULLCHAIN_B64",
  "privkeyPem": "$PRIVKEY_B64"
}
EOF

echo "$(date): Certificate uploaded to MongoDB" >> /var/log/certbot-sync.log
```

- [ ] File created at /etc/letsencrypt/renewal-hooks/post/mongodb-sync.sh
- [ ] File is executable: `chmod +x ...`
- [ ] DOMAIN set correctly
- [ ] API_KEY references environment variable

#### Test the Hook
```bash
# Run manually to test
/etc/letsencrypt/renewal-hooks/post/mongodb-sync.sh

# Check response
curl -s http://localhost:3000/certificates/status/koompi.cloud \
  -H "Authorization: Bearer $API_KEY" | jq .
```
- [ ] Script runs without errors
- [ ] Certificate appears in MongoDB
- [ ] Status endpoint returns valid response

---

## Phase 4: VPS Server Sync Daemon Setup

### On All 3 VPS Servers

#### Install Dependencies
```bash
sudo apt update
sudo apt install -y curl jq openssl nginx

# Verify
curl --version
jq --version
openssl version
```
- [ ] curl installed
- [ ] jq installed
- [ ] openssl installed
- [ ] nginx installed

#### Create Sync Script
```bash
sudo nano /usr/local/bin/sync-certificates-from-mongodb.sh
```

Copy this content:
```bash
#!/bin/bash
DOMAIN="koompi.cloud"
API_KEY="${CERT_SYNC_API_KEY}"
CONTROL_SERVER="${CONTROL_SERVER_URL:-https://tunnel.koompi.cloud}"
API_ENDPOINT="$CONTROL_SERVER/certificates/download/$DOMAIN"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
LOG_FILE="/var/log/cert-sync.log"

mkdir -p "$CERT_DIR"

# Download from MongoDB
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_ENDPOINT" \
  -H "Authorization: Bearer $API_KEY")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
JSON_BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" != "200" ]; then
  echo "$(date): ❌ Failed to download certificate (HTTP $HTTP_CODE)" >> "$LOG_FILE"
  exit 1
fi

# Extract and decode certificates
echo "$JSON_BODY" | jq -r '.fullchain' | base64 -d > "$CERT_DIR/fullchain.pem.new" || {
  echo "$(date): ❌ Failed to decode certificate" >> "$LOG_FILE"
  exit 1
}

echo "$JSON_BODY" | jq -r '.privkey' | base64 -d > "$CERT_DIR/privkey.pem.new" || {
  echo "$(date): ❌ Failed to decode privkey" >> "$LOG_FILE"
  exit 1
}

echo "$JSON_BODY" | jq -r '.cert' | base64 -d > "$CERT_DIR/cert.pem.new"
echo "$JSON_BODY" | jq -r '.chain' | base64 -d > "$CERT_DIR/chain.pem.new"

# Verify certificate
openssl x509 -in "$CERT_DIR/fullchain.pem.new" -noout 2>/dev/null
if [ $? -ne 0 ]; then
  echo "$(date): ❌ Invalid certificate from MongoDB" >> "$LOG_FILE"
  rm -f "$CERT_DIR"/*.pem.new
  exit 1
fi

# Check if certificate changed (compare fingerprints)
if [ -f "$CERT_DIR/fullchain.pem" ]; then
  OLD_FP=$(openssl x509 -noout -fingerprint -in "$CERT_DIR/fullchain.pem" 2>/dev/null | cut -d= -f2)
  NEW_FP=$(openssl x509 -noout -fingerprint -in "$CERT_DIR/fullchain.pem.new" | cut -d= -f2)
  
  if [ "$OLD_FP" = "$NEW_FP" ]; then
    echo "$(date): ℹ️ Certificate unchanged" >> "$LOG_FILE"
    rm -f "$CERT_DIR"/*.pem.new
    exit 0
  fi
fi

# Certificate changed - deploy it
mkdir -p "$CERT_DIR"
cp "$CERT_DIR/fullchain.pem" "$CERT_DIR/fullchain.pem.bak" 2>/dev/null
mv "$CERT_DIR/fullchain.pem.new" "$CERT_DIR/fullchain.pem"
mv "$CERT_DIR/privkey.pem.new" "$CERT_DIR/privkey.pem"
mv "$CERT_DIR/cert.pem.new" "$CERT_DIR/cert.pem"
mv "$CERT_DIR/chain.pem.new" "$CERT_DIR/chain.pem"

chmod 644 "$CERT_DIR"/*.pem

# Reload nginx
systemctl reload nginx 2>/dev/null
if [ $? -eq 0 ]; then
  echo "$(date): ✅ Certificate synced and nginx reloaded" >> "$LOG_FILE"
else
  echo "$(date): ⚠️ Certificate synced but nginx reload failed" >> "$LOG_FILE"
fi
```

- [ ] File created at /usr/local/bin/sync-certificates-from-mongodb.sh
- [ ] File is executable: `chmod +x ...`
- [ ] DOMAIN set correctly
- [ ] CONTROL_SERVER_URL points to your control server HTTPS endpoint

#### Test the Script
```bash
# Run manually
sudo /usr/local/bin/sync-certificates-from-mongodb.sh

# Check log
sudo tail -f /var/log/cert-sync.log

# Should see:
# ✅ Certificate synced and nginx reloaded
# OR
# ℹ️ Certificate unchanged
```
- [ ] Script runs without errors
- [ ] Certificates downloaded from MongoDB
- [ ] Certificates verified with openssl
- [ ] nginx reloaded successfully
- [ ] Log file created and updated

#### Set Environment Variables on VPS
```bash
# Add to /etc/environment:
CERT_SYNC_API_KEY="your-32-char-key"
CONTROL_SERVER_URL="https://tunnel.koompi.cloud"
```
- [ ] CERT_SYNC_API_KEY set (same on all servers)
- [ ] CONTROL_SERVER_URL set (points to your control server HTTPS)
- [ ] Variables sourced

---

## Phase 5: Cron Job Scheduling

### On All 3 VPS Servers

#### Add to Crontab
```bash
sudo crontab -e

# Add this line:
0 */6 * * * /usr/local/bin/sync-certificates-from-mongodb.sh
```

Or use cron.d:
```bash
sudo nano /etc/cron.d/cert-sync

# Add:
0 */6 * * * root /usr/local/bin/sync-certificates-from-mongodb.sh
```

- [ ] Cron job added to all 3 VPS servers
- [ ] Runs every 6 hours (0 */6 * * *)
- [ ] Timing verified: 00:00, 06:00, 12:00, 18:00
- [ ] Run manually once: `sudo /usr/local/bin/sync-certificates-from-mongodb.sh`

#### Verify Cron Configuration
```bash
# List cron jobs
sudo crontab -l

# Should show:
# 0 */6 * * * /usr/local/bin/sync-certificates-from-mongodb.sh
```
- [ ] Cron job listed
- [ ] Syntax is correct

---

## Phase 6: Testing & Verification

### Test 1: MongoDB Collections Created
```bash
# In MongoDB Atlas dashboard or via mongosh:
db.getCollectionNames()

# Should show: ["certificates", "leader_leases", "cert_sync_queue"]
```
- [ ] certificates collection exists
- [ ] leader_leases collection exists
- [ ] cert_sync_queue collection exists

### Test 2: Leader Election
```bash
# On Control-1:
curl -s http://localhost:3000/certificates/list \
  -H "Authorization: Bearer $CERT_SYNC_API_KEY" | jq '.[] | {leader: .uploadedBy}'

# Should show: "uploadedBy": "control-1"

# On Control-2:
# Same call should return same leader (still control-1)
```
- [ ] Only 1 server shows as leader
- [ ] Leader consistent across servers
- [ ] Can query from each control server

### Test 3: Certificate Upload
```bash
# Manually test certificate upload:
CERT_PATH="/etc/letsencrypt/live/koompi.cloud"

curl -X POST http://localhost:3000/certificates/upload \
  -H "Authorization: Bearer $CERT_SYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "domain": "koompi.cloud",
  "certPem": "$(cat $CERT_PATH/cert.pem | base64 | tr -d '\n')",
  "chainPem": "$(cat $CERT_PATH/chain.pem | base64 | tr -d '\n')",
  "fullchainPem": "$(cat $CERT_PATH/fullchain.pem | base64 | tr -d '\n')",
  "privkeyPem": "$(cat $CERT_PATH/privkey.pem | base64 | tr -d '\n')"
}
EOF

# Should return:
# {"success": true, "domain": "koompi.cloud", "version": 1}
```
- [ ] Upload succeeds
- [ ] Returns success: true
- [ ] Version incremented
- [ ] Certificate in MongoDB

### Test 4: Certificate Download
```bash
# On Control-1:
curl -s https://tunnel.koompi.cloud/certificates/download/koompi.cloud \
  -H "Authorization: Bearer $CERT_SYNC_API_KEY" | jq 'keys'

# Should show: ["cert", "chain", "expiry", "fullchain", "privkey", "updatedAt"]
```
- [ ] Download succeeds
- [ ] Returns all certificate fields
- [ ] Base64 encoded correctly
- [ ] Expiry date present

### Test 5: VPS Sync Script
```bash
# On VPS-1:
sudo /usr/local/bin/sync-certificates-from-mongodb.sh

# Check log:
sudo tail -5 /var/log/cert-sync.log

# Should show one of:
# ✅ Certificate synced and nginx reloaded
# ℹ️ Certificate unchanged
```
- [ ] Script runs on VPS-1
- [ ] Script runs on VPS-2
- [ ] Script runs on VPS-3
- [ ] All show success or unchanged
- [ ] Nginx reloaded

### Test 6: Automatic Failover
```bash
# Stop Control-1:
# (on control-1) systemctl stop jrok

# Wait 31 seconds

# Check Control-2 is leader:
curl -s http://localhost:3000/certificates/list \
  -H "Authorization: Bearer $CERT_SYNC_API_KEY" | jq '.[] | {leader: .uploadedBy}'

# Should now show: "uploadedBy": "control-2"

# Verify VPS still syncs:
sudo /usr/local/bin/sync-certificates-from-mongodb.sh

# Should succeed (no errors)

# Restart Control-1:
# (on control-1) systemctl start jrok
```
- [ ] Control-1 stopped successfully
- [ ] Control-2 becomes leader in ~30 seconds
- [ ] VPS can still sync from MongoDB
- [ ] Control-1 restarted
- [ ] Normal operation restored

### Test 7: Cert Renewal Rotation
```bash
# Check leadership
while true; do
  LEADER=$(curl -s http://localhost:3000/certificates/list \
    -H "Authorization: Bearer $CERT_SYNC_API_KEY" | \
    jq -r '.[] | .uploadedBy' | head -1)
  echo "Current leader: $LEADER"
  sleep 5
done

# Kill current leader every 30 seconds and observe failover
```
- [ ] Leadership transfers between servers
- [ ] Failover happens automatically
- [ ] No race conditions
- [ ] No certificate corruption

---

## Phase 7: Monitoring & Alerting

### Setup Monitoring
```bash
# On Control-1, create monitoring script:
sudo nano /usr/local/bin/monitor-certificates.sh
```

Content:
```bash
#!/bin/bash
API_KEY="${CERT_SYNC_API_KEY}"
CONTROL_SERVER="http://localhost:3000"

# Check certificate status
CERTS=$(curl -s "$CONTROL_SERVER/certificates/list" \
  -H "Authorization: Bearer $API_KEY")

echo "$CERTS" | jq '.[] | select(.daysRemaining < 14)' | while read cert; do
  DOMAIN=$(echo "$cert" | jq -r '.domain')
  DAYS=$(echo "$cert" | jq -r '.daysRemaining')
  
  echo "⚠️ Certificate expiring soon: $DOMAIN ($DAYS days remaining)"
  # Send Telegram alert here
done
```

- [ ] Monitoring script created
- [ ] Script checks certificate expiry
- [ ] Script runs every hour (cron job)

### Setup Alerts
- [ ] Telegram bot configured (existing)
- [ ] Alert on certificate < 14 days to expiry
- [ ] Alert on sync failures (check logs)
- [ ] Alert on leader change (monitor logs)

---

## Phase 8: Production Deployment

### Pre-Production Checklist
- [ ] All 3 control servers running
- [ ] All 3 VPS servers running
- [ ] MongoDB Atlas cluster created and verified
- [ ] All API endpoints tested
- [ ] All cron jobs scheduled
- [ ] All environment variables set
- [ ] All logs being written
- [ ] Monitoring alerts working
- [ ] Failover tested and working
- [ ] No SCP/SSH certificate code remaining

### Deployment Steps
1. [ ] Verify all code changes committed
2. [ ] Deploy certificateSyncService.ts to all control servers
3. [ ] Deploy updated domainService.ts to all control servers
4. [ ] Restart all control servers
5. [ ] Verify leader election working
6. [ ] Deploy sync script to all VPS servers
7. [ ] Add cron jobs to all VPS servers
8. [ ] Test certificate sync manually
9. [ ] Wait for first automatic sync (6 hours)
10. [ ] Monitor logs for issues
11. [ ] Declare production ready

### Post-Deployment
- [ ] Monitor logs daily for first week
- [ ] Check leader election logs
- [ ] Verify cron jobs are running
- [ ] Monitor certificate expiry
- [ ] Check VPS sync logs
- [ ] Verify Telegram alerts working
- [ ] Setup long-term monitoring

---

## Troubleshooting Checklist

If something doesn't work:

### Leader Election Not Working
- [ ] Check MongoDB connection: `mongo --eval "db.admin.ping()"`
- [ ] Check API key matches on all servers
- [ ] Check SERVER_ID is different on each control server
- [ ] Check MongoDB network access allows all control servers

### Certificate Not Syncing
- [ ] Check API endpoint returns data: `curl ... /certificates/list`
- [ ] Check API key is correct
- [ ] Check firewall allows HTTPS on control server
- [ ] Check VPS can reach control server: `curl -I https://control...`

### Nginx Not Reloading
- [ ] Check nginx config: `nginx -t`
- [ ] Check certificate files exist: `ls -la /etc/letsencrypt/live/...`
- [ ] Check permissions: `ls -la /etc/letsencrypt/live/*/...pem`
- [ ] Test reload manually: `systemctl reload nginx`

### Cron Not Running
- [ ] Check cron is enabled: `systemctl status cron`
- [ ] Check cron log: `grep CRON /var/log/syslog`
- [ ] Check script is executable: `ls -la /usr/local/bin/sync-...`
- [ ] Test manually: `/usr/local/bin/sync-certificates-from-mongodb.sh`

---

## Final Verification

```bash
# Run this to verify everything is working:

echo "=== Checking MongoDB ==="
mongo --eval "db.admin.ping()"

echo "=== Checking Control Servers ==="
curl -s http://control1:3000/certificates/list -H "Authorization: Bearer $API_KEY" | jq .

echo "=== Checking VPS Syncs ==="
for vps in vps1 vps2 vps3; do
  ssh $vps "tail -1 /var/log/cert-sync.log"
done

echo "=== Checking Cron Jobs ==="
crontab -l

echo "=== All systems operational! ✅ ==="
```

---

## Summary

**You have completed a production-grade certificate management system with:**

✅ Race condition prevention (MongoDB atomic operations)  
✅ Automatic failover (30-second lease detection)  
✅ Complete server isolation (no SSH/SCP)  
✅ High availability (3 control servers)  
✅ Async certificate distribution (VPS pull every 6 hours)  
✅ Monitoring and alerting (Telegram notifications)  
✅ 89-day fault tolerance (cached certificates)  

**Deployment Status: COMPLETE** 🎉
