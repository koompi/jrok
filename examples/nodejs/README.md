# jrok - Node.js Hello World Example

Simple Node.js app to test the jrok agent and proxy tunneling.

## Quick Start

### 1. Run locally
```bash
npm install
npm start
```

Server will run at `http://localhost:3000`

### 2. Test locally
```bash
# Health check
curl http://localhost:3000/health

# HTML page
curl http://localhost:3000

# API info
curl http://localhost:3000/api/info
```

### 3. Expose via jrok agent

In another terminal:
```bash
# Get your API key from the VPS
ssh root@143.198.201.54 "cat /home/ubuntu/jrok/.env | grep API_KEY"

# Create a tunnel to your local app
cd /path/to/jrok
bun client.ts connect \
  --server https://tunnel.koompi.cloud \
  --domain myapp \
  --port 3000 \
  --auth YOUR_API_KEY
```

### 4. Access your app from internet
```bash
https://myapp.tunnel.koompi.cloud
```

## Endpoints

- **GET /** - HTML page with info
- **GET /health** - Health check (JSON)
- **GET /api/info** - API endpoint (JSON)

## Environment Variables

- `PORT` - Port to run on (default: 3000)

## Architecture

```
Local App (localhost:3000)
    ↓
jrok Agent Client (tunnel)
    ↓
VPS Server (jrok)
    ↓
Nginx (tunnel.koompi.cloud)
    ↓
Public Internet (HTTPS)
```

## Testing Flow

1. Start this app locally: `npm start`
2. Run jrok agent: `bun client.ts connect ...`
3. Access via: `https://myapp.tunnel.koompi.cloud`
4. See your local app exposed to the internet! 🚀
