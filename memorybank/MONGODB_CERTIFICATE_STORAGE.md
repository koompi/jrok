# MongoDB-Based Certificate Storage & Sync

## Architecture Overview

Instead of using SSH/SCP for certificate distribution (which requires server-to-server connectivity), certificates are stored in MongoDB and each VPS pulls them independently.

```
┌────────────────────────────────────────────────────────────────┐
│ Control Server                                                  │
│ ├─ Certbot (issues/renews certificates)                        │
│ └─ Certificate Upload Service                                  │
│    └─ Uploads to MongoDB after renewal                         │
└──────────────────────┬─────────────────────────────────────────┘
                       │
                       │ HTTPS (no authentication needed)
                       │ All certificates stored in MongoDB
                       │ (encrypted in transit & at rest)
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
    ┌────────┐   ┌────────┐    ┌────────┐
    │ VPS 1  │   │ VPS 2  │    │ VPS 3  │
    │ Sync   │   │ Sync   │    │ Sync   │
    │Daemon  │   │Daemon  │    │Daemon  │
    └────────┘   └────────┘    └────────┘
    
    Every 6 hours (or on demand):
    - Pull certificates from MongoDB
    - Verify signatures
    - Reload nginx if changed
```

## MongoDB Certificate Collection Schema

```javascript
db.certificates.insertOne({
  _id: "koompi.cloud",
  domain: "koompi.cloud",
  cert: "base64-encoded-cert.pem",
  chain: "base64-encoded-chain.pem",
  fullchain: "base64-encoded-fullchain.pem",
  privkey: "base64-encoded-privkey.pem",
  expiry: ISODate("2026-01-15T00:00:00Z"),
  updatedAt: ISODate("2025-12-15T10:00:00Z"),
  uploadedBy: "system",
  version: 1,
  validationStatus: "valid"
})
```

## Implementation Steps

### 1. Create MongoDB Collection & Indexes

Connect to MongoDB and run:

```javascript
// Create certificates collection
db.createCollection("certificates");

// Create indexes
db.certificates.createIndex({ domain: 1 }, { unique: true });
db.certificates.createIndex({ expiry: 1 });
db.certificates.createIndex({ updatedAt: -1 });

// Enable encryption at rest (if using MongoDB Atlas paid tier)
// Free tier stores but doesn't encrypt - use HTTPS for transit
```

### 2. API Endpoints Implementation

Add these endpoints to your control server (`src/index.ts`):

```typescript
// Upload certificate to MongoDB
POST /certificates/upload
Headers:
  - Authorization: Bearer $API_KEY
  - Content-Type: application/json
Body:
  {
    "domain": "koompi.cloud",
    "certPem": "base64-string",
    "chainPem": "base64-string",
    "fullchainPem": "base64-string",
    "privkeyPem": "base64-string"
  }
Response:
  {
    "success": true,
    "message": "Certificate uploaded and synced to MongoDB",
    "domain": "koompi.cloud",
    "expiry": "2026-01-15T00:00:00Z",
    "version": 1
  }

// Download certificate from MongoDB
GET /certificates/download/:domain
Headers:
  - Authorization: Bearer $API_KEY
Response:
  {
    "domain": "koompi.cloud",
    "cert": "base64-string",
    "chain": "base64-string",
    "fullchain": "base64-string",
    "privkey": "base64-string",
    "expiry": "2026-01-15T00:00:00Z",
    "updatedAt": "2025-12-15T10:00:00Z"
  }

// Check certificate status
GET /certificates/status/:domain
Response:
  {
    "domain": "koompi.cloud",
    "expiry": "2026-01-15T00:00:00Z",
    "daysRemaining": 31,
    "lastUpdated": "2025-12-15T10:00:00Z",
    "version": 1,
    "status": "valid"
  }

// List all certificates
GET /certificates/list
Response:
  [
    {
      "domain": "koompi.cloud",
      "expiry": "2026-01-15T00:00:00Z",
      "daysRemaining": 31,
      "lastUpdated": "2025-12-15T10:00:00Z",
      "status": "valid"
    }
  ]
```

### 3. Control Server: Upload on Renewal

Create a renewal hook script on control server:

```bash
#!/bin/bash
# /etc/letsencrypt/renewal-hooks/post/mongodb-sync.sh

DOMAIN="koompi.cloud"
API_KEY="your-api-key"
CONTROL_SERVER="http://localhost:3000"
CERT_PATH="/etc/letsencrypt/live/$DOMAIN"

# Encode certificates in base64
CERT=$(cat "$CERT_PATH/cert.pem" | base64 -w0)
CHAIN=$(cat "$CERT_PATH/chain.pem" | base64 -w0)
FULLCHAIN=$(cat "$CERT_PATH/fullchain.pem" | base64 -w0)
PRIVKEY=$(cat "$CERT_PATH/privkey.pem" | base64 -w0)

# Upload to MongoDB via API
RESPONSE=$(curl -s -X POST "$CONTROL_SERVER/certificates/upload" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "'$DOMAIN'",
    "certPem": "'$CERT'",
    "chainPem": "'$CHAIN'",
    "fullchainPem": "'$FULLCHAIN'",
    "privkeyPem": "'$PRIVKEY'"
  }')

# Check if upload succeeded
if echo "$RESPONSE" | grep -q "success.*true"; then
    # Send Telegram notification
    curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
      -d "chat_id=$TELEGRAM_CHAT_ID" \
      -d "text=✅ Certificate renewed and synced to MongoDB for $DOMAIN"
    
    # Trigger sync on all VPS (optional - they pull automatically every 6 hours)
    for vps_ip in 1.2.3.4 5.6.7.8 9.10.11.12; do
        curl -s -X POST "http://$vps_ip:3000/certificates/sync" \
          -H "Authorization: Bearer $API_KEY" \
          -w "[%{http_code}] $vps_ip\n" 2>/dev/null
    done
    
    exit 0
else
    # Send error notification
    curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
      -d "chat_id=$TELEGRAM_CHAT_ID" \
      -d "text=❌ CRITICAL: Certificate renewal sync to MongoDB FAILED for $DOMAIN. Manual intervention required."
    
    exit 1
fi
```

Make it executable:
```bash
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/mongodb-sync.sh
sudo chown root:root /etc/letsencrypt/renewal-hooks/post/mongodb-sync.sh
```

Test it:
```bash
sudo certbot renew --dry-run
```

### 4. VPS: Automatic Certificate Pull

On each VPS, create the sync daemon:

```bash
#!/bin/bash
# /usr/local/bin/sync-certificates-from-mongodb.sh

set -e

# Configuration (set these in environment or here)
CONTROL_SERVER="http://control-server-ip:3000"
API_KEY="your-api-key"
DOMAIN="koompi.cloud"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
LOG_FILE="/var/log/cert-sync.log"
TEMP_DIR="/tmp/cert-sync-$$"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Create temp directory
mkdir -p "$TEMP_DIR"
trap "rm -rf $TEMP_DIR" EXIT

log_message() {
    local level=$1
    local msg=$2
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $msg" | tee -a "$LOG_FILE"
}

log_message "INFO" "Starting certificate sync from MongoDB"

# Download certificates from MongoDB
if ! curl -s -f "$CONTROL_SERVER/certificates/download/$DOMAIN" \
    -H "Authorization: Bearer $API_KEY" \
    -o "$TEMP_DIR/certs.json"; then
    log_message "ERROR" "Failed to download certificates from MongoDB"
    exit 1
fi

# Verify we got valid JSON
if ! jq empty "$TEMP_DIR/certs.json" 2>/dev/null; then
    log_message "ERROR" "Downloaded file is not valid JSON"
    exit 1
fi

# Extract and decode certificates from JSON
log_message "INFO" "Extracting certificate files..."

jq -r '.cert' "$TEMP_DIR/certs.json" | base64 -d > "$TEMP_DIR/cert.pem" || {
    log_message "ERROR" "Failed to decode cert.pem"
    exit 1
}

jq -r '.chain' "$TEMP_DIR/certs.json" | base64 -d > "$TEMP_DIR/chain.pem" || {
    log_message "ERROR" "Failed to decode chain.pem"
    exit 1
}

jq -r '.fullchain' "$TEMP_DIR/certs.json" | base64 -d > "$TEMP_DIR/fullchain.pem" || {
    log_message "ERROR" "Failed to decode fullchain.pem"
    exit 1
}

jq -r '.privkey' "$TEMP_DIR/certs.json" | base64 -d > "$TEMP_DIR/privkey.pem" || {
    log_message "ERROR" "Failed to decode privkey.pem"
    exit 1
}

# Verify certificate is valid
log_message "INFO" "Verifying certificate..."
if ! openssl x509 -in "$TEMP_DIR/cert.pem" -noout -dates >> "$LOG_FILE" 2>&1; then
    log_message "ERROR" "Certificate validation failed"
    exit 1
fi

# Calculate current certificate fingerprint
CURRENT_HASH=""
if [ -f "$CERT_DIR/cert.pem" ]; then
    CURRENT_HASH=$(openssl x509 -in "$CERT_DIR/cert.pem" -noout -fingerprint 2>/dev/null || echo "")
fi

NEW_HASH=$(openssl x509 -in "$TEMP_DIR/cert.pem" -noout -fingerprint)

# Copy to proper location only if changed
if [ "$CURRENT_HASH" != "$NEW_HASH" ]; then
    log_message "INFO" "Certificate updated detected, copying to $CERT_DIR"
    
    # Create backup if directory exists
    if [ -d "$CERT_DIR" ]; then
        BACKUP_FILE="$CERT_DIR/backup-$(date +%Y%m%d-%H%M%S).tar.gz"
        tar -czf "$BACKUP_FILE" -C "$CERT_DIR" . 2>/dev/null || true
        log_message "INFO" "Backup created: $BACKUP_FILE"
    else
        mkdir -p "$CERT_DIR"
    fi
    
    # Copy files with proper permissions
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
    
    # Reload nginx to use new certificate
    log_message "INFO" "Reloading nginx with new certificate..."
    if sudo systemctl reload nginx; then
        log_message "INFO" "Nginx reloaded successfully"
        
        # Save hash for next comparison
        echo "$NEW_HASH" > "/var/cache/cert-$DOMAIN.hash"
    else
        log_message "ERROR" "Failed to reload nginx"
        exit 1
    fi
else
    log_message "INFO" "Certificate unchanged, no reload needed"
fi

log_message "INFO" "Certificate sync completed successfully"
exit 0
```

Make executable and set permissions:
```bash
sudo chmod +x /usr/local/bin/sync-certificates-from-mongodb.sh
sudo chown root:root /usr/local/bin/sync-certificates-from-mongodb.sh
```

### 5. Schedule Automatic Syncing

Add to crontab on each VPS (runs every 6 hours):

```bash
sudo crontab -e
```

Add these lines:
```cron
# Sync certificates from MongoDB every 6 hours
0 0,6,12,18 * * * /usr/local/bin/sync-certificates-from-mongodb.sh >> /var/log/cert-sync.log 2>&1

# Alert if certificate expires soon (every day at 8 AM)
0 8 * * * if [ $(/usr/local/bin/check-cert-expiry.sh) -lt 7 ]; then echo "Certificate expires in < 7 days" | mail -s "ALERT: Cert Expiry" admin@example.com; fi
```

Test manually first:
```bash
sudo /usr/local/bin/sync-certificates-from-mongodb.sh
tail -f /var/log/cert-sync.log
```

### 6. Monitoring & Alerts

Create monitoring script on control server:

```bash
#!/bin/bash
# /usr/local/bin/monitor-certificate-sync.sh

CONTROL_SERVER="http://localhost:3000"
API_KEY="your-api-key"
TELEGRAM_BOT_TOKEN="your-bot-token"
TELEGRAM_CHAT_ID="your-chat-id"

# Check all domains
for domain in koompi.cloud; do
    STATUS=$(curl -s "$CONTROL_SERVER/certificates/status/$domain" \
      -H "Authorization: Bearer $API_KEY")
    
    DAYS_LEFT=$(echo "$STATUS" | jq '.daysRemaining')
    LAST_UPDATED=$(echo "$STATUS" | jq -r '.lastUpdated')
    CERT_STATUS=$(echo "$STATUS" | jq -r '.status')
    
    # Alert if certificate expires in less than 14 days
    if [ "$DAYS_LEFT" -lt 14 ] && [ "$DAYS_LEFT" -gt 0 ]; then
        curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
          -d "chat_id=$TELEGRAM_CHAT_ID" \
          -d "text=⚠️ Certificate $domain expires in $DAYS_LEFT days"
    fi
    
    # Alert if certificate already expired
    if [ "$DAYS_LEFT" -le 0 ]; then
        curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
          -d "chat_id=$TELEGRAM_CHAT_ID" \
          -d "text=🚨 CRITICAL: Certificate $domain has EXPIRED"
    fi
    
    # Alert if not updated recently (more than 12 hours)
    LAST_UPDATE_EPOCH=$(date -d "$LAST_UPDATED" +%s)
    NOW_EPOCH=$(date +%s)
    HOURS_SINCE_UPDATE=$(( (NOW_EPOCH - LAST_UPDATE_EPOCH) / 3600 ))
    
    if [ "$HOURS_SINCE_UPDATE" -gt 12 ]; then
        curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
          -d "chat_id=$TELEGRAM_CHAT_ID" \
          -d "text=⚠️ Certificate $domain not updated in $HOURS_SINCE_UPDATE hours (MongoDB sync may have failed)"
    fi
done
```

Add to crontab (check every 6 hours):
```cron
0 */6 * * * /usr/local/bin/monitor-certificate-sync.sh
```

---

## Benefits of MongoDB-Based Certificate Storage

### ✅ No Server-to-Server SSH Needed
- Each VPS independently pulls certificates
- No security group rules for inter-VPS communication
- Complete isolation possible

### ✅ Highly Available
- All servers read from same source of truth
- Automatic MongoDB replication
- No inconsistencies between servers

### ✅ Scalable
- Add new VPS anytime by adding sync script
- No additional setup needed for new servers
- Linear scaling (MongoDB handles it)

### ✅ Auditable
- Version tracking in MongoDB
- Timestamp of each update
- Who uploaded (uploadedBy field)

### ✅ Secure
- Credentials only needed for MongoDB (once at setup)
- HTTPS for all API calls
- Base64 encoding prevents binary issues

### ✅ Automatic
- Certbot renewal hook auto-uploads
- Each VPS auto-pulls every 6 hours
- No manual intervention needed

---

## Security Considerations

### 1. API Key Protection
Store securely on each VPS:
```bash
# /etc/jrok/api-key (readable only by root)
sudo nano /etc/jrok/api-key
sudo chmod 600 /etc/jrok/api-key
```

Then source in sync script:
```bash
source /etc/jrok/api-key
```

### 2. HTTPS for Uploads
Always use HTTPS:
```bash
CONTROL_SERVER="https://control-server:3000"  # Not http://
```

### 3. MongoDB Encryption
- Free tier: Data at rest unencrypted (acceptable for certs)
- Paid tier: Enable encryption at rest
- In transit: Always use HTTPS

### 4. Backup Private Keys
```bash
# Backup private keys (keep offline)
tar -czf /secure-backup/certs-privkeys-$(date +%Y%m%d).tar.gz \
  /etc/letsencrypt/live/koompi.cloud/privkey.pem
```

---

## Troubleshooting

### Certificates Not Syncing

```bash
# Check sync log
tail -100 /var/log/cert-sync.log

# Test API endpoint manually
curl -v "http://control-server:3000/certificates/download/koompi.cloud" \
  -H "Authorization: Bearer $API_KEY"

# Check MongoDB has certificates
mongosh "$MONGODB_URI" --eval "db.certificates.findOne()"

# Test sync script with debug
bash -x /usr/local/bin/sync-certificates-from-mongodb.sh
```

### Cron Not Running

```bash
# Check cron service
sudo systemctl status cron

# Check cron logs
sudo journalctl -u cron -n 50

# Run sync manually
sudo /usr/local/bin/sync-certificates-from-mongodb.sh

# Verify it worked
sudo cat /var/log/cert-sync.log | tail -5
```

### Nginx Not Reloading

```bash
# Test nginx config
sudo nginx -t

# Check nginx errors
sudo systemctl status nginx

# Manual reload
sudo systemctl reload nginx
```

---

## Performance Impact

- **API Upload:** ~100ms (base64 encoding takes time)
- **API Download:** ~50ms (mostly JSON parsing)
- **Nginx Reload:** ~100ms (graceful restart)
- **Total per sync:** ~250ms (occurs every 6 hours)
- **Zero downtime:** Uses reload not restart

---

## Scaling to Multiple Domains

Simply add more entries to MongoDB:

```bash
# Upload second domain
curl -X POST http://localhost:3000/certificates/upload \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "domain": "api.koompi.cloud",
    "certPem": "...",
    ...
  }'

# Each VPS can pull multiple domains
for domain in koompi.cloud api.koompi.cloud; do
    /usr/local/bin/sync-certificates-from-mongodb.sh "$domain"
done
```

---

**This approach eliminates the need for direct VPS-to-VPS connectivity while maintaining a single source of truth for all certificates!**
