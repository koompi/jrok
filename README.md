<p align="center">
  <img src="./docs/assets/logo.png" alt="Jrok Logo" width="200">
</p>

<h1 align="center">Jrok</h1>

<p align="center">
  <strong>Expose local services to the public internet — Open Source & Self-Hostable</strong>
</p>

<p align="center">
  <a href="https://github.com/koompi/jrok/releases"><img src="https://img.shields.io/github/v/release/koompi/jrok" alt="Release"></a>
  <a href="https://github.com/koompi/jrok/blob/main/LICENSE"><img src="https://img.shields.io/github/license/koompi/jrok" alt="License"></a>
  <a href="https://jrok.koompi.cloud"><img src="https://img.shields.io/badge/managed-KOOMPI%20Cloud-blue" alt="KOOMPI Cloud"></a>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-features">Features</a> •
  <a href="#-self-hosting">Self-Hosting</a> •
  <a href="#-documentation">Documentation</a> •
  <a href="#-contributing">Contributing</a>
</p>

---

## What is Jrok?

Jrok is an **open-source tunnel service** that exposes your local development servers to the public internet. Think of it as a self-hostable alternative to ngrok, localtunnel, or Cloudflare Tunnel.

**Use cases:**
- 🔧 **Development** — Test webhooks, share WIP with clients
- 🚀 **Demos** — Show local apps without deploying  
- 🔌 **IoT** — Access devices behind NAT/firewalls
- 🧪 **Testing** — Mobile testing against local servers

---

## 🚀 Quick Start

### Option 1: Use Jrok from KOOMPI (Managed Service)

No server setup required. Get started in 30 seconds:

```bash
# Install CLI
curl -fsSL https://github.com/koompi/jrok/releases/latest/download/jrok-linux-x64 -o jrok
chmod +x jrok && sudo mv jrok /usr/local/bin/

# Expose your local service (you'll be prompted for API key)
jrok --port 3000
```

**Output:**
```
🎲 Generated subdomain: a1b2c3d4
🔌 Connecting to jrok server...
📍 Domain: a1b2c3d4
🏠 Local Service: localhost:3000

✅ Connected to server!
🌐 Your service is now available at: https://a1b2c3d4.tunnel.koompi.cloud
```

Get your API key at **[jrok.koompi.cloud](https://jrok.koompi.cloud)**

### Option 2: Self-Hosted

Deploy your own Jrok server for complete control:

```bash
git clone https://github.com/koompi/jrok.git
cd jrok
./scripts/deploy.sh
```

The deploy script will guide you through the entire setup. See [Self-Hosting Guide](./docs/deployment/self-hosting.md) for details.

---

## ✨ Features

### 🌐 Tunnel Any Local Service

```bash
# Simple - auto-generate subdomain
jrok --port 3000

# Custom subdomain
jrok --port 8080 --domain myapp
# → https://myapp.tunnel.koompi.cloud
```

### 🐳 Docker & Kubernetes Support

```bash
# Docker Swarm service
jrok connect --domain api --docker-service my-api

# Kubernetes service  
jrok connect --domain app --k8s-service my-svc:8080
```

### 🏢 Multi-Tenant Organizations

- Create organizations for teams
- Invite members with role-based access
- Manage API keys per organization
- Usage tracking and analytics

### 🔐 Secure by Default

- **HTTPS** with automatic SSL certificates (Let's Encrypt)
- **WebSocket** connections over WSS
- **API key** authentication with scoped permissions
- **OAuth** via KOOMPI ID

### 📊 Web Dashboard

- Manage tunnels and domains
- Create and revoke API keys
- View usage statistics
- Organization management

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            INTERNET                                  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        YOUR VPS SERVER                               │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  Nginx (SSL termination, wildcard certs)                       │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                  │                                   │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  Jrok Server (Bun runtime)                                     │ │
│  │  • WebSocket connection manager                                │ │
│  │  • HTTP request routing                                        │ │
│  │  • Authentication (OAuth + API keys)                           │ │
│  │  • MongoDB (users, orgs, tunnels)                              │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
              ▲                    ▲                    ▲
              │ WSS                │ WSS                │ WSS
              ▼                    ▼                    ▼
       ┌────────────┐       ┌────────────┐       ┌────────────┐
       │ Jrok Agent │       │ Jrok Agent │       │ Jrok Agent │
       │  (laptop)  │       │  (server)  │       │  (CI/CD)   │
       │   :3000    │       │   :8080    │       │   :5000    │
       └────────────┘       └────────────┘       └────────────┘
```

---

## 💻 CLI Usage

### Basic Commands

```bash
# Expose local port (auto-generates subdomain)
jrok --port 3000

# Specify subdomain
jrok --port 3000 --domain myapp

# List active tunnels
jrok list

# Disconnect tunnel
jrok disconnect --domain myapp

# Show configuration
jrok config

# Get help
jrok help
```

### Organization & API Keys

```bash
# List organizations
jrok org list

# Create organization
jrok org create --name "My Team"

# Create API key
jrok apikey create --org <org-id> --name "CI Key"
```

### Configuration

```bash
# Set server (for self-hosted)
jrok config --server https://tunnel.yourdomain.com

# Set API key
jrok config --auth jrok_your_api_key

# Clear config
jrok config --clear
```

See [CLI Commands Reference](./docs/cli/commands.md) for full documentation.

---

## 🛠️ Self-Hosting

### Prerequisites

| Requirement | Where to Get It |
|-------------|-----------------|
| Domain name | Any registrar |
| DigitalOcean account | [digitalocean.com](https://cloud.digitalocean.com) |
| Cloudflare account | [cloudflare.com](https://dash.cloudflare.com) |
| MongoDB Atlas | [mongodb.com/atlas](https://cloud.mongodb.com) (free tier) |
| KOOMPI ID credentials | [dash.koompi.org](https://dash.koompi.org) |

### Automated Deployment

The easiest way to deploy is using our automated script:

```bash
git clone https://github.com/koompi/jrok.git
cd jrok
./scripts/deploy.sh
```

The script will interactively:
1. ✅ Prompt for all required credentials
2. ✅ Create VPS on DigitalOcean (via Terraform)
3. ✅ Configure DNS records
4. ✅ Issue SSL certificates (via Certbot + Cloudflare)
5. ✅ Deploy and start all services (via Ansible)

### What You'll Need Ready

Before running the deploy script, gather these credentials:

| Credential | How to Get It |
|------------|---------------|
| **DigitalOcean Token** | [API → Tokens → Generate](https://cloud.digitalocean.com/account/api/tokens) |
| **Cloudflare Token** | [Profile → API Tokens → Create](./docs/configuration/cloudflare.md) |
| **MongoDB URI** | [Atlas → Connect → Connection String](./docs/configuration/mongodb.md) |
| **KOOMPI OAuth** | [dash.koompi.org → Create Project](./docs/configuration/oauth.md) |

### Manual Deployment

For custom configurations, see our detailed guides:
- 📖 [Self-Hosting Guide](./docs/deployment/self-hosting.md) — Complete walkthrough
- 🏗️ [Terraform Setup](./docs/deployment/terraform.md) — Infrastructure provisioning
- ⚙️ [Ansible Deployment](./docs/deployment/ansible.md) — Server configuration
- 🐳 [Docker Deployment](./docs/deployment/docker.md) — Container-based setup

---

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|:--------:|
| `MONGODB_URI` | MongoDB connection string | ✅ |
| `JWT_SECRET` | Secret for JWT tokens (64+ chars) | ✅ |
| `BASE_DOMAIN` | Base domain for tunnels | ✅ |
| `KOOMPI_CLIENT_ID` | OAuth client ID | ✅ |
| `KOOMPI_CLIENT_SECRET` | OAuth client secret | ✅ |
| `KOOMPI_REDIRECT_URI` | OAuth callback URL | ✅ |
| `PORT` | Server port | `3000` |
| `DASHBOARD_URL` | Dashboard URL | Optional |

See [Environment Variables](./docs/configuration/environment.md) for complete reference.

### Getting Credentials

- 🔐 [KOOMPI ID OAuth](./docs/configuration/oauth.md) — Authentication setup
- ☁️ [Cloudflare Setup](./docs/configuration/cloudflare.md) — DNS and SSL
- 🗄️ [MongoDB Setup](./docs/configuration/mongodb.md) — Database configuration

---

## 📚 Documentation

| Category | Guides |
|----------|--------|
| **Getting Started** | [Quick Start](./docs/getting-started/quick-start.md) · [Architecture](./docs/getting-started/architecture.md) |
| **Deployment** | [Self-Hosting](./docs/deployment/self-hosting.md) · [Terraform](./docs/deployment/terraform.md) · [Ansible](./docs/deployment/ansible.md) · [Docker](./docs/deployment/docker.md) |
| **Configuration** | [Environment](./docs/configuration/environment.md) · [OAuth](./docs/configuration/oauth.md) · [Cloudflare](./docs/configuration/cloudflare.md) · [MongoDB](./docs/configuration/mongodb.md) |
| **CLI** | [Installation](./docs/cli/installation.md) · [Commands](./docs/cli/commands.md) |

---

## 📁 Project Structure

```
jrok/
├── src/                    # Server source code (Bun/TypeScript)
│   ├── handlers/           # HTTP & WebSocket handlers
│   ├── services/           # Business logic
│   ├── types/              # TypeScript types
│   └── utils/              # Utilities
├── cli/                    # CLI client (Node.js/TypeScript)
├── dashboard/              # React dashboard (Vite)
├── ansible/                # Ansible playbooks & roles
├── docs/                   # Documentation
├── scripts/                # Deployment scripts
│   └── deploy.sh           # Automated deployment
├── jrok.tf                 # Terraform configuration
└── docker-compose.yml      # Docker configuration
```

---

## 🧰 Tech Stack

| Component | Technology |
|-----------|------------|
| Server | [Bun](https://bun.sh) (TypeScript) |
| Database | MongoDB (Atlas) |
| Web Server | Nginx |
| SSL | Let's Encrypt + Certbot |
| DNS | Cloudflare |
| Dashboard | React + Vite + Tailwind |
| CLI | Node.js + TypeScript |
| IaC | Terraform + Ansible |

---

## 🤝 Contributing

Contributions are welcome! 

```bash
# Clone repository
git clone https://github.com/koompi/jrok.git
cd jrok

# Install dependencies
bun install

# Start development server
bun run dev

# Run CLI in development
cd cli && bun run src/index.ts --help
```

---

## 📄 License

MIT License — see [LICENSE](./LICENSE) for details.

---

## 🙏 Acknowledgments

Built with ❤️ by **[KOOMPI](https://koompi.com)**

---

<p align="center">
  <a href="https://jrok.koompi.cloud">Try KOOMPI Cloud</a> •
  <a href="./docs/README.md">Documentation</a> •
  <a href="https://github.com/koompi/jrok/issues">Report Bug</a> •
  <a href="https://github.com/koompi/jrok/discussions">Discussions</a>
</p>
