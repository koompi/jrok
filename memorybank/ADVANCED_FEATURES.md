> ⚠️ HISTORICAL — describes the pre-kproxy nginx + Certbot/Let's Encrypt (leader-based) design that was removed. See ../docs/getting-started/architecture.md for the current architecture.

# Advanced Features Implementation

## Summary

Implemented 4 advanced features for the Jrok tunnel service:
1. **Domain Transfer** - Move domains between VPS servers/regions
2. **Certificate Backup/Restore** - Disaster recovery for certificates
3. **Rate Limiting** - Prevent abuse and Let's Encrypt rate limit issues
4. **Telegram Notifications** - Real-time alerts for critical events

---

## 1. Domain Transfer

### Overview
Transfer domain ownership and certificates to a different VPS or region while maintaining full syncing.

### Files Added/Modified
- `src/services/domainService.ts` - Added `transferDomain()` function
- `src/handlers/domainHandler.ts` - Added `handleTransferDomain()` endpoint
- `src/index.ts` - Added POST `/domains/{domain}/transfer` route

### API Endpoint
```
POST /domains/{domain}/transfer
Authorization: Bearer {api-key}

Request Body:
{
  "targetVpsId": "vps-id-123",
  "includeOtherServers": true  // Default: true
}

Response:
{
  "success": true,
  "message": "Domain transferred successfully",
  "domain": { /* CustomDomain object */ }
}
```

### How It Works
1. Validates target VPS exists and is healthy
2. Syncs certificates to target VPS first
3. If `includeOtherServers` is true, syncs to all healthy VPS servers
4. Updates domain sync timestamp
5. Sends Telegram notification

### Use Cases
- Migrate domain from one region to another
- Failover to backup VPS
- Consolidate multiple domains to primary VPS
- Regional load balancing

---

## 2. Certificate Backup & Restore

### Overview
Create backups of domain certificates for disaster recovery and easy restoration.

### Files Added/Modified
- `src/utils/backupUtils.ts` - New file with backup/restore utilities
- `src/services/domainService.ts` - Added `backupDomain()`, `restoreDomain()`, `listDomainBackups()`
- `src/handlers/domainHandler.ts` - Added backup/restore handlers
- `src/index.ts` - Added backup/restore routes

### API Endpoints
```
POST /domains/{domain}/backup
Authorization: Bearer {api-key}

Response:
{
  "success": true,
  "message": "Domain backup created successfully",
  "backup": {
    "id": "backup-id-123",
    "domain": "example.com",
    "timestamp": 1702641600000,
    "size": 45000
  }
}
```

```
GET /domains/{domain}/backup
Authorization: Bearer {api-key}

Response:
{
  "success": true,
  "backups": [
    {
      "id": "backup-id-123",
      "domain": "example.com",
      "timestamp": 1702641600000,
      "size": 45000
    }
  ],
  "total": 5
}
```

```
POST /domains/{domain}/backups/{backupId}/restore
Authorization: Bearer {api-key}

Response:
{
  "success": true,
  "message": "Domain restored from backup successfully",
  "domain": { /* CustomDomain object */ }
}
```

### Storage
- Backups stored in `./data/cert-backups/` directory
- Each backup is a separate directory with certificate files
- Metadata stored as `backup.json` inside backup directory

### Auto-Cleanup
`cleanupOldBackups()` function available to keep only N most recent backups per domain.

### Use Cases
- Disaster recovery after certificate corruption
- Quick rollback if renewal fails
- Testing certificate updates safely
- Compliance/audit trail of certificate changes

---

## 3. Rate Limiting

### Overview
Prevent abuse and avoid Let's Encrypt rate limits (50 cert/week per domain, 5 failures/hour per IP).

### Files Added/Modified
- `src/utils/rateLimiter.ts` - New rate limiting utility
- `src/handlers/domainHandler.ts` - Integrated rate limit checks
- `src/index.ts` - Added periodic cleanup of expired limits

### Rate Limit Configuration
```typescript
// Global per-IP limit
- Window: 1 hour
- Max: 5 registration attempts per hour per IP
- Returns: 429 Too Many Requests with Retry-After header

// Per-domain limit
- Window: 24 hours
- Max: 5 certificate operations per 24 hours per domain
- Returns: 429 Too Many Requests with Retry-After header
```

### Implementation Details
- In-memory storage (Map-based)
- Automatic cleanup of expired entries every 10 minutes
- Client IP detection from X-Forwarded-For, X-Real-IP, or connection
- Respects standard HTTP 429 and Retry-After headers

### API Behavior
```
GET /domains                               // No rate limit (read-only)
POST /domains (register)                   // Checked: global + per-domain
POST /domains/{domain}/transfer            // Checked: global (per-IP)
POST /domains/{domain}/backup              // Checked: global
POST /domains/{domain}/backups/{id}/restore// Checked: global
POST /domains/{domain}/resync              // Checked: global
```

### Response on Rate Limit
```json
{
  "success": false,
  "message": "Rate limit exceeded. Try again in 45 seconds"
}

Headers:
HTTP/1.1 429 Too Many Requests
Retry-After: 45
Content-Type: application/json
```

### Prevent Let's Encrypt Abuse
- 5 cert registrations per hour per IP prevents rapid registration spam
- 5 cert operations per 24 hours per domain respects Let's Encrypt's 50/week limit
- Automatic health tracking marks unhealthy IPs

---

## 4. Telegram Notifications

### Overview
Real-time alerts via Telegram for all critical domain and certificate events.

### Files Added/Modified
- `src/services/notificationService.ts` - New Telegram integration service
- `src/services/domainService.ts` - Added notification calls on events
- `src/handlers/domainHandler.ts` - Added rate limit notifications
- `src/index.ts` - Initialize Telegram on startup

### Setup

**Environment Variables:**
```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11  # Bot token from BotFather
TELEGRAM_CHAT_ID=-123456789                                    # Owner's chat ID
```

**How to Get Credentials:**
1. Create bot with @BotFather on Telegram
2. Get bot token (looks like `123456:ABC-DEF...`)
3. Message bot and get your chat ID (negative for groups: `-123456789`)

### Notification Types

#### 1. Certificate Issued
```
✅ Certificate Issued
Domain: example.com
Expires: 2025-12-15
Status: Active and synced to all VPS servers
```

#### 2. Certificate Synced
```
✅ Certificate Synced
Domain: example.com
VPS Servers: 3/3
```

#### 3. Certificate Sync Failed
```
❌ Certificate Sync Failed
Domain: example.com
Error: SSH connection timeout
Action: Check VPS connectivity or try manual resync
```

#### 4. Certificate Expiring Soon
```
⚠️ Certificate Expiring Soon
Domain: example.com
Days Remaining: 14
Action: Certificate will be auto-renewed by certbot
```

#### 5. Certificate Expired
```
🚨 Certificate Expired
Domain: example.com
Action: Manual renewal required - check certbot logs
```

#### 6. Domain Transferred
```
🔄 Domain Transferred
Domain: example.com
Target VPS: vps-us-east-1
Scope: all VPS servers
Status: Certificates synced successfully
```

#### 7. Backup Created
```
💾 Backup Created
Domain: example.com
Backup ID: backup-abc123
Size: 45.23 KB
```

#### 8. Backup Restored
```
↩️ Backup Restored
Domain: example.com
Backup ID: backup-abc123
Status: Certificates synced to all VPS servers
```

#### 9. VPS Status Changed
```
🔔 VPS Status Changed
VPS ID: vps-us-east-1
Status: ❌ Unhealthy
Action: Check VPS connectivity and SSH access
```

#### 10. Rate Limit Exceeded
```
⏸️ Rate Limit Exceeded
Type: domain (example.com)
Identifier: example.com
Action: Wait before retrying
```

### API Functions
```typescript
// Basic notifications
notifyCertIssued(domain, expiry)
notifyCertSynced(domain, vpsCount, successCount)
notifySyncFailed(domain, error)
notifyCertExpiring(domain, daysRemaining)
notifyCertExpired(domain)
notifyDomainTransferred(domain, targetVpsId, allServers)
notifyBackupCreated(domain, backupId, size)
notifyBackupRestored(domain, backupId)
notifyVpsHealthChanged(vpsId, healthy)
notifyRateLimitExceeded(ip, domain?)
notifyMultipleDomainFailures(failures[])

// Admin functions
sendTestNotification()                    // Verify bot is working
getTelegramStatus()                       // Check if notifications are enabled
initTelegram(botToken?, chatId?)          // Manual initialization
```

### HTML Formatting
Messages use HTML formatting for better readability:
- `<b>Bold text</b>` for headers
- `<code>Monospace</code>` for IDs and domains
- Emoji icons for status visualization

### Failure Handling
- Failed Telegram API calls are logged but don't break application
- Notifications are fire-and-forget (don't block operations)
- Graceful degradation if bot token is invalid

---

## Integration Overview

### Event Flow
```
Domain Operation (register/sync/transfer/backup)
    ↓
domainService function completes
    ↓
Calls notificationService function
    ↓
Async HTTP POST to Telegram API
    ↓
Chat message sent (doesn't block operation)
```

### Key Files Overview
```
src/
├── services/
│   ├── domainService.ts       (Updated: +90 lines for notifications)
│   └── notificationService.ts (NEW: 280 lines, Telegram integration)
├── handlers/
│   └── domainHandler.ts       (Updated: +100 lines, transfer/backup/rate-limit handlers)
├── utils/
│   ├── backupUtils.ts         (NEW: 160 lines, backup/restore logic)
│   └── rateLimiter.ts         (NEW: 170 lines, rate limiting)
└── index.ts                   (Updated: +30 lines, init & cleanup)
```

### Total Lines Added
- `notificationService.ts`: 280 lines
- `backupUtils.ts`: 160 lines
- `rateLimiter.ts`: 170 lines
- `domainService.ts`: +90 lines
- `domainHandler.ts`: +100 lines
- `index.ts`: +30 lines
- **Total: ~830 new lines of code**

---

## Configuration

### Environment Variables
```bash
# Existing
VPS_HOST=your-vps.com
VPS_USER=root
VPS_PORT=22
NGINX_PATH=/etc/nginx/sites-available
BASE_DOMAIN=tunnel.example.com
API_KEY=your-secret-key
PORT=3000

# New for Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_ID=-123456789

# Optional for backups
BACKUP_DIR=./data/cert-backups
```

### Rate Limit Customization
Edit `src/utils/rateLimiter.ts`:
```typescript
const DOMAIN_REGISTER_LIMIT = {
  windowMs: 60 * 60 * 1000,    // 1 hour
  maxRequestsPerWindow: 5,      // Max 5 per window
};

const DOMAIN_CERT_LIMIT = {
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  maxRequestsPerWindow: 5,       // Max 5 per day per domain
};
```

---

## Testing

### Test Telegram Connection
```bash
curl -X GET http://localhost:3000/health \
  -H "Authorization: Bearer your-api-key"

# Check logs for "✅ Telegram notifications enabled"
```

### Test Rate Limiting
```bash
# First 5 registrations succeed
for i in {1..5}; do
  curl -X POST http://localhost:3000/domains \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer your-api-key" \
    -d "{\"domain\": \"test$i.com\", \"certbotEmail\": \"admin@test.com\"}"
done

# 6th request gets 429 Too Many Requests
curl -X POST http://localhost:3000/domains \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"domain": "test6.com", "certbotEmail": "admin@test.com"}'

# Response: 429 Retry-After: 3599
```

### Test Backup/Restore
```bash
# Create backup
curl -X POST http://localhost:3000/domains/example.com/backup \
  -H "Authorization: Bearer your-api-key"

# List backups
curl http://localhost:3000/domains/example.com/backup \
  -H "Authorization: Bearer your-api-key"

# Restore from backup
curl -X POST http://localhost:3000/domains/example.com/backups/{backupId}/restore \
  -H "Authorization: Bearer your-api-key"
```

### Test Domain Transfer
```bash
curl -X POST http://localhost:3000/domains/example.com/transfer \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "targetVpsId": "vps-new-id",
    "includeOtherServers": true
  }'
```

---

## Performance Considerations

### Rate Limiter
- O(1) lookups using Map
- Memory: ~200 bytes per active entry
- Cleanup: Every 10 minutes removes expired entries
- Suitable for 10,000+ concurrent rate limits

### Backup Storage
- File-based storage (not database)
- Each backup is separate directory
- Auto-cleanup keeps only last N backups
- Suitable for small cert files (~50KB each)

### Telegram API
- Async notifications (non-blocking)
- 30-second timeout per request
- Failed sends don't interrupt operations
- Rate limited by Telegram: ~30 messages/second

### Database Writes
- Notifications don't add DB queries
- Rate limiter is in-memory only
- Backups create filesystem entries only

---

## Security Considerations

### Rate Limiting
- Prevents bot spam registrations
- Respects Let's Encrypt rate limits
- Tracks by IP (forwarded headers supported)
- 1-hour and 24-hour windows prevent abuse

### Backup Security
- Backups stored locally in `./data/cert-backups/`
- No encryption (use filesystem permissions)
- Recommend: `chmod 700 data/cert-backups/`
- Contains private key material

### Telegram Security
- Bot token in environment variable only
- Chat ID validates recipient
- Use HTTPS for telegram.org API calls
- Messages don't contain sensitive keys

### Rate Limit Bypass
- Cannot be bypassed (in-memory, per-IP)
- Proxy IP detection via X-Forwarded-For
- Admin can reset limits manually (future feature)

---

## Future Enhancements

1. **Webhook Delivery** - Post events to custom webhooks
2. **Email Alerts** - SendGrid/SMTP for non-Telegram users
3. **Dashboard** - Web UI to view all notifications
4. **Notification History** - Store notification logs in MongoDB
5. **Selective Alerts** - Choose which events trigger notifications
6. **Multiple Channels** - Telegram group + private chat
7. **Rate Limit Reset API** - Admin endpoint to reset limits
8. **Backup Encryption** - OpenSSL encryption for backups
9. **Scheduled Backups** - Automatic backup creation daily/weekly
10. **Certificate Analytics** - Track cert expiry trends

---

## Troubleshooting

### Telegram Not Sending
```
Check: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
Logs: "⚠️ Telegram notifications disabled"
```

### Rate Limit Too Strict
```
Edit src/utils/rateLimiter.ts:
- Increase maxRequestsPerWindow
- Increase windowMs (time window)
Restart server
```

### Backups Accumulating
```
Call: domainService.cleanupOldBackups('example.com', 5)
- Keeps last 5 backups per domain
- Deletes older ones
```

### High Memory (Rate Limiter)
```
Reduce cleanup interval in index.ts:
setInterval(() => cleanupExpiredLimits(), 5 * 60 * 1000)
// Change 10 minutes to 5 minutes
```

---

## Changelog

### Version 2.1.0 - Advanced Features Release

**Added:**
- Domain transfer between VPS servers/regions
- Certificate backup and restore functionality
- Rate limiting (per-IP and per-domain)
- Telegram notifications for all critical events
- Automatic rate limit cleanup
- Backup metadata tracking
- VPS health notifications

**Modified:**
- `domainService.ts` - Added transfer, backup, restore functions
- `domainHandler.ts` - Added new endpoints and rate checks
- `index.ts` - Initialize Telegram, cleanup intervals
- `README.md` - Updated API documentation

**New Files:**
- `src/services/notificationService.ts` - Telegram integration
- `src/utils/backupUtils.ts` - Backup/restore utilities
- `src/utils/rateLimiter.ts` - Rate limiting implementation

---

## Summary

All 4 features are production-ready:
✅ Domain Transfer - Manage multi-region deployments
✅ Cert Backup/Restore - Disaster recovery
✅ Rate Limiting - Prevent abuse
✅ Telegram Alerts - Real-time monitoring

Total implementation: ~830 lines of code, fully integrated with existing architecture.
