# Environment Variables

Complete reference for all Jrok configuration options.

## Required Variables

These must be set for Jrok to function properly.

### Database

| Variable | Description | Example |
|----------|-------------|---------|
| `MONGODB_URI` | MongoDB connection string | `mongodb+srv://user:pass@cluster.mongodb.net/jrok` |

### Authentication

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | Secret for JWT signing (min 64 chars) | `openssl rand -base64 64` |

### Domain

| Variable | Description | Example |
|----------|-------------|---------|
| `BASE_DOMAIN` | Base domain for tunnel subdomains | `tunnel.example.com` |

### OAuth (Required for Dashboard)

| Variable | Description | Example |
|----------|-------------|---------|
| `KOOMPI_CLIENT_ID` | OAuth client ID from KOOMPI | `abc123...` |
| `KOOMPI_CLIENT_SECRET` | OAuth client secret | `secret456...` |
| `KOOMPI_REDIRECT_URI` | OAuth callback URL | `https://tunnel.example.com/auth/callback` |

---

## Optional Variables

### Server Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `NODE_ENV` | Environment mode | `development` |
| `DASHBOARD_URL` | Dashboard URL for redirects | `http://localhost:5173` |
| `ALLOWED_ORIGINS` | CORS allowed origins (comma-separated) | `http://localhost:5173` |

### VPS Configuration (for nginx management)

| Variable | Description | Default |
|----------|-------------|---------|
| `VPS_HOST` | VPS hostname/IP for SSH | `localhost` |
| `VPS_USER` | SSH username | `root` |
| `VPS_PORT` | SSH port | `22` |
| `VPS_ID` | Unique VPS identifier | Auto-generated |
| `VPS_NAME` | Human-readable VPS name | `jrok-server` |
| `NGINX_PATH` | Nginx config directory | `/etc/nginx/sites-available` |

### Security

| Variable | Description | Default |
|----------|-------------|---------|
| `API_KEY` | Legacy API key (backward compat) | None |
| `CERT_SYNC_API_KEY` | Key for certificate sync API | None |

### Notifications (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for alerts | None |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for alerts | None |

---

## Example .env File

```bash
# =============================================================================
# JROK ENVIRONMENT CONFIGURATION
# =============================================================================

# -----------------------------------------------------------------------------
# REQUIRED: Database
# -----------------------------------------------------------------------------
# MongoDB Atlas connection string
# Get from: https://cloud.mongodb.com → Database → Connect
MONGODB_URI=mongodb+srv://jrokuser:securepassword@cluster0.xxxxx.mongodb.net/jrok?retryWrites=true&w=majority

# -----------------------------------------------------------------------------
# REQUIRED: Authentication
# -----------------------------------------------------------------------------
# JWT secret for session tokens (generate with: openssl rand -base64 64)
JWT_SECRET=your-super-long-secret-key-at-least-64-characters-for-security

# -----------------------------------------------------------------------------
# REQUIRED: Domain
# -----------------------------------------------------------------------------
# Base domain for tunnel subdomains (without https://)
BASE_DOMAIN=tunnel.yourdomain.com

# -----------------------------------------------------------------------------
# REQUIRED: KOOMPI OAuth (for dashboard login)
# -----------------------------------------------------------------------------
# Get from: https://dash.koompi.org → Create Project → OAuth Settings
KOOMPI_CLIENT_ID=your-koompi-client-id
KOOMPI_CLIENT_SECRET=your-koompi-client-secret
KOOMPI_REDIRECT_URI=https://tunnel.yourdomain.com/auth/callback

# -----------------------------------------------------------------------------
# OPTIONAL: Server Configuration
# -----------------------------------------------------------------------------
PORT=3000
NODE_ENV=production
DASHBOARD_URL=https://tunnel.yourdomain.com
ALLOWED_ORIGINS=https://tunnel.yourdomain.com,http://localhost:5173

# -----------------------------------------------------------------------------
# OPTIONAL: VPS/SSH Configuration (for nginx management)
# -----------------------------------------------------------------------------
VPS_HOST=localhost
VPS_USER=root
VPS_PORT=22
VPS_NAME=jrok-primary
NGINX_PATH=/etc/nginx/sites-available

# -----------------------------------------------------------------------------
# OPTIONAL: Security
# -----------------------------------------------------------------------------
# API key for certificate sync between servers
CERT_SYNC_API_KEY=your-32-char-secure-key

# Legacy API key (for backward compatibility)
# API_KEY=legacy-api-key

# -----------------------------------------------------------------------------
# OPTIONAL: Notifications
# -----------------------------------------------------------------------------
# Telegram alerts (create bot via @BotFather)
# TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
# TELEGRAM_CHAT_ID=-1001234567890
```

---

## Generating Secrets

### JWT Secret

```bash
# Generate a secure 64-character secret
openssl rand -base64 64

# Or using Node.js
node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"
```

### API Key

```bash
# Generate a 32-character hex key
openssl rand -hex 32
```

---

## Environment-Specific Configurations

### Development

```bash
NODE_ENV=development
PORT=3000
DASHBOARD_URL=http://localhost:5173
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
KOOMPI_REDIRECT_URI=http://localhost:3000/auth/callback
```

### Production

```bash
NODE_ENV=production
PORT=3000
DASHBOARD_URL=https://tunnel.yourdomain.com
ALLOWED_ORIGINS=https://tunnel.yourdomain.com
KOOMPI_REDIRECT_URI=https://tunnel.yourdomain.com/auth/callback
```

---

## Loading Environment Variables

### From .env File (Development)

Jrok automatically loads `.env` file in development mode.

### From Shell (Production)

```bash
# Export individually
export MONGODB_URI="mongodb+srv://..."
export JWT_SECRET="..."

# Or source from file
source /etc/jrok/environment
```

### With systemd

In `/etc/systemd/system/jrok.service`:

```ini
[Service]
Environment=NODE_ENV=production
Environment=PORT=3000
EnvironmentFile=/etc/jrok/environment
```

### With Docker

```bash
# Using .env file
docker run --env-file .env jrok

# Using individual vars
docker run -e MONGODB_URI="..." -e JWT_SECRET="..." jrok
```

### With Docker Compose

```yaml
services:
  jrok:
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - PORT=3000
```

---

## Validation

Jrok validates required variables on startup. Missing variables will cause the server to exit with an error message.

```bash
# Example error
❌ Missing required environment variable: MONGODB_URI
❌ Missing required environment variable: JWT_SECRET
```

---

## Next Steps

- [KOOMPI OAuth Setup](./oauth.md) - Configure authentication
- [Cloudflare Setup](./cloudflare.md) - DNS and SSL
- [MongoDB Setup](./mongodb.md) - Database configuration
