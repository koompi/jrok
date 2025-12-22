# Jrok CLI v2.3

**Expose local services (ports, Docker, Kubernetes) to the internet via secure reverse proxy**

## Features

- ✅ **HTTP/HTTPS Tunnels** - Expose any local HTTP service
- ✅ **TCP Tunnels** - Raw TCP support for databases, SSH, etc.
- ✅ **Docker Swarm Support** - Load-balanced container services  
- ✅ **Kubernetes Support** - Native K8s service integration
- ✅ **Custom Domains** - CNAME-verified custom domain support
- ✅ **Smart Subdomain Handling** - Auto-suffix on conflicts
- ✅ **Organization Management** - Manage orgs from CLI
- ✅ **API Key Management** - Create and revoke API keys
- ✅ **Config Persistence** - Save credentials locally
- ✅ **Standalone Binary** - No dependencies needed
- ✅ **Auto-reconnect** - Resilient connections
- ✅ **HTTPS Automatic** - SSL certificates handled automatically

## Installation

### NPM (Recommended)

```bash
# Global installation
curl -fsSL https://raw.githubusercontent.com/koompi/jrok/v2.2.0/install.sh | bash

# Verify installation
jrok version
```

### NPX (No installation)

```bash
npx jrok connect --server https://... --domain ... --port 3000 --auth jrok_xxx
```

### Standalone Binary

Download the latest binary from [Releases](https://github.com/koompi/jrok/releases):

```bash
# Linux/Mac
curl -L https://github.com/koompi/jrok/releases/latest/download/jrok-linux -o jrok
chmod +x jrok
sudo mv jrok /usr/local/bin/

# Windows
# Download jrok-windows.exe from releases
```

## Quick Start

### 1. Configure CLI (One-time Setup)

```bash
# Get API key from dashboard (https://your-tunnel-server.com)
# Then configure the CLI:
jrok config --server https://tunnel.example.com --auth jrok_xxxxxxxx

# Verify configuration
jrok whoami
```

### 2. Expose a Local Port

```bash
# Start your local service
npm run dev  # Running on http://localhost:3000

# Expose it to the internet (uses saved config)
jrok connect --domain myapp.example.com --port 3000

# Now accessible at https://myapp.example.com
```

### 2b. Expose TCP Service (Database, SSH, etc.)

```bash
# Expose PostgreSQL database
jrok connect --port 5432 --tcp

# Now accessible at tcp://tunnel.example.com:54321
```

### 3. Expose Docker Swarm Service

```bash
# Deploy your Docker service
docker service create --name web-app --replicas 3 myapp:latest

# Expose it to the internet
jrok connect --domain web.example.com --docker-service web-app
```

### 4. Expose Kubernetes Service

```bash
# Deploy your K8s service
kubectl apply -f deployment.yaml

# Expose it to the internet
jrok connect --domain api.example.com --k8s-service my-service:8080
```

## Configuration

The CLI stores configuration in `~/.jrok/config.json`. You can set values via the `config` command:

```bash
# Show current config
jrok config

# Set server URL
jrok config --server https://tunnel.example.com

# Set API key
jrok config --auth jrok_xxxxxxxxxxxxxxxx

# Set default organization
jrok config --org <organization-id>

# Clear all saved config
jrok config --clear
```

### Environment Variables

Environment variables take precedence over saved config:

```bash
export JROK_SERVER=https://tunnel.example.com
export JROK_AUTH=jrok_xxxxxxxx
export JROK_DOMAIN=myapp.example.com
export JROK_PORT=3000
```

## Organization Management

Manage your organizations from the CLI:

```bash
# List your organizations
jrok org list

# Create a new organization
jrok org create --name "My Company"

# Set default organization (for API key commands)
jrok org use --id <organization-id>
```

## API Key Management

Create and manage API keys for programmatic access:

```bash
# List API keys for an organization
jrok apikey list --org <org-id>

# Create a new API key
jrok apikey create --name "CI/CD Pipeline" --org <org-id>

# Create with specific permissions
jrok apikey create --name "Read Only" --org <org-id> --permissions "tunnel:read"

# Revoke an API key
jrok apikey revoke --id <key-id> --org <org-id>
```

### API Key Permissions

Available permissions:
- `tunnel:create` - Create new tunnels
- `tunnel:read` - List and view tunnels
- `tunnel:delete` - Remove tunnels
- `domain:manage` - Manage custom domains
- `org:read` - Read organization info
- `org:manage` - Manage organization settings

## Commands Reference

### connect

Expose a local service to the internet:

```bash
jrok connect [options]

Options:
  --server <url>          Server URL (or use config/env)
  --domain <domain>       Public domain/subdomain name
  --port <port>           Local port for TCP forwarding
  --host <host>           Local host (default: localhost)
  --tcp                   Create TCP tunnel (for databases, SSH)
  --force-new             Force new subdomain even if you own existing
  --docker-service <name> Docker Swarm service name
  --k8s-service <name>    Kubernetes service:port
  --auth <token>          API key (or use config/env)
```

### Subdomain Conflict Handling

| Scenario | Behavior |
|----------|----------|
| Subdomain available | Assigned as requested |
| You own the subdomain | Updates existing (or use `--force-new`) |
| Another org owns it | Auto-generates suffix (e.g., `myapp-a7b3`) |

### list

List all connected services:

```bash
jrok list
```

### disconnect

Disconnect a service:

```bash
jrok disconnect --domain myapp.example.com
```

### domain

Manage custom domains:

```bash
jrok domain register --domain mysite.com              # Register with auto subdomain
jrok domain register --domain mysite.com --subdomain api  # Register with specific subdomain
jrok domain verify --domain mysite.com                # Verify CNAME and issue SSL
jrok domain status --domain mysite.com                # Check verification status
jrok domain list                                      # List all custom domains
```

### config

Manage CLI configuration:

```bash
jrok config                        # Show config
jrok config --server <url>         # Set server URL
jrok config --auth <key>           # Set API key
jrok config --org <id>             # Set default org
jrok config --clear                # Clear config
```

### org

Manage organizations:

```bash
jrok org list                      # List organizations
jrok org create --name "Name"      # Create organization
jrok org use --id <org-id>         # Set default org
```

### apikey

Manage API keys:

```bash
jrok apikey list                   # List API keys
jrok apikey create --name "Name"   # Create API key
jrok apikey revoke --id <key-id>   # Revoke API key
```

### whoami

Show current user/API key info:

```bash
jrok whoami
```

### version

Show version information:

```bash
jrok version
jrok --version
jrok -v
```

### help

Show help message:

```bash
jrok help
jrok --help
jrok -h
```
- `JROK_SERVICE` - Docker/K8s service name

## Use Cases

### 1. Local Development

Share your local development server with others:

```bash
# Terminal 1: Run your app
npm run dev

# Terminal 2: Expose it
jrok connect --domain dev.example.com --port 3000
```

### 2. Webhook Testing

Test webhooks from services like GitHub, Stripe, etc:

```bash
jrok connect --domain webhooks.example.com --port 4000
```

### 3. Demo Applications

Show off your work without deploying:

```bash
jrok connect --domain demo.example.com --port 8080
```

### 4. Docker Services

Expose Docker Swarm services with load balancing:

```bash
docker service create --name api --replicas 5 myapi:latest
jrok connect --domain api.example.com --docker-service api
```

### 5. Kubernetes Apps

Expose Kubernetes services:

```bash
kubectl apply -f app.yaml
jrok connect --domain app.example.com --k8s-service app-service:3000
```

## Production Deployment

### Systemd Service

Create `/etc/systemd/system/jrok.service`:

```ini
[Unit]
Description=Jrok Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu
EnvironmentFile=/home/ubuntu/.jrok.env
ExecStart=/usr/local/bin/jrok connect
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Create `/home/ubuntu/.jrok.env`:

```bash
JROK_SERVER=https://tunnel.example.com
JROK_AUTH=your-api-key
JROK_DOMAIN=myapp.example.com
JROK_PORT=3000
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable jrok
sudo systemctl start jrok
sudo systemctl status jrok
```

View logs:

```bash
sudo journalctl -u jrok -f
```

## Troubleshooting

### Connection Refused

```bash
❌ Connection error: ECONNREFUSED
```

**Solution:** Check that your local service is running and the port is correct.

### Unauthorized

```bash
❌ API error: 401 Unauthorized
```

**Solution:** Verify your API token is correct.

### Domain Already in Use

```bash
ℹ️ Subdomain 'myapp' is taken by another organization
🔄 Assigned new subdomain: myapp-a7b3
```

This is expected behavior. Jrok auto-generates a unique suffix when your requested subdomain is taken by another organization. If you own the subdomain, use `--force-new` to create a new one instead of updating.

### Agent Disconnecting

The agent has auto-reconnect built in. If it keeps disconnecting:

1. Check your network connection
2. Verify the server is accessible
3. Check firewall settings

## Development

Build from source:

```bash
cd cli
bun install
bun run build    # Build JS bundle
bun run bundle   # Create standalone binary
```

Test locally:

```bash
bun run dev connect --server ... --domain ... --port ...
```

## Support

- **Documentation:** [Full Guide](../CLIENT_GUIDE.md)
- **Issues:** [GitHub Issues](https://github.com/koompi/jrok/issues)
- **Repository:** [GitHub](https://github.com/koompi/jrok)

## License

Apache License 2.0 - see [LICENSE](../LICENSE) for details
