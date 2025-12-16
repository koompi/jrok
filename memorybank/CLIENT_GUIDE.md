# jrok Client Guide

Complete guide for exposing local services to the public internet using the jrok agent client.

## Overview

The **jrok Agent Client** connects your local services (Docker, Kubernetes, or plain TCP ports) to the public internet through a secure reverse proxy. This is perfect for:

- ✅ Exposing local development servers
- ✅ Connecting private Docker Swarm clusters to public domains
- ✅ Exposing Kubernetes services without public Ingress
- ✅ Tunneling any TCP service through jrok
- ✅ Multiple replicas with load balancing
- ✅ Automatic SSL/TLS via jrok

## Architecture

```
┌─────────────────────────────────────────────┐
│     Your Private Network (Behind NAT/FW)    │
├─────────────────────────────────────────────┤
│                                             │
│  ┌──────────────────────────────────────┐  │
│  │  Your Services (Docker/K8s/Port)     │  │
│  │                                      │  │
│  │  • Docker Swarm (with HAProxy)       │  │
│  │  • Kubernetes (with Ingress)         │  │
│  │  • Raw TCP Service (port 3000, etc)  │  │
│  │  • Multiple replicas (HA)            │  │
│  └──────────────────────────────────────┘  │
│           ▲                                  │
│           │ (localhost or service DNS)      │
│           │                                  │
│  ┌──────────────────────────────────────┐  │
│  │  jrok Agent Client (this CLI) │  │
│  │                                      │  │
│  │  $ bun client.ts connect \           │  │
│  │      --docker-service web-app \      │  │
│  │      --domain api.example.com        │  │
│  │                                      │  │
│  │  Initiates WebSocket to jrok  │  │
│  └──────────────────────────────────────┘  │
│           │                                  │
│           │ (WebSocket - outbound only)     │
│           ▼                                  │
└─────────────────────────────────────────────┘
           │
           │ (Secure WebSocket Tunnel)
           │
┌─────────────────────────────────────────────┐
│        Public Cloud (jrok)           │
├─────────────────────────────────────────────┤
│                                             │
│  ┌──────────────────────────────────────┐  │
│  │  jrok Server                  │  │
│  │  • HTTPS listener: 443                │  │
│  │  • Handles DNS termination           │  │
│  │  • Proxies traffic back to agent     │  │
│  └──────────────────────────────────────┘  │
│           │                                  │
│  ┌────────┼──────────────────────────────┐  │
│  ▼        ▼                    ▼        ▼  │
│  api.ex  web.ex    my-service.ex  ...     │
│                                             │
└─────────────────────────────────────────────┘
  ▲
  │ Users access https://api.example.com
```

## Installation

```bash
# Clone the project
git clone https://github.com/koompi/jrok
cd jrok

# The client is already created as client.ts
# Just use it with Bun:
bun client.ts --help
```

## Quick Start

### 1. TCP Port Forwarding (Simplest)

Expose a local service running on port 3000:

```bash
bun client.ts connect \
  --server https://reverse.example.com \
  --domain myapp.example.com \
  --port 3000 \
  --auth your-api-key
```

Now `https://myapp.example.com` will forward to `localhost:3000`

### 2. Docker Swarm Service (With Load Balancing)

Expose a Docker Swarm service:

```bash
bun client.ts connect \
  --server https://reverse.example.com \
  --domain web.example.com \
  --docker-service web-app \
  --auth your-api-key
```

This assumes:
- Docker Swarm is running
- `web-app` service is deployed
- HAProxy or load balancer is in front (see setup below)

### 3. Kubernetes Service (With Ingress)

Expose a Kubernetes service:

```bash
bun client.ts connect \
  --server https://reverse.example.com \
  --domain api.example.com \
  --k8s-service api-service:8080 \
  --auth your-api-key
```

### 4. List Connected Services

```bash
bun client.ts list \
  --server https://reverse.example.com \
  --auth your-api-key
```

Output:
```
📋 Connected Services:

Domain                      Type        Target                      Status
──────────────────────────────────────────────────────────────────────────
web.example.com             Docker      web-app:8080                ✅ Online
api.example.com             Kubernetes  api-service:8080            ✅ Online
dev.example.com             Port        localhost:3000              ✅ Online
```

### 5. Disconnect a Service

```bash
bun client.ts disconnect \
  --server https://reverse.example.com \
  --domain web.example.com \
  --auth your-api-key
```

## Advanced Setup: Docker Swarm + HAProxy

This setup exposes a Docker Swarm cluster with multiple replicas behind HAProxy.

### Step 1: Deploy HAProxy in Docker Swarm

```bash
# Create HAProxy configuration
cat > haproxy.cfg <<EOF
global
  log stdout local0
  log stdout local1 notice
  chroot /var/lib/haproxy
  stats socket /run/haproxy/admin.sock mode 660 level admin
  stats timeout 30s
  user haproxy
  group haproxy
  daemon

defaults
  log global
  mode http
  option httplog
  option dontlognull
  timeout connect 5000
  timeout client 50000
  timeout server 50000

frontend fe_main
  bind *:8080
  default_backend be_web

backend be_web
  balance roundrobin
  server web-app-1 tasks.web-app:3000 check
  server web-app-2 tasks.web-app:3000 check
  server web-app-3 tasks.web-app:3000 check
EOF
```

### Step 2: Create HAProxy Service in Docker Swarm

```bash
# Create config
docker config create haproxy-cfg haproxy.cfg

# Deploy HAProxy service
docker service create \
  --name haproxy-lb \
  --publish 8080:8080 \
  --config src=haproxy-cfg,target=/usr/local/etc/haproxy/haproxy.cfg \
  haproxy:2.8
```

### Step 3: Deploy Your Application with Multiple Replicas

```bash
# Deploy web app with 3 replicas
docker service create \
  --name web-app \
  --replicas 3 \
  --publish 3000 \
  your-app-image:latest

# Or update existing service
docker service update \
  --replicas 5 \
  web-app
```

### Step 4: Run the Agent Client

```bash
bun client.ts connect \
  --server https://reverse.example.com \
  --domain web.example.com \
  --docker-service haproxy-lb \
  --auth your-api-key
```

Traffic flow:
```
User → jrok → Agent Client → HAProxy (port 8080) → Web App (3 replicas)
```

## Advanced Setup: Kubernetes + Ingress

### Step 1: Deploy Your Application

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-app
  template:
    metadata:
      labels:
        app: api-app
    spec:
      containers:
      - name: app
        image: your-app:latest
        ports:
        - containerPort: 8080
```

Deploy:
```bash
kubectl apply -f deployment.yaml

# Verify
kubectl get pods -l app=api-app
```

### Step 2: Create Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service
spec:
  selector:
    app: api-app
  type: ClusterIP
  ports:
  - port: 8080
    targetPort: 8080
```

Deploy:
```bash
kubectl apply -f service.yaml

# Verify
kubectl get svc api-service
```

### Step 3: Create Ingress (Optional, for internal routing)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
spec:
  rules:
  - host: api.internal
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 8080
```

### Step 4: Run Agent Client

```bash
bun client.ts connect \
  --server https://reverse.example.com \
  --domain api.example.com \
  --k8s-service api-service:8080 \
  --auth your-api-key
```

Traffic flow:
```
User → jrok → Agent Client → K8s Service → Pods (3 replicas with load balancing)
```

## Environment Variables

For scripts and automation, use environment variables instead of CLI flags:

```bash
export JROK_SERVER=https://reverse.example.com
export JROK_AUTH=your-api-key
export JROK_DOMAIN=myapp.example.com
export JROK_PORT=3000
export JROK_HOST=localhost
export JROK_SERVICE=my-docker-service

# Then just run:
bun client.ts connect
```

`.env` file example:
```bash
# .env
JROK_SERVER=https://reverse.example.com
JROK_AUTH=sk-1234567890
JROK_DOMAIN=api.example.com
JROK_PORT=3000
```

Load with:
```bash
source .env
bun client.ts connect
```

## CLI Commands

### connect
Connect a local service to a public domain.

```bash
bun client.ts connect [OPTIONS]

Options:
  --server <url>              jrok server URL (required)
  --domain <domain>           Public domain name (required)
  --auth <token>              API authentication token (required)
  --port <number>             Local port (for TCP, default: 3000)
  --host <host>               Local host (default: localhost)
  --docker-service <name>     Docker Swarm service name
  --k8s-service <name:port>   Kubernetes service:port
```

### list
List all connected services.

```bash
bun client.ts list [OPTIONS]

Options:
  --server <url>              jrok server URL (required)
  --auth <token>              API authentication token (required)
```

### disconnect
Disconnect a service.

```bash
bun client.ts disconnect [OPTIONS]

Options:
  --server <url>              jrok server URL (required)
  --auth <token>              API authentication token (required)
  --domain <domain>           Domain name to disconnect (required)
```

### help
Show help message.

```bash
bun client.ts help
bun client.ts --help
bun client.ts -h
```

## Use Cases & Examples

### Use Case 1: Local Development Server

Run a development server and expose it publicly:

```bash
# Terminal 1: Start your dev server
npm run dev
# Server running on localhost:3000

# Terminal 2: Expose to public
bun client.ts connect \
  --server https://reverse.example.com \
  --domain dev.example.com \
  --port 3000 \
  --auth your-api-key

# Now you can test on https://dev.example.com
```

### Use Case 2: Docker Swarm Multi-Service Setup

```bash
# Deploy multiple services
docker service create --name web-frontend your-frontend:latest
docker service create --name web-api your-api:latest
docker service create --name web-db your-db:latest

# Deploy HAProxy load balancer
docker service create --name web-lb \
  -p 8080:8080 \
  haproxy:latest

# Expose each service
bun client.ts connect --docker-service web-lb --domain web.example.com --server https://reverse.example.com --auth $KEY
bun client.ts connect --docker-service web-api --domain api.example.com --server https://reverse.example.com --auth $KEY
```

### Use Case 3: Kubernetes Multi-Tier Application

```bash
# Deploy full stack
kubectl apply -f web-frontend/
kubectl apply -f api-backend/
kubectl apply -f database/

# Expose services
bun client.ts connect --k8s-service frontend:3000 --domain web.example.com --server https://reverse.example.com --auth $KEY
bun client.ts connect --k8s-service api:8080 --domain api.example.com --server https://reverse.example.com --auth $KEY
```

### Use Case 4: Webhook for Local Service

Expose local webhook receiver:

```bash
# Terminal 1: Start webhook listener
bun webhook-listener.ts --port 9000

# Terminal 2: Expose to internet
bun client.ts connect \
  --server https://reverse.example.com \
  --domain webhooks.example.com \
  --port 9000 \
  --auth your-api-key

# Now GitHub, Stripe, etc can send webhooks to:
# https://webhooks.example.com/github
# https://webhooks.example.com/stripe
```

### Use Case 5: Multiple Instances with Load Balancing

```bash
# Deploy HAProxy with backend pool
docker service create \
  --name load-balancer \
  -p 8080:8080 \
  haproxy:latest

# Deploy multiple app instances
docker service create \
  --name api-backend \
  --replicas 5 \
  your-api:latest

# Expose the load balancer
bun client.ts connect \
  --server https://reverse.example.com \
  --domain api.example.com \
  --docker-service load-balancer \
  --auth your-api-key

# Incoming requests:
# https://api.example.com → load-balancer (8080) → api-backend (5 replicas, round-robin)
```

## Troubleshooting

### Connection Refused

**Error**: `Connection refused connecting to https://reverse.example.com`

**Solutions**:
1. Check server URL is correct
2. Check server is running
3. Check firewall/network allows outbound WebSocket connections
4. Try with `--server http://...` first (for testing)

### Authentication Failed

**Error**: `Auth failed: Invalid token`

**Solutions**:
1. Check `--auth` token matches server configuration
2. Check token hasn't expired
3. Verify token format (usually starts with `sk-`)

### Service Not Accessible

**Error**: `Connection OK but domain returns 502 Bad Gateway`

**Solutions**:
1. Check local service is running: `curl localhost:3000`
2. Check correct port is specified: `--port 3000`
3. Check Docker service is running: `docker service ls`
4. Check Kubernetes service exists: `kubectl get svc`

### Keeps Reconnecting

**Symptom**: `Attempting to reconnect...` appears frequently

**Solutions**:
1. Check network stability
2. Check server hasn't crashed
3. Check agent logs for errors
4. May need to increase timeout settings

### High Latency

**Symptom**: Requests are slow even for simple responses

**Solutions**:
1. Check jrok server location (geographic latency)
2. Check local service performance
3. Check network bandwidth
4. Consider deploying jrok closer to you

## Performance Tips

### For Docker Swarm
- Use HAProxy for better load balancing than Docker's built-in
- Monitor memory usage of HAProxy (can be high with many connections)
- Use overlay networks for service-to-service communication

### For Kubernetes
- Use proper Ingress controller (nginx, traefik) instead of agent client when possible
- Agent client best for private clusters without public IP
- Monitor Pod resource usage

### For Raw TCP Ports
- Use for simple services only
- For complex routing, use Docker Swarm or Kubernetes
- Monitor open connections

## Security Considerations

### API Token Management
- Store tokens in `.env` files (not in git!)
- Rotate tokens regularly
- Use different tokens for different environments
- Never share tokens in logs or error messages

### Network Security
- Always use HTTPS for jrok server URL
- Only expose necessary ports
- Use firewall rules to limit access
- Monitor logs for suspicious activity

### Service Security
- Ensure local services have proper authentication
- Don't expose internal services unnecessarily
- Use rate limiting on jrok (if available)
- Monitor access logs

## Production Deployment

### Recommended Setup

```
┌─────────────────────────────────────────┐
│  Production Private Network             │
├─────────────────────────────────────────┤
│                                         │
│  ┌───────────────────────────────────┐  │
│  │  Docker Swarm / Kubernetes        │  │
│  │  (3-10 nodes, HA configured)      │  │
│  │                                   │  │
│  │  ├─ Application Services (3+)     │  │
│  │  ├─ Load Balancer (HAProxy/LB)    │  │
│  │  ├─ Database (replicated)         │  │
│  │  └─ Cache (Redis/Memcached)       │  │
│  └───────────────────────────────────┘  │
│           ▲                              │
│  ┌────────┴────────────────────────┐    │
│  │  Agent Client (systemd service) │    │
│  │  (auto-restart on failure)      │    │
│  └────────┬────────────────────────┘    │
│           │                              │
└───────────┼──────────────────────────────┘
            │
     (WebSocket over WAN)
            │
┌───────────┴──────────────────────────────┐
│  jrok (Highly Available)          │
│                                          │
│  ├─ Multiple instances (3+)              │
│  ├─ Load balancer in front               │
│  ├─ MongoDB for certificate sync         │
│  ├─ HTTPS/TLS termination                │
│  └─ Geographic redundancy                │
└──────────────────────────────────────────┘
```

### Systemd Service File

Create `/etc/systemd/system/jrok-agent.service`:

```ini
[Unit]
Description=jrok Agent Client
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/jrok
EnvironmentFile=/home/ubuntu/.jrok.env
ExecStart=/usr/bin/bun client.ts connect
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable jrok-agent
sudo systemctl start jrok-agent
sudo systemctl status jrok-agent
sudo journalctl -u jrok-agent -f
```

## Contributing

Found a bug? Have a feature request?
Create an issue at: https://github.com/koompi/jrok/issues

## License

Same as jrok project.
