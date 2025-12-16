# Advanced Setup: Docker Swarm & Kubernetes with jrok

Complete examples for using jrok agent with Docker Swarm and Kubernetes clusters.

## Table of Contents

1. [Docker Swarm Setup](#docker-swarm-setup)
2. [Kubernetes Setup](#kubernetes-setup)
3. [Multi-Service Architecture](#multi-service-architecture)
4. [Monitoring & Troubleshooting](#monitoring--troubleshooting)

---

## Docker Swarm Setup

### Prerequisites

```bash
# Initialize Docker Swarm (if not already done)
docker swarm init

# Or join an existing swarm
docker swarm join --token SWMTKN-... MANAGER_IP:2377

# Verify
docker node ls
docker info | grep Swarm
```

### Architecture

```
┌─────────────────────────────────────────────┐
│         Docker Swarm Cluster                │
├─────────────────────────────────────────────┤
│                                             │
│  Manager Nodes:                             │
│  ├─ node1 (primary)                         │
│  ├─ node2 (secondary)                       │
│  └─ node3 (tertiary)                        │
│                                             │
│  Worker Nodes:                              │
│  ├─ worker1, worker2, ... worker-N          │
│                                             │
│  Services:                                  │
│  ├─ web-app (3 replicas, port 3000)         │
│  ├─ api-app (5 replicas, port 8080)         │
│  ├─ cache-app (1 replica, port 6379)        │
│  └─ haproxy-lb (1 replica, port 8080)       │
│                                             │
│  Overlay Networks:                          │
│  ├─ ingress (built-in load balancing)       │
│  └─ app-network (service-to-service)        │
│                                             │
└─────────────────────────────────────────────┘
           │ (agent client)
           │ (WebSocket)
           ▼
┌─────────────────────────────────────────────┐
│      jrok (Public)                   │
│  https://web.example.com                    │
│  https://api.example.com                    │
└─────────────────────────────────────────────┘
```

### Step 1: Create Overlay Network

```bash
# Create overlay network for inter-service communication
docker network create \
  --driver overlay \
  --attachable \
  app-network

# Verify
docker network ls | grep overlay
```

### Step 2: Deploy HAProxy Load Balancer

**Option A: Simple Config (Static)**

```bash
# Create HAProxy configuration
cat > haproxy.cfg <<'EOF'
global
  log stdout local0
  maxconn 4096
  stats socket /run/haproxy/admin.sock mode 660 level admin
  stats timeout 30s

defaults
  log global
  mode http
  option httplog
  timeout connect 5000
  timeout client 50000
  timeout server 50000

frontend fe_main
  bind *:8080
  default_backend be_web

backend be_web
  balance roundrobin
  # These are service discovery names in Docker Swarm
  server web1 tasks.web-app:3000 check
  server web2 tasks.web-app:3000 check
  server web3 tasks.web-app:3000 check
EOF

# Create Docker config
docker config create haproxy-config-v1 haproxy.cfg

# Deploy HAProxy service
docker service create \
  --name haproxy-lb \
  --config src=haproxy-config-v1,target=/usr/local/etc/haproxy/haproxy.cfg \
  --network app-network \
  --publish 8080:8080 \
  --replicas 1 \
  --hostname haproxy-{{.Node.Hostname}} \
  haproxy:2.8

# Verify
docker service ls
docker service ps haproxy-lb
```

**Option B: Advanced Config (Multiple Backends)**

```bash
cat > haproxy-advanced.cfg <<'EOF'
global
  log stdout local0 local1 notice
  maxconn 4096
  stats socket /run/haproxy/admin.sock mode 660 level admin
  stats timeout 30s
  user nobody
  group nogroup

defaults
  log global
  mode http
  option httplog
  option dontlognull
  timeout connect 5000
  timeout client 50000
  timeout server 50000
  
  # Health check settings
  default-server inter 10s fall 3 rise 2

# Frontend for main traffic
frontend fe_web
  bind *:8080
  option forwardfor
  default_backend be_web

# Backend for web services (with health checks)
backend be_web
  balance roundrobin
  option httpchk GET /health HTTP/1.1\r\nHost:\ web-app
  server web1 tasks.web-app:3000 check
  server web2 tasks.web-app:3000 check
  server web3 tasks.web-app:3000 check

# Backend for API services
backend be_api
  balance leastconn
  option httpchk GET /api/health HTTP/1.1\r\nHost:\ api-app
  server api1 tasks.api-app:8080 check
  server api2 tasks.api-app:8080 check
  server api3 tasks.api-app:8080 check
  server api4 tasks.api-app:8080 check
  server api5 tasks.api-app:8080 check

# Stats page (at http://HAPROXY:8080/stats)
listen stats
  bind *:9000
  stats enable
  stats uri /stats
  stats refresh 5s
EOF

# Deploy
docker config create haproxy-advanced-v1 haproxy-advanced.cfg
docker service create \
  --name haproxy-lb \
  --config src=haproxy-advanced-v1,target=/usr/local/etc/haproxy/haproxy.cfg \
  --network app-network \
  --publish 8080:8080 \
  --publish 9000:9000 \
  haproxy:2.8
```

### Step 3: Deploy Application Services

```bash
# Deploy web application with 3 replicas
docker service create \
  --name web-app \
  --replicas 3 \
  --network app-network \
  --publish 3000:3000 \
  --env APP_PORT=3000 \
  --env SERVICE_NAME=web-app \
  --health-cmd="curl -f http://localhost:3000/health || exit 1" \
  --health-interval=10s \
  --health-timeout=5s \
  --health-retries=3 \
  your-app-image:latest

# Deploy API application with 5 replicas
docker service create \
  --name api-app \
  --replicas 5 \
  --network app-network \
  --publish 8080:8080 \
  --env APP_PORT=8080 \
  --env SERVICE_NAME=api-app \
  --health-cmd="curl -f http://localhost:8080/health || exit 1" \
  --health-interval=10s \
  your-api-image:latest

# Deploy cache service
docker service create \
  --name cache-app \
  --replicas 1 \
  --network app-network \
  --publish 6379:6379 \
  redis:7-alpine

# Verify all services
docker service ls
docker service ps web-app
docker service ps api-app
docker service ps haproxy-lb
```

### Step 4: Run Agent Client

```bash
# Connect to jrok
bun client.ts connect \
  --server https://reverse.example.com \
  --domain web.example.com \
  --docker-service haproxy-lb \
  --auth your-api-key

# Now https://web.example.com → jrok → agent → haproxy:8080 → web-app:3000 (3 replicas)
```

### Step 5: Manage Services

```bash
# Scale up/down
docker service update --replicas 5 web-app
docker service update --replicas 10 api-app

# Rolling update with new image
docker service update \
  --image your-app-image:v2.0 \
  web-app

# View service logs
docker service logs web-app

# View detailed stats
docker stats
docker service ps web-app
```

### Monitoring Docker Swarm

```bash
# Monitor all nodes
watch -n 1 'docker node ls'

# Monitor services
watch -n 1 'docker service ls'

# Monitor specific service replicas
watch -n 1 'docker service ps web-app'

# View container logs
docker logs $(docker ps -q -f "label=com.docker.swarm.service.name=web-app")

# HAProxy stats (if exposed)
curl http://localhost:9000/stats
```

---

## Kubernetes Setup

### Prerequisites

```bash
# Have a Kubernetes cluster running
kubectl cluster-info

# Install/configure kubectl
kubectl config current-context
kubectl get nodes

# Verify cluster is ready
kubectl get all -A
```

### Architecture

```
┌─────────────────────────────────────────────┐
│    Kubernetes Cluster                       │
├─────────────────────────────────────────────┤
│                                             │
│  Namespace: default                         │
│                                             │
│  Deployments:                               │
│  ├─ web-frontend (3 replicas)               │
│  ├─ api-backend (5 replicas)                │
│  └─ cache-service (1 replica)               │
│                                             │
│  Services:                                  │
│  ├─ web-service (ClusterIP:3000)            │
│  ├─ api-service (ClusterIP:8080)            │
│  └─ cache-service (ClusterIP:6379)          │
│                                             │
│  Ingress (optional):                        │
│  └─ app-ingress (internal routing)          │
│                                             │
│  Pods:                                      │
│  ├─ web-frontend-... (3 running)            │
│  ├─ api-backend-... (5 running)             │
│  └─ cache-service-... (1 running)           │
│                                             │
└─────────────────────────────────────────────┘
           │ (agent client)
           │ (WebSocket)
           ▼
┌─────────────────────────────────────────────┐
│      jrok (Public)                   │
│  https://web.example.com                    │
│  https://api.example.com                    │
└─────────────────────────────────────────────┘
```

### Step 1: Create Namespace (Optional)

```bash
# Create dedicated namespace
kubectl create namespace jrok

# Switch to it
kubectl config set-context --current --namespace=jrok
```

### Step 2: Deploy Applications

**Deployment 1: Web Frontend**

```yaml
# web-frontend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
  labels:
    app: web-frontend
    version: v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-frontend
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: web-frontend
    spec:
      containers:
      - name: app
        image: your-frontend-image:latest
        ports:
        - containerPort: 3000
          name: http
        env:
        - name: PORT
          value: "3000"
        - name: LOG_LEVEL
          value: "info"
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - web-frontend
              topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: web-service
  labels:
    app: web-frontend
spec:
  type: ClusterIP
  ports:
  - port: 3000
    targetPort: 3000
    protocol: TCP
    name: http
  selector:
    app: web-frontend
```

Deploy:
```bash
kubectl apply -f web-frontend-deployment.yaml

# Verify
kubectl get deployment web-frontend
kubectl get pods -l app=web-frontend
kubectl get svc web-service
```

**Deployment 2: API Backend**

```yaml
# api-backend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-backend
  labels:
    app: api-backend
    version: v1
spec:
  replicas: 5
  selector:
    matchLabels:
      app: api-backend
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: api-backend
    spec:
      containers:
      - name: app
        image: your-api-image:latest
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: PORT
          value: "8080"
        - name: LOG_LEVEL
          value: "info"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: database-url
        resources:
          requests:
            memory: "256Mi"
            cpu: "200m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 15
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: api-service
  labels:
    app: api-backend
spec:
  type: ClusterIP
  ports:
  - port: 8080
    targetPort: 8080
    protocol: TCP
    name: http
  selector:
    app: api-backend
```

Deploy:
```bash
kubectl apply -f api-backend-deployment.yaml

# Verify
kubectl get deployment api-backend
kubectl get pods -l app=api-backend
kubectl get svc api-service
```

**Deployment 3: Cache Service**

```yaml
# cache-deployment.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cache-service
spec:
  serviceName: cache-service
  replicas: 1
  selector:
    matchLabels:
      app: cache-service
  template:
    metadata:
      labels:
        app: cache-service
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        ports:
        - containerPort: 6379
          name: redis
        volumeMounts:
        - name: cache-storage
          mountPath: /data
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
  volumeClaimTemplates:
  - metadata:
      name: cache-storage
    spec:
      accessModes:
      - ReadWriteOnce
      resources:
        requests:
          storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: cache-service
spec:
  type: ClusterIP
  clusterIP: None
  ports:
  - port: 6379
    targetPort: 6379
  selector:
    app: cache-service
```

Deploy:
```bash
kubectl apply -f cache-deployment.yaml

# Verify
kubectl get statefulset cache-service
kubectl get pvc
```

### Step 3: Run Agent Client

```bash
# Connect to jrok
bun client.ts connect \
  --server https://reverse.example.com \
  --domain web.example.com \
  --k8s-service web-service:3000 \
  --auth your-api-key

# Connect API
bun client.ts connect \
  --server https://reverse.example.com \
  --domain api.example.com \
  --k8s-service api-service:8080 \
  --auth your-api-key
```

### Step 4: Manage Kubernetes Deployments

```bash
# Scale deployments
kubectl scale deployment web-frontend --replicas=5
kubectl scale deployment api-backend --replicas=10

# Rolling update
kubectl set image deployment/web-frontend \
  app=your-frontend-image:v2.0 \
  --record

# View rollout status
kubectl rollout status deployment/web-frontend

# Rollback if needed
kubectl rollout undo deployment/web-frontend

# View logs
kubectl logs -f deployment/web-frontend
kubectl logs -f -l app=api-backend

# Port forward for local testing (before using jrok)
kubectl port-forward svc/web-service 3000:3000
kubectl port-forward svc/api-service 8080:8080
```

### Monitoring Kubernetes

```bash
# View cluster resources
kubectl get nodes
kubectl top nodes

# View pod status
kubectl get pods
kubectl top pods

# View services
kubectl get svc
kubectl describe svc web-service

# View events
kubectl get events --sort-by='.lastTimestamp'

# Monitor resource usage
watch -n 1 'kubectl top pods'
watch -n 1 'kubectl get pods'

# Check service discovery
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- bash
# Inside the debug pod:
nslookup web-service
curl http://web-service:3000/health
```

---

## Multi-Service Architecture

### Complete Example: 3-Tier App

**Setup Diagram:**

```
                    jrok (Public)
                    │
    ┌───────────────┼────────────────┐
    │               │                │
    ▼               ▼                ▼
web.example.com  api.example.com  db.example.com
    │               │                │
    │               │                │
    └───────────────┼────────────────┘
                    │
    ┌───────────────┼────────────────┐
    │               │                │
    ▼               ▼                ▼
Frontend(3)     Backend(5)     Database(1)
(Docker)        (Docker)       (Docker)
```

**Deployment Steps:**

```bash
# 1. Create overlay network
docker network create --driver overlay app-network

# 2. Deploy Database
docker service create \
  --name postgres-db \
  --network app-network \
  --publish 5432:5432 \
  --env POSTGRES_PASSWORD=secure-password \
  postgres:15-alpine

# 3. Deploy Backend (API) with 5 replicas
docker service create \
  --name api-backend \
  --network app-network \
  --replicas 5 \
  --publish 8080:8080 \
  --env DATABASE_URL=postgres://postgres:secure-password@postgres-db:5432/app \
  your-api-image:latest

# 4. Deploy Frontend with 3 replicas
docker service create \
  --name web-frontend \
  --network app-network \
  --replicas 3 \
  --publish 3000:3000 \
  --env API_URL=http://api-backend:8080 \
  your-frontend-image:latest

# 5. Deploy HAProxy load balancer
docker service create \
  --name haproxy-lb \
  --network app-network \
  --publish 8080:8080 \
  --config src=haproxy-config,target=/usr/local/etc/haproxy/haproxy.cfg \
  haproxy:2.8

# 6. Expose via jrok
bun client.ts connect --docker-service web-frontend --domain web.example.com --auth $KEY
bun client.ts connect --docker-service api-backend --domain api.example.com --auth $KEY
bun client.ts connect --docker-service postgres-db --port 5432 --domain db.example.com --auth $KEY
```

---

## Monitoring & Troubleshooting

### Docker Swarm Troubleshooting

```bash
# Check service status
docker service ls
docker service ps SERVICE_NAME

# View service logs
docker service logs SERVICE_NAME

# Inspect service config
docker service inspect SERVICE_NAME

# Check network connectivity
docker exec $(docker ps -q -f "label=com.docker.swarm.service.name=SERVICE") ping -c 3 other-service

# Update service (e.g., new image)
docker service update --image new-image:tag SERVICE_NAME

# Force update replicas
docker service update --force SERVICE_NAME
```

### Kubernetes Troubleshooting

```bash
# Check pod status
kubectl describe pod POD_NAME
kubectl logs POD_NAME
kubectl logs -f POD_NAME

# Check service endpoints
kubectl get endpoints SERVICE_NAME
kubectl describe svc SERVICE_NAME

# Test connectivity
kubectl run -it --rm test --image=nicolaka/netshoot --restart=Never -- bash
# In pod:
curl http://web-service:3000
curl http://api-service:8080

# Check resource quotas
kubectl describe quota

# Get events
kubectl get events
kubectl get events --field-selector involvedObject.kind=Pod

# Exec into pod for debugging
kubectl exec -it POD_NAME -- /bin/sh
```

### Common Issues

**Docker: Service can't reach another service**
```bash
# Verify network connection
docker network inspect app-network

# Verify service name resolution
docker exec CONTAINER_ID nslookup other-service
```

**Kubernetes: Pod stuck in pending**
```bash
# Check resource availability
kubectl describe node

# Check pod events
kubectl describe pod POD_NAME
```

**jrok connection issues**
```bash
# Verify local service is accessible
curl http://localhost:PORT

# Check agent logs
docker logs jrok-agent
# or
sudo journalctl -u jrok-agent -f
```

---

For more information, see:
- CLIENT_GUIDE.md - Complete client documentation
- CLIENT_QUICK_REFERENCE.md - Quick start examples
- Docker Swarm docs: https://docs.docker.com/engine/swarm/
- Kubernetes docs: https://kubernetes.io/docs/
