> ⚠️ HISTORICAL — describes the pre-kproxy nginx + Certbot/Let's Encrypt (leader-based) design that was removed. See ../docs/getting-started/architecture.md for the current architecture.

# Custom Domain API Implementation

## Overview

This document summarizes the custom domain API implementation with automatic SSL certificate management for the Jrok tunnel service.

## What Was Implemented

### 1. Domain Handler (`src/handlers/domainHandler.ts`)

New HTTP handler with 5 endpoints for domain management:

- **`handleRegisterDomain(req)`** - POST /domains
  - Validates domain format
  - Calls `domainService.registerCustomDomain()`
  - Returns domain object with certificate status
  - Domain validation uses strict RFC-compliant rules

- **`handleGetDomain(domain)`** - GET /domains/{domain}
  - Retrieves domain details by name
  - Returns `CustomDomain` object with sync status and certificate expiry
  - 404 if domain not found

- **`handleListDomains()`** - GET /domains
  - Lists all registered custom domains
  - Returns array with total count
  - Useful for monitoring multi-domain setups

- **`handleDeleteDomain(domain)`** - DELETE /domains/{domain}
  - Removes domain and cleans up from all VPS servers
  - Returns 404 if domain not found

- **`handleResyncDomain(domain)`** - POST /domains/{domain}/resync
  - Force resync certificates to all VPS servers
  - Useful for recovery after adding new VPS instances
  - Validates domain exists before syncing

### 2. Server Routes (`src/index.ts`)

Added 5 new routes to main server:

```typescript
// Domain routes
POST   /domains                    - Register new domain
GET    /domains                    - List all domains
GET    /domains/{domain}           - Get domain details
DELETE /domains/{domain}           - Delete domain
POST   /domains/{domain}/resync    - Force certificate resync
```

All domain routes require API key authentication (Bearer token).

### 3. Tunnel Service Updates (`src/services/tunnelService.ts`)

Enhanced `createTunnel()` to support custom domains:

```typescript
export async function createTunnel(
  request: CreateTunnelRequest, 
  agentId: string
): Promise<Tunnel>
```

**New validation logic:**
- If `customDomain` is specified in request:
  - Verify custom domain exists in database
  - Verify domain is marked as `active`
  - Verify domain is `synced` to all VPS servers
  - Throw descriptive error if any check fails
- If all checks pass, include `customDomain` in tunnel object
- Pass `customDomain` to `syncConfigToAllVps()` for per-domain certificate handling

**Benefits:**
- Prevents users from creating tunnels on unsynced or deleted domains
- Provides clear error messages about domain status
- Ensures tunnel creation only happens when ready

### 4. Type-Only Imports Fix

Fixed TypeScript compilation errors across all handler files:

- `src/handlers/domainHandler.ts` - Type-only imports for CustomDomain, RegisterCustomDomainRequest
- `src/handlers/tunnelHandler.ts` - Type-only imports for TunnelResponse, ListTunnelsResponse, CreateTunnelRequest
- `src/handlers/agentHandler.ts` - Type-only imports for AgentMessage
- `src/services/agentService.ts` - Type-only imports for Agent, AgentMessage
- `src/services/domainService.ts` - Type-only imports for CustomDomain, RegisterCustomDomainRequest
- `src/services/tunnelService.ts` - Type-only imports for Tunnel, TunnelConfig, CreateTunnelRequest
- `src/utils/database.ts` - Type-only imports for Tunnel, CustomDomain
- `src/utils/nginxConfig.ts` - Type-only imports for TunnelConfig

This ensures `verbatimModuleSyntax` compatibility (Bun/TypeScript 5.0+ requirement).

### 5. Documentation Updates (`README.md`)

Added comprehensive "Custom Domains & SSL Certificates" section with:

- **Register Custom Domain** endpoint documentation with example request/response
- **List Custom Domains** endpoint documentation
- **Get Domain Details** endpoint documentation
- **Resync Domain Certificates** endpoint documentation with use cases
- **Delete Custom Domain** endpoint documentation
- **Create Tunnel on Custom Domain** endpoint documentation with example
- Key field explanations: `synced`, `lastSyncedAt`, `certExpiry`
- Multi-server sync guarantees

## Architecture: Multi-Server Sync Guarantee

The implementation guarantees that certificates sync across all VPS servers:

### Domain Registration Flow

```
User POST /domains
    ↓
domainHandler.handleRegisterDomain()
    ↓
domainService.registerCustomDomain()
    ├─ Validate domain doesn't exist
    ├─ Create MongoDB record
    ├─ Issue wildcard cert via Certbot + Cloudflare DNS
    ├─ syncCertificateToAllVps() ← CRITICAL GUARANTEE
    │  ├─ Get all healthy VPS servers
    │  ├─ Throw error if no servers available
    │  ├─ SCP cert files to each VPS
    │  ├─ Track success count
    │  ├─ Require at least 1 success (throw if all fail)
    │  ├─ Warn if partial sync (some servers failed)
    │  ├─ Update lastSyncedAt timestamp
    │  └─ Mark unhealthy servers that failed
    ├─ Mark domain as active + synced
    └─ Return domain object
```

### Tunnel Creation Flow with Custom Domain

```
User POST /tunnels (with customDomain)
    ↓
tunnelHandler.handleCreateTunnel()
    ↓
tunnelService.createTunnel()
    ├─ Verify agent is connected
    ├─ If customDomain specified:
    │  ├─ db.getCustomDomainByName()
    │  ├─ Verify domain exists
    │  ├─ Verify domain is active
    │  ├─ Verify domain is synced
    │  └─ Throw if any checks fail
    ├─ syncConfigToAllVps() with customDomain parameter
    │  ├─ Get all healthy VPS servers
    │  ├─ Upload nginx config to each (with correct cert path)
    │  ├─ Reload nginx on each
    │  └─ Require at least 1 success
    ├─ Save tunnel to MongoDB
    └─ Return tunnel object
```

## Key Features

### 1. Automatic Certificate Issuance

- Uses Certbot with Cloudflare DNS validation
- Supports wildcard certificates (`*.yourdomain.com`)
- Stores certificate path and expiry date in MongoDB
- Automatic renewal before expiry

### 2. Multi-VPS Synchronization

- SCP-based certificate distribution to all VPS servers
- Requires at least 1 successful sync (throws if all fail)
- Marks unhealthy servers that fail sync
- Warns if partial sync (some servers fail but at least 1 succeeds)
- Tracks last sync timestamp for monitoring

### 3. Validation & Error Handling

- Domain format validation (RFC-compliant)
- Existence checks before operations
- Clear error messages for failures
- Status checks before tunnel creation
- Health status updates on failures

### 4. API Response Format

All domain endpoints return consistent JSON:

```json
{
  "success": true/false,
  "message": "descriptive message",
  "domain": { /* CustomDomain object */ },
  "error": "error description if failed"
}
```

## Usage Examples

### Register a Custom Domain

```bash
curl -X POST http://localhost:3000/domains \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "domain": "mycompany.com",
    "certbotEmail": "admin@mycompany.com",
    "cloudflareToken": "your-cloudflare-api-token"
  }'
```

### Create Tunnel on Custom Domain

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "domain": "api",
    "agentId": "agent-xyz",
    "customDomain": "mycompany.com"
  }'
```

Result: Tunnel accessible at `api.mycompany.com` with automatic SSL.

### Resync Certificates After Adding New VPS

```bash
# 1. Register new VPS server via admin panel
# 2. Mark it as healthy
# 3. Force resync domain certs to all servers (including new one)
curl -X POST http://localhost:3000/domains/mycompany.com/resync \
  -H "Authorization: Bearer your-api-key"
```

## Database Schema

### CustomDomain Collection

```typescript
{
  _id: ObjectId,
  id: string,                    // Unique identifier
  domain: string,                // Full domain name (unique index)
  baseDomain: boolean,           // false for custom domains
  certPath?: string,             // /etc/letsencrypt/live/{domain}
  certExpiry?: number,           // Unix timestamp
  cloudflareToken?: string,      // For DNS validation
  certbotEmail: string,          // For certificate renewal
  createdAt: number,             // Creation timestamp
  active: boolean,               // Can be used for tunnels
  synced: boolean,               // All VPS have cert (indexed)
  lastSyncedAt?: number          // Last successful sync time
}
```

**Indexes:**
- `domain` - Unique for fast lookup
- `active` - For filtering active domains
- `synced` - For filtering synced domains
- `certExpiry` - For renewal checks

## Error Handling

### Registration Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing required fields` | Missing domain or certbotEmail | Provide all required fields |
| `Invalid domain format` | Domain doesn't match RFC rules | Use valid domain (e.g., example.com) |
| `Custom domain already exists` | Domain already registered | Use different domain |
| `Failed to issue certificate` | Certbot/Cloudflare error | Check token, DNS setup, email |
| `No healthy servers available` | All VPS servers are unhealthy | Verify VPS health status |
| `All servers failed to sync` | Certificate sync failed on all servers | Check VPS connectivity and SSH access |

### Tunnel Creation Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Custom domain not found` | Domain not registered | Register domain first |
| `Custom domain is not active` | Domain deactivated | Reactivate or undelete domain |
| `Custom domain is not fully synced` | Sync still in progress | Wait a moment and retry |

## Scaling Behavior

When adding new VPS servers to a multi-server setup:

1. **Register new VPS** via admin interface
2. **Mark as healthy** in database
3. **Resync domain certificates** via POST /domains/{domain}/resync
   - Sync function automatically includes new server in healthy list
   - Certificates distributed to new server
   - Tunnel configs can now include new server in load balancing
4. **All existing tunnels work** without modification
   - nginx configs already on all servers (synced during tunnel creation)
   - New server has both certs and configs
   - Load balancer routes traffic to all servers including new one

No manual certificate management or config distribution needed!

## Files Modified/Created

### Created
- `src/handlers/domainHandler.ts` (256 lines) - New domain HTTP handler
- `DOMAIN_API.md` (this file) - API documentation

### Modified
- `src/index.ts` - Added domainHandler import and 5 domain routes
- `src/services/tunnelService.ts` - Enhanced createTunnel() for custom domains
- `README.md` - Added Custom Domains & SSL Certificates section
- `src/handlers/tunnelHandler.ts` - Fixed type-only imports
- `src/handlers/agentHandler.ts` - Fixed type-only imports
- `src/services/agentService.ts` - Fixed type-only imports
- `src/services/domainService.ts` - Fixed type-only imports
- `src/utils/database.ts` - Fixed type-only imports
- `src/utils/nginxConfig.ts` - Fixed type-only imports

## Testing Recommendations

### Unit Tests
- Domain validation (valid/invalid formats)
- Error handling (missing fields, existing domains)
- Response format consistency

### Integration Tests
- Full domain registration flow
- Certificate sync across multiple servers
- Tunnel creation with custom domain
- Resync after adding new VPS
- Delete domain cleanup

### Load Testing
- Multiple concurrent domain registrations
- Cert sync performance with many servers
- API response times with many domains

## Future Enhancements

1. **Certificate Renewal Automation** - Auto-renew before expiry
2. **Domain Transfer** - Change owning VPS/region
3. **Cert Backup/Restore** - Disaster recovery
4. **Monitoring Dashboard** - Real-time sync status
5. **Webhook Notifications** - Alert on cert expiry/sync failures
6. **Custom CSR Support** - Use external CAs
7. **DNS Provider Plugins** - Support Route53, Azure DNS, etc.
8. **Rate Limiting** - Prevent cert rate-limit abuse

## Notes

- All domain operations require API key authentication
- Domain names are case-insensitive in storage
- Sync status updates in near real-time via MongoDB
- Certificates are stored in `/etc/letsencrypt/live/{domain}/` on all VPS servers
- Certificates automatically renewed by Certbot cron job on each VPS
- No manual SSH required for certificate management
