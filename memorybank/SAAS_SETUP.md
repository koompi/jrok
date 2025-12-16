# jrok SaaS Platform Setup Guide

This guide covers setting up the complete SaaS platform with KOOMPI OAuth authentication, organization management, and the dashboard.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Backend Setup](#backend-setup)
4. [Dashboard Setup](#dashboard-setup)
5. [KOOMPI OAuth Configuration](#koompi-oauth-configuration)
6. [Database Setup](#database-setup)
7. [First Admin Setup](#first-admin-setup)
8. [API Reference](#api-reference)
9. [Deployment](#deployment)

## Overview

The jrok SaaS platform includes:

- **Backend API** (Bun + TypeScript)
  - KOOMPI OAuth authentication
  - JWT-based session management
  - Organization & team management
  - API key generation with permissions
  - Subscription & plans management
  - Backward-compatible legacy API support

- **Dashboard** (Vite + React + TypeScript + shadcn/ui)
  - Landing page with features & pricing
  - User authentication via KOOMPI OAuth
  - Organization management
  - API key management
  - Super admin panel

## Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- [Node.js](https://nodejs.org) (v18+) for dashboard
- [MongoDB](https://www.mongodb.com) (v6.0+)
- KOOMPI OAuth credentials (from https://dash.koompi.org)

## Backend Setup

### 1. Install Dependencies

```bash
cd /path/to/jrok
bun install
```

### 2. Configure Environment Variables

Copy the example file and configure:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# Server Configuration
PORT=3000
BASE_DOMAIN=tunnel.example.com

# MongoDB
MONGODB_URI=mongodb://localhost:27017/jrok

# KOOMPI OAuth (required for SaaS)
KOOMPI_CLIENT_ID=your_client_id
KOOMPI_CLIENT_SECRET=your_client_secret
KOOMPI_REDIRECT_URI=http://localhost:5173/callback

# JWT Secret (change this in production!)
JWT_SECRET=your-super-secret-jwt-key-change-this

# Legacy API Key (for backward compatibility)
API_KEY=your-legacy-api-key
```

### 3. Start the Server

```bash
bun run dev
# or
bun run src/index.ts
```

The server will start on `http://localhost:3000`.

## Dashboard Setup

### 1. Install Dependencies

```bash
cd dashboard
npm install
```

### 2. Configure Environment (Optional)

The dashboard uses a proxy to the backend. Update `vite.config.ts` if your backend runs on a different port.

### 3. Start Development Server

```bash
npm run dev
```

The dashboard will be available at `http://localhost:5173`.

## KOOMPI OAuth Configuration

### 1. Create a KOOMPI Project

1. Go to https://dash.koompi.org
2. Sign in or create an account
3. Click "New Project"
4. Enter your application name

### 2. Configure Redirect URIs

Add these redirect URIs to your KOOMPI project:

- Development: `http://localhost:5173/callback`
- Production: `https://your-domain.com/callback`

### 3. Get Credentials

Copy the `client_id` and `client_secret` from the dashboard and add them to your `.env` file.

### 4. Enable Authentication Providers

In the KOOMPI dashboard, enable the auth providers you want:
- Email & Password
- Google OAuth
- Apple Sign In
- Telegram Login

## Database Setup

### MongoDB Collections

The following collections are automatically created:

| Collection | Description |
|------------|-------------|
| `users` | User accounts from KOOMPI OAuth |
| `organizations` | Organizations created by users |
| `apiKeys` | API keys for organizations |
| `plans` | Subscription plans |
| `subscriptions` | Organization subscriptions |
| `usageRecords` | Usage tracking |
| `sessions` | User sessions |
| `tunnels` | Tunnel configurations |
| `agents` | Connected tunnel agents |

### Default Plans

The system automatically creates these plans on first run:

| Plan | Price | Tunnels | Domains | API Keys | Members |
|------|-------|---------|---------|----------|---------|
| Free | $0 | 1 | 1 | 1 | 1 |
| Starter | $9.99 | 5 | 3 | 3 | 3 |
| Pro | $29.99 | 20 | 10 | 10 | 10 |
| Enterprise | $99.99 | Unlimited | Unlimited | Unlimited | Unlimited |

## First Admin Setup

**Important:** The first user to register automatically becomes a **Super Admin**.

1. Start the backend and dashboard
2. Go to http://localhost:5173
3. Click "Login with KOOMPI"
4. Complete the OAuth flow
5. You will be registered as a Super Admin

Super Admins can:
- View all users
- Change user roles
- Deactivate users
- View all organizations

## API Reference

### Authentication Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/login` | Get KOOMPI OAuth login URL |
| POST | `/auth/callback` | Exchange code for token |
| GET | `/auth/me` | Get current user info |
| POST | `/auth/logout` | Logout |

### Organization Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/organizations` | List user's organizations |
| POST | `/organizations` | Create organization |
| GET | `/organizations/:id` | Get organization details |
| PUT | `/organizations/:id` | Update organization |
| DELETE | `/organizations/:id` | Delete organization |
| POST | `/organizations/:id/members` | Add member |
| DELETE | `/organizations/:id/members/:userId` | Remove member |

### API Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/organizations/:id/api-keys` | List API keys |
| POST | `/organizations/:id/api-keys` | Create API key |
| DELETE | `/organizations/:id/api-keys/:keyId` | Revoke API key |
| POST | `/organizations/:id/api-keys/:keyId/rotate` | Rotate API key |

### Admin Endpoints (Super Admin Only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/users` | List all users |
| PUT | `/auth/users/:id/role` | Update user role |
| DELETE | `/auth/users/:id` | Deactivate user |
| GET | `/admin/organizations` | List all organizations |

### Authentication Methods

The API supports two authentication methods:

1. **Session Token** (for dashboard)
   ```
   Authorization: Bearer <session_token>
   ```

2. **API Key** (for programmatic access)
   ```
   Authorization: Bearer jrok_xxxxx
   # or
   X-API-Key: jrok_xxxxx
   ```

## Deployment

### Production Checklist

- [ ] Set strong `JWT_SECRET` in production
- [ ] Use HTTPS for all endpoints
- [ ] Update `KOOMPI_REDIRECT_URI` for production domain
- [ ] Configure MongoDB with authentication
- [ ] Set up reverse proxy (nginx/caddy)
- [ ] Enable CORS appropriately

### Docker Deployment

```yaml
# docker-compose.yml
version: '3.8'
services:
  backend:
    build: .
    ports:
      - "3000:3000"
    environment:
      - MONGODB_URI=mongodb://mongo:27017/jrok
      - KOOMPI_CLIENT_ID=${KOOMPI_CLIENT_ID}
      - KOOMPI_CLIENT_SECRET=${KOOMPI_CLIENT_SECRET}
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - mongo
  
  dashboard:
    build: ./dashboard
    ports:
      - "80:80"
    depends_on:
      - backend
  
  mongo:
    image: mongo:6
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
```

### Nginx Configuration

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Dashboard
    location / {
        root /var/www/dashboard;
        try_files $uri $uri/ /index.html;
    }

    # API
    location /api/ {
        proxy_pass http://localhost:3000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Troubleshooting

### Common Issues

1. **OAuth callback fails**
   - Check that `KOOMPI_REDIRECT_URI` matches exactly what's in the KOOMPI dashboard
   - Ensure the protocol (http/https) is correct

2. **First user isn't super admin**
   - Clear the `users` collection and register again
   - Or manually update the user's role in MongoDB

3. **API keys not working**
   - Ensure the key starts with `jrok_`
   - Check the key hasn't expired or been revoked
   - Verify the organization is active

4. **Session expires too quickly**
   - JWT tokens are valid for 7 days by default
   - Check that `JWT_SECRET` is consistent across restarts

## Support

For issues and questions, please open a GitHub issue or contact the maintainers.
