# Multi-Server Deployment Guide

This document provides comprehensive guidance for deploying jrok across multiple VPS servers for high availability, load distribution, and horizontal scaling.

## Distributed Architecture Overview

jrok now supports fully distributed multi-server deployments using MongoDB for shared state:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Load Balancer                            │
│              (Nginx with consistent hashing)                    │
└───────────────┬─────────────────────────────────────┬───────────┘
                │                                     │
    ┌───────────▼───────────┐           ┌─────────────▼───────────┐
    │     Server 1          │           │      Server 2           │
    │  ┌─────────────────┐  │           │  ┌─────────────────┐    │
    │  │ Agent WebSockets│  │           │  │ Agent WebSockets│    │
    │  │ (Local Sockets) │  │           │  │ (Local Sockets) │    │
    │  └─────────────────┘  │           │  └─────────────────┘    │
    │  ┌─────────────────┐  │           │  ┌─────────────────┐    │
    │  │  TCP Tunnels    │  │           │  │  TCP Tunnels    │    │
    │  │ (Port 10000-    │  │           │  │ (Port 15000-    │    │
    │  │     14999)      │  │           │  │     20000)      │    │
    │  └─────────────────┘  │           │  └─────────────────┘    │
    └───────────┬───────────┘           └─────────────┬───────────┘
                │                                     │
                └──────────────┬──────────────────────┘
                               │
              ┌────────────────▼────────────────────┐
              │           MongoDB Cluster           │
              │  ┌───────────────────────────────┐  │
              │  │ • agentConnections            │  │
              │  │ • tcpPortAllocations          │  │
              │  │ • rateLimits                  │  │
              │  │ • serverHeartbeats            │  │
              │  │ • bandwidthUsage              │  │
              │  │ • tunnels, users, etc.        │  │
              │  └───────────────────────────────┘  │
              └────────────────────────────────────┘
```

## Distributed State Components

### 1. Agent Connection Registry (`agentConnections` collection)
- Tracks which server hosts each agent WebSocket
- Enables cross-server request routing
- Auto-expires via TTL (2 minutes without heartbeat)

### 2. TCP Port Allocations (`tcpPortAllocations` collection)
- Distributed port allocation with per-server ranges
- Prevents port conflicts across servers
- Tracks tunnel-to-port mappings globally

### 3. Rate Limiting (`rateLimits` collection)
- Sliding window counters in MongoDB
- Shared rate limits across all servers
- Auto-cleanup via TTL indexes

### 4. Server Health (`serverHeartbeats` collection)
- Server heartbeats every 10 seconds
- Health status and metrics
- Used for cross-server request routing decisions

### 5. Bandwidth Tracking (`bandwidthUsage` collection)
- Per-tunnel and per-organization bandwidth
- Monthly aggregates for billing/limits

## Setup Guide

### Step 1: MongoDB Setup

Deploy a MongoDB replica set for high availability:

```yaml
# docker-compose.mongodb.yml
version: '3.8'
services:
  mongo1:
    image: mongo:7
    command: mongod --replSet rs0 --bind_ip_all
    ports:
      - "27017:27017"
    volumes:
      - mongo1_data:/data/db

  mongo2:
    image: mongo:7
    command: mongod --replSet rs0 --bind_ip_all
    ports:
      - "27018:27017"
    volumes:
      - mongo2_data:/data/db

  mongo3:
    image: mongo:7
    command: mongod --replSet rs0 --bind_ip_all
    ports:
      - "27019:27017"
    volumes:
      - mongo3_data:/data/db

volumes:
  mongo1_data:
  mongo2_data:
  mongo3_data:
```

Initialize replica set:
```javascript
rs.initiate({
  _id: "rs0",
  members: [
    { _id: 0, host: "mongo1:27017" },
    { _id: 1, host: "mongo2:27017" },
    { _id: 2, host: "mongo3:27017" }
  ]
})
```

### Step 2: Server Configuration

Each jrok server needs unique identification:

```bash
# Server 1 environment
export VPS_ID="vps-001"
export VPS_HOST="server1.example.com"
export VPS_REGION="us-east"
export TCP_PORT_MIN="10000"
export TCP_PORT_MAX="14999"
export MONGODB_URI="mongodb://mongo1:27017,mongo2:27017,mongo3:27017/jrok?replicaSet=rs0"

# Server 2 environment
export VPS_ID="vps-002"
export VPS_HOST="server2.example.com"
export VPS_REGION="us-west"
export TCP_PORT_MIN="15000"
export TCP_PORT_MAX="20000"
export MONGODB_URI="mongodb://mongo1:27017,mongo2:27017,mongo3:27017/jrok?replicaSet=rs0"
```

### Step 3: Load Balancer Configuration

Use nginx with consistent hashing on subdomain:

```nginx
# /etc/nginx/nginx.conf
http {
    # Extract subdomain for consistent hashing
    map $host $subdomain {
        default "";
        "~^(?<sub>[^.]+)\.tunnel\.example\.com$" $sub;
    }

    upstream jrok_cluster {
        hash $subdomain consistent;
        server server1.example.com:3000 weight=5;
        server server2.example.com:3000 weight=5;
        
        keepalive 32;
    }

    server {
        listen 80;
        listen 443 ssl http2;
        server_name *.tunnel.example.com;

        ssl_certificate /etc/letsencrypt/live/tunnel.example.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/tunnel.example.com/privkey.pem;

        location / {
            proxy_pass http://jrok_cluster;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            proxy_connect_timeout 60s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
        }
    }
}
```

### Step 4: Ansible Deployment

```ini
# ansible/inventory.ini
[jrok_servers]
server1 ansible_host=10.0.0.1 vps_id=vps-001 vps_region=us-east tcp_port_min=10000 tcp_port_max=14999
server2 ansible_host=10.0.0.2 vps_id=vps-002 vps_region=us-west tcp_port_min=15000 tcp_port_max=20000
server3 ansible_host=10.0.0.3 vps_id=vps-003 vps_region=eu-west tcp_port_min=20001 tcp_port_max=25000

[jrok_servers:vars]
ansible_user=root
mongodb_uri=mongodb://mongo1:27017,mongo2:27017,mongo3:27017/jrok?replicaSet=rs0
base_domain=tunnel.example.com
```

Deploy:
```bash
ansible-playbook -i inventory.ini playbook.yml
```

## Cross-Server Request Routing

When an HTTP request arrives for a tunnel, jrok automatically:

1. **Checks local agents first** - If agent is on this server, handle locally
2. **Queries MongoDB** - Find which server hosts the agent
3. **Forwards if needed** - Proxy request to correct server

```typescript
// Automatic cross-server routing in index.ts
const routeResult = await crossServerService.findServerForDomain(subdomain);

if (!routeResult.isLocal && routeResult.targetServer) {
  // Forward to correct server
  return crossServerService.forwardRequest(
    routeResult.targetServer,
    req,
    url.pathname + url.search
  );
}

// Handle locally
const agent = await agentService.getAgentByDomainAsync(subdomain);
```

## High Availability Features

### Automatic Failover
- Server heartbeats detect failures within 30 seconds
- TTL indexes auto-clean stale agent registrations
- Nginx removes unhealthy backends

### Graceful Shutdown
```typescript
// On SIGINT, server:
// 1. Stops accepting new connections
// 2. Marks itself unhealthy in MongoDB
// 3. Cleans up TCP ports
// 4. Closes database connections
```

### Agent Reconnection
- CLI automatically reconnects on disconnect
- New connections may hit different server
- Agent state migrates to new server

## Monitoring

### Cluster Stats Endpoint
```bash
curl https://api.example.com/cluster/stats
```
Returns:
```json
{
  "totalServers": 3,
  "healthyServers": 3,
  "totalAgents": 150,
  "totalTunnels": 145,
  "serverDetails": [
    {
      "serverId": "vps-001",
      "serverHost": "server1.example.com",
      "agentCount": 52,
      "tunnelCount": 50,
      "memoryUsage": 45.2,
      "healthy": true
    }
  ]
}
```

### Per-Server Health
```bash
curl https://server1.example.com:3000/health
```

### Prometheus Metrics
- `jrok_agents_connected{server="vps-001"}` - Connected agents per server
- `jrok_tunnels_active{server="vps-001"}` - Active tunnels per server
- `jrok_tcp_ports_used{server="vps-001"}` - TCP ports in use
- `jrok_requests_total{server="vps-001"}` - Request count
- `jrok_bandwidth_bytes{server="vps-001"}` - Bandwidth usage

## Security Considerations

### MongoDB Security
- Enable authentication
- Use TLS for connections
- Restrict network access

```bash
export MONGODB_URI="mongodb://user:password@mongo1:27017,mongo2:27017/jrok?replicaSet=rs0&tls=true"
```

### Inter-Server Communication
- Cross-server requests use internal network
- Add authentication headers for forwarded requests
- Consider mTLS for server-to-server traffic

### Rate Limiting
- Distributed rate limits prevent bypass via different servers
- Per-IP, per-domain, and per-organization limits
- Automatic blocking for abuse patterns

## Scaling Guidelines

### Vertical Scaling (per server)
- CPU: 2-4 cores recommended
- RAM: 2-4GB minimum
- Network: 1Gbps recommended

### Horizontal Scaling (add servers)
1. Add new server to MongoDB and nginx config
2. Deploy jrok with unique VPS_ID and TCP port range
3. Update DNS if using round-robin
4. Traffic automatically balances

### Capacity Planning
- ~1000 agents per server (depends on activity)
- ~500 concurrent HTTP connections per GB RAM
- TCP ports: plan for max expected concurrent tunnels

## Troubleshooting

### Agent Not Found
```
No active agent found for domain: myapp
```
**Causes:**
- Agent not connected to any server
- Agent connected but MongoDB not updated
- Cross-server routing failed

**Debug:**
```bash
# Check agent in MongoDB
db.agentConnections.findOne({ domain: "myapp" })

# Check server heartbeats
db.serverHeartbeats.find({}).sort({ lastHeartbeat: -1 })
```

### Cross-Server Routing Failures
```
Server unavailable - Failed to route request to target server
```
**Causes:**
- Target server is down
- Network connectivity issues
- Firewall blocking inter-server traffic

**Fix:**
- Check target server health
- Verify internal network connectivity
- Check firewall rules (port 3000)

### TCP Port Conflicts
```
Failed to allocate TCP port
```
**Causes:**
- Port range exhausted
- Overlapping port ranges between servers

**Fix:**
- Ensure non-overlapping port ranges
- Clean up stale allocations:
  ```bash
  db.tcpPortAllocations.deleteMany({ active: false })
  ```

## Custom Domain Certificate Synchronization

### How It Works

Custom domain certificates are automatically synchronized across all servers using MongoDB:

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Certificate Sync Architecture                        │
└──────────────────────────────────────────────────────────────────────┘

   User requests custom domain       Leader server issues certificate
           │                                    │
           ▼                                    ▼
   ┌───────────────┐               ┌─────────────────────────┐
   │  API Server   │               │  Certbot + Cloudflare   │
   │  (any server) │               │  DNS Challenge          │
   └───────┬───────┘               └───────────┬─────────────┘
           │                                   │
           ▼                                   ▼
   ┌───────────────┐               ┌─────────────────────────┐
   │    MongoDB    │◄──────────────│  Upload cert to MongoDB │
   │ certificates  │               │  (base64 encoded)       │
   │   collection  │               └─────────────────────────┘
   └───────┬───────┘
           │
     ┌─────┴─────┬─────────────┐
     ▼           ▼             ▼
┌─────────┐ ┌─────────┐   ┌─────────┐
│ Server1 │ │ Server2 │   │ Server3 │
│  pulls  │ │  pulls  │   │  pulls  │
│  certs  │ │  certs  │   │  certs  │
└─────────┘ └─────────┘   └─────────┘
```

### MongoDB Collections

**`certificates`** - Stores certificate data:
```javascript
{
  domain: "example.com",
  cert: "base64...",       // cert.pem
  chain: "base64...",      // chain.pem
  fullchain: "base64...",  // fullchain.pem
  privkey: "base64...",    // privkey.pem
  expiry: ISODate("..."),
  status: "valid",
  version: 1,
  uploadedAt: ISODate("..."),
  uploadedBy: "server-1"
}
```

**`cert_sync_queue`** - Notification queue for new certs:
```javascript
{
  _id: "example.com-1",
  domain: "example.com",
  version: 1,
  createdAt: ISODate("..."),
  processed: false
}
```

**`leader_leases`** - Leader election for cert renewal:
```javascript
{
  leaderId: "server-1",
  leaseExpiry: ISODate("..."),  // 30-second lease
  acquiredAt: ISODate("...")
}
```

### Certificate Sync API Endpoints

All servers expose these endpoints for certificate management:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/certificates/download/:domain` | GET | Download certificate from MongoDB |
| `/certificates/list` | GET | List all certificates |
| `/certificates/status/:domain` | GET | Get certificate status |
| `/certificates/sync-queue` | GET | Check pending sync items |
| `/certificates/sync-queue/:id` | POST | Mark sync as processed |

### Automatic Sync Process

1. **Certificate Issuance** (on leader server):
   - Leader acquires lease via `attemptBecomeLeader()`
   - Certbot issues certificate via DNS challenge
   - Certificate uploaded to MongoDB
   - Sync notification added to queue

2. **Certificate Pull** (all servers, every 5 minutes):
   - Check `cert_sync_queue` for new certificates
   - Download from MongoDB via API
   - Write to local `/etc/letsencrypt/live/{domain}/`
   - Set proper permissions (600 for privkey)

3. **Certificate Renewal** (leader only):
   - Certbot renewal hook triggers
   - New version uploaded to MongoDB
   - Other servers pull on next sync cycle

### Manual Certificate Operations

**List all certificates:**
```bash
curl -H "Authorization: Bearer $API_KEY" \
  https://tunnel.example.com/certificates/list
```

**Check certificate status:**
```bash
curl -H "Authorization: Bearer $API_KEY" \
  https://tunnel.example.com/certificates/status/mycustom.domain.com
```

**Force certificate resync:**
```bash
curl -X POST -H "Authorization: Bearer $API_KEY" \
  https://tunnel.example.com/domains/mycustom.domain.com/resync
```

### Troubleshooting Certificate Sync

**Certificate not syncing:**
```bash
# Check MongoDB certificate collection
mongosh --eval 'db.certificates.find({ domain: "example.com" })'

# Check sync queue
mongosh --eval 'db.cert_sync_queue.find({ processed: false })'

# Check server logs
journalctl -u jrok | grep -i cert
```

**Leader election issues:**
```bash
# Check current leader
mongosh --eval 'db.leader_leases.find()'

# Force leader release (use with caution)
mongosh --eval 'db.leader_leases.deleteMany({})'
```

## Environment Variables Reference

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `VPS_ID` | Unique server identifier | hostname | Yes |
| `VPS_HOST` | Public hostname/IP | localhost | Yes |
| `VPS_REGION` | Geographic region | default | No |
| `TCP_PORT_MIN` | Start of TCP port range | 10000 | Yes |
| `TCP_PORT_MAX` | End of TCP port range | 20000 | Yes |
| `MONGODB_URI` | MongoDB connection string | mongodb://localhost:27017/jrok | Yes |
| `PORT` | HTTP server port | 3000 | No |
| `BASE_DOMAIN` | Tunnel base domain | tunnel.example.com | Yes |
| `SERVER_ID` | Server identifier for cert sync | VPS_ID | No |
| `CERT_SYNC_API_KEY` | API key for cert sync endpoints | API_KEY | No |
