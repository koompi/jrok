# jrok Client - Quick Reference

## Installation

```bash
# Already in your project
cd jrok
bun client.ts --help
```

## Basic Commands

### Connect a Service
```bash
# Local port
bun client.ts connect --server https://reverse.example.com --domain app.example.com --port 3000 --auth $KEY

# Docker Swarm service
bun client.ts connect --server https://reverse.example.com --domain web.example.com --docker-service my-app --auth $KEY

# Kubernetes service
bun client.ts connect --server https://reverse.example.com --domain api.example.com --k8s-service api:8080 --auth $KEY
```

### List Services
```bash
bun client.ts list --server https://reverse.example.com --auth $KEY
```

### Disconnect Service
```bash
bun client.ts disconnect --server https://reverse.example.com --domain app.example.com --auth $KEY
```

## One-Liners for Common Scenarios

### 1. Quick Local Dev Server Exposure
```bash
export JROK_URL="https://reverse.example.com" && \
export JROK_KEY="your-api-key" && \
bun client.ts connect \
  --server $JROK_URL \
  --domain dev.example.com \
  --port 3000 \
  --auth $JROK_KEY
```

### 2. Docker Swarm with HAProxy Load Balancer
```bash
# Deploy HAProxy (if not done)
docker service create --name haproxy-lb -p 8080:8080 haproxy:2.8

# Deploy app with replicas
docker service create --name web-app --replicas 3 your-app:latest

# Expose
bun client.ts connect \
  --server https://reverse.example.com \
  --domain web.example.com \
  --docker-service haproxy-lb \
  --auth your-api-key
```

### 3. Kubernetes Service Exposure
```bash
# Deploy app
kubectl apply -f deployment.yaml
kubectl expose deployment my-app --port=8080 --type=ClusterIP

# Expose
bun client.ts connect \
  --server https://reverse.example.com \
  --domain app.example.com \
  --k8s-service my-app:8080 \
  --auth your-api-key
```

### 4. Multiple Services at Once
```bash
#!/bin/bash

API_KEY="your-api-key"
SERVER="https://reverse.example.com"

# Start multiple connections in background
bun client.ts connect --server $SERVER --domain web.example.com --docker-service web-app --auth $API_KEY &
bun client.ts connect --server $SERVER --domain api.example.com --docker-service api-app --auth $API_KEY &
bun client.ts connect --server $SERVER --domain cache.example.com --port 6379 --auth $API_KEY &

wait
```

### 5. With Environment File
```bash
# Create .env
cat > .env <<EOF
JROK_SERVER=https://reverse.example.com
JROK_AUTH=your-api-key
JROK_DOMAIN=myapp.example.com
JROK_PORT=3000
EOF

# Load and run
source .env && bun client.ts connect
```

### 6. Docker Compose Service
```yaml
# docker-compose.yml
version: '3.8'
services:
  web:
    image: my-app:latest
    ports:
      - "3000:3000"
  
  agent:
    image: oven/bun:latest
    volumes:
      - ./client.ts:/app/client.ts
    environment:
      JROK_SERVER: https://reverse.example.com
      JROK_AUTH: your-api-key
      JROK_DOMAIN: app.example.com
      JROK_PORT: 3000
    command: bun /app/client.ts connect
    depends_on:
      - web
```

### 7. Systemd Auto-Start (Production)
```bash
# Create service file
sudo tee /etc/systemd/system/jrok-agent.service > /dev/null <<EOF
[Unit]
Description=Jrok Agent
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/jrok
EnvironmentFile=/home/ubuntu/.jrok.env
ExecStart=/usr/bin/bun client.ts connect
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Create env file
cat > /home/ubuntu/.jrok.env <<EOF
JROK_SERVER=https://reverse.example.com
JROK_AUTH=your-api-key
JROK_DOMAIN=myapp.example.com
JROK_DOCKER_SERVICE=my-docker-service
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable jrok-agent
sudo systemctl start jrok-agent
sudo systemctl status jrok-agent
```

## Architecture Diagram

```
Your Network (Private)          Public Cloud (jrok)
┌──────────────────────────┐   ┌──────────────────────────┐
│                          │   │                          │
│  Your Service            │   │  jrok             │
│  (Docker/K8s/Port)       │   │  (HTTPS Proxy)           │
│         │                │   │         │                │
│  Docker Swarm            │   │   ┌─────┴─────┐          │
│  ├─ web-app (3 replicas) │   │   │           │          │
│  ├─ api-app (2 replicas) │   │   │           │          │
│  └─ cache (1 replica)    │   │   │           │          │
│         │                │   │   │           │          │
│  ┌──────┴──────┐         │   │   │           │          │
│  │   HAProxy   │         │   │   │           │          │
│  │  :8080 LB   │         │   │   │           │          │
│  └──────┬──────┘         │   │   │           │          │
│         │                │   │   │           │          │
│  ┌──────┴────────────────┼───┼───┤ Agent     │          │
│  │  Agent Client         │   │   │ WebSocket │          │
│  │  (WebSocket)          │   │   │           │          │
│  └──────────────────────┼───┼───┤           │          │
│                         │   │   │           │          │
└─────────────────────────┼───┼───┼─────────────┼──────────┘
                          │   │   │           │
                    (Tunnel)  │   │     ┌─────┴─────┐
                              │   │     │           │
                              └─────┬───┤ DNS:      │
                                    │   │ domain... │
                                    │   │           │
                                    │   └───────────┘
                                    │
                          Users can access:
                          https://api.example.com
                          https://web.example.com
                          https://cache.example.com
```

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| "Connection refused" | Check `--server` URL is correct and server is running |
| "Auth failed" | Verify API key with `--auth` flag |
| "Service not found" | Check Docker service exists: `docker service ls` |
| "502 Bad Gateway" | Ensure local service is running: `curl localhost:3000` |
| "Keeps reconnecting" | May be network issue, check server logs |

## Environment Variables

```bash
JROK_SERVER      # Server URL (https://...)
JROK_AUTH        # API token (sk-...)
JROK_DOMAIN      # Domain name (app.example.com)
JROK_PORT        # Local port (3000)
JROK_HOST        # Local host (localhost)
JROK_SERVICE     # Service name (for Docker/K8s)
```

## Monitoring

### View Logs
```bash
# If running as systemd service
sudo journalctl -u jrok-agent -f

# If running in docker-compose
docker-compose logs -f agent

# If running in background
ps aux | grep "client.ts"
```

### Check Service Status
```bash
bun client.ts list --server https://reverse.example.com --auth $KEY
```

### Verify Public Access
```bash
curl -v https://myapp.example.com

# Should show 200 OK and be forwarded to your local service
```

## Tips & Tricks

### Run Multiple Agents
```bash
# Each service gets its own agent process
bun client.ts connect --domain api.example.com --port 8080 --auth $KEY &
bun client.ts connect --domain web.example.com --docker-service web --auth $KEY &
bun client.ts connect --domain db.example.com --port 5432 --auth $KEY &

# All run in background, auto-reconnect if network fails
```

### Load Balancing Multiple Replicas
```bash
# Docker automatically distributes across replicas
docker service create --name api --replicas 5 my-api:latest

# Client connects to load balancer (or service directly)
bun client.ts connect --docker-service api --domain api.example.com --auth $KEY
```

### Automatic Failover
```bash
# Agent automatically reconnects if connection drops
# Uses exponential backoff (5s, 10s, 15s, ... max 30s)
# Your service stays offline until reconnection

# Monitor with:
journalctl -u jrok-agent -f
```

## Useful Commands

### List all Docker services
```bash
docker service ls
docker service ps SERVICE_NAME  # See replicas
```

### List all Kubernetes services
```bash
kubectl get svc
kubectl describe svc SERVICE_NAME
```

### Test local service
```bash
curl http://localhost:3000
curl http://localhost:8080

# Or with specific header
curl -H "Host: api.example.com" http://localhost:3000
```

### Get jrok server status
```bash
curl https://reverse.example.com/health
```

---

**For complete guide, see: CLIENT_GUIDE.md**
