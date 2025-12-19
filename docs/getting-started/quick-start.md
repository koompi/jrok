# Quick Start Guide

Get Jrok running in 5 minutes! This guide covers the fastest way to expose your local services to the internet.

## Option 1: Use Jrok by KOOMPI (Recommended)

The easiest way to use Jrok - no server setup required.

### Step 1: Get Your API Key

1. Visit [jrok.koompi.cloud](https://jrok.koompi.cloud)
2. Sign in with your KOOMPI ID
3. Create an organization (or use existing one)
4. Generate an API key from the dashboard

### Step 2: Install the CLI

**macOS / Linux:**
```bash
curl -fsSL https://github.com/koompi/jrok/releases/latest/download/jrok-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m) -o jrok
chmod +x jrok
sudo mv jrok /usr/local/bin/
```

**Or with npm:**
```bash
npm install -g @koompi/jrok
```

### Step 3: Expose Your Service

```bash
# First run - you'll be prompted for your API key
jrok --port 3000

# That's it! 🚀
```

**Output:**
```
🔐 No API key configured.
   Get one from your dashboard at https://jrok.koompi.cloud

Enter your API key: jrok_xxxxx...

💾 Configuration saved to ~/.jrok/config.json

🎲 Generated subdomain: a1b2c3d4
🔌 Connecting to jrok server...
📍 Domain: a1b2c3d4
🏠 Local Service: localhost:3000

https://tunnel.koompi.cloud

✅ Connected to server!
🌐 Your service is now available at: https://a1b2c3d4.tunnel.koompi.cloud
✨ Connected to jrok
🆔 Agent ID: aa01ea7c-70ef-403e-8720-6729bfef5d95
```

### Step 4: Access Your Service

Your local service is now publicly accessible at:
```
https://<subdomain>.tunnel.koompi.cloud
```

## Option 2: Self-Hosted

Want to run your own Jrok server? See the [Self-Hosting Guide](../deployment/self-hosting.md).

---

## Common Use Cases

### Expose a Development Server

```bash
# React/Vue/Next.js dev server
jrok --port 3000

# Django/Flask
jrok --port 8000

# Ruby on Rails
jrok --port 3001
```

### Custom Subdomain

```bash
# Use a specific subdomain
jrok --port 3000 --domain myapp

# Access at: https://myapp.tunnel.koompi.cloud

# If subdomain is taken, you'll get a suffix automatically:
# → https://myapp-a7b3.tunnel.koompi.cloud
```

### TCP Tunnels (Databases, SSH, etc.)

```bash
# Expose PostgreSQL database
jrok --port 5432 --tcp
# Access at: tcp://tunnel.koompi.cloud:54321

# Expose MySQL
jrok --port 3306 --tcp

# Expose SSH
jrok --port 22 --tcp
```

### Custom Domains

```bash
# Register your custom domain
jrok domain register --domain mysite.com

# Configure DNS (add CNAME record), then verify
jrok domain verify --domain mysite.com

# Now your domain routes to your tunnel!
```

### Docker Swarm Service

```bash
# Expose a Docker Swarm service
jrok connect --domain api --docker-service my-api
```

### Kubernetes Service

```bash
# Expose a Kubernetes service
jrok connect --domain app --k8s-service my-svc:8080
```

---

## What's Next?

- [CLI Commands Reference](../cli/commands.md) - Learn all available commands
- [Architecture Overview](./architecture.md) - Understand how Jrok works
- [Self-Hosting Guide](../deployment/self-hosting.md) - Deploy your own server
