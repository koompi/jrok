# Quick Start Guide

Get KProxy running in 5 minutes! This guide covers the fastest way to expose your local services to the internet.

## Option 1: Use KProxy by KOOMPI (Recommended)

The easiest way to use KProxy - no server setup required.

### Step 1: Get Your API Key

1. Visit [kproxy.koompi.cloud](https://kproxy.koompi.cloud)
2. Sign in with your KOOMPI ID
3. Create an organization (or use existing one)
4. Generate an API key from the dashboard

### Step 2: Install the CLI

**macOS / Linux:**
```bash
curl -fsSL https://github.com/koompi/jrok/releases/latest/download/kproxy-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m) -o kproxy
chmod +x kproxy
sudo mv kproxy /usr/local/bin/
```

**Or with npm:**
```bash
npm install -g kproxy
```

### Step 3: Expose Your Service

```bash
# First run - you'll be prompted for your API key
kproxy --port 3000

# That's it! 🚀
```

**Output:**
```
🔐 No API key configured.
   Get one from your dashboard at https://kproxy.koompi.cloud

Enter your API key: kproxy_xxxxx...

💾 Configuration saved to ~/.kproxy/config.json

🎲 Generated subdomain: a1b2c3d4
🔌 Connecting to kproxy server...
📍 Domain: a1b2c3d4
🏠 Local Service: localhost:3000

https://live.koompi.cloud

✅ Connected to server!
🌐 Your service is now available at: https://a1b2c3d4.live.koompi.cloud
✨ Connected to kproxy
🆔 Agent ID: aa01ea7c-70ef-403e-8720-6729bfef5d95
```

### Step 4: Access Your Service

Your local service is now publicly accessible at:
```
https://<subdomain>.live.koompi.cloud
```

## Option 2: Self-Hosted

Want to run your own KProxy server? See the [Self-Hosting Guide](../deployment/self-hosting.md).

---

## Common Use Cases

### Expose a Development Server

```bash
# React/Vue/Next.js dev server
kproxy --port 3000

# Django/Flask
kproxy --port 8000

# Ruby on Rails
kproxy --port 3001
```

### Custom Subdomain

```bash
# Use a specific subdomain
kproxy --port 3000 --domain myapp

# Access at: https://myapp.live.koompi.cloud

# If subdomain is taken, you'll get a suffix automatically:
# → https://myapp-a7b3.live.koompi.cloud
```

### TCP Tunnels (Databases, SSH, etc.)

```bash
# Expose PostgreSQL database
kproxy --port 5432 --tcp
# Access at: tcp://live.koompi.cloud:54321

# Expose MySQL
kproxy --port 3306 --tcp

# Expose SSH
kproxy --port 22 --tcp
```

### Custom Domains

```bash
# Register your custom domain
kproxy domain register --domain mysite.com

# Configure DNS (add CNAME record), then verify
kproxy domain verify --domain mysite.com

# Now your domain routes to your tunnel!
```

### Docker Swarm Service

```bash
# Expose a Docker Swarm service
kproxy connect --domain api --docker-service my-api
```

### Kubernetes Service

```bash
# Expose a Kubernetes service
kproxy connect --domain app --k8s-service my-svc:8080
```

---

## What's Next?

- [CLI Commands Reference](../cli/commands.md) - Learn all available commands
- [Architecture Overview](./architecture.md) - Understand how KProxy works
- [Self-Hosting Guide](../deployment/self-hosting.md) - Deploy your own server
