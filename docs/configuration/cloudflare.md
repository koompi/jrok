# Cloudflare Setup

Configure Cloudflare for DNS management and wildcard SSL certificates.

## Why Cloudflare?

Cloudflare is required for:

1. **DNS Management**: Point your domain to your VPS
2. **Wildcard SSL**: Let's Encrypt DNS-01 challenge for `*.tunnel.yourdomain.com`
3. **DDoS Protection** (optional): Protect your infrastructure

## Getting Started

### Step 1: Add Your Domain to Cloudflare

1. Sign in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Click **"Add a Site"**
3. Enter your domain (e.g., `yourdomain.com`)
4. Select the **Free plan** (sufficient for Jrok)
5. Cloudflare will scan your existing DNS records

### Step 2: Update Nameservers

1. Cloudflare will provide nameservers:
   ```
   ns1.cloudflare.com
   ns2.cloudflare.com
   ```
2. Update your domain registrar with these nameservers
3. Wait for DNS propagation (up to 24 hours)

### Step 3: Configure DNS Records

Navigate to **DNS** → **Records** and add:

| Type | Name | Content | Proxy Status |
|------|------|---------|--------------|
| A | `tunnel` | `YOUR_VPS_IP` | DNS only (gray) |
| A | `*.tunnel` | `YOUR_VPS_IP` | DNS only (gray) |

> ⚠️ **Important**: Set proxy status to **"DNS only"** (gray cloud) for wildcard SSL to work with Let's Encrypt.

### Visual Guide

```
╔═══════════════════════════════════════════════════════════════════╗
║ DNS Records                                                        ║
╠═══════════════════════════════════════════════════════════════════╣
║ Type    Name        Content           Proxy      TTL               ║
║─────────────────────────────────────────────────────────────────────║
║ A       tunnel      152.42.226.37     DNS only   Auto             ║
║ A       *.tunnel    152.42.226.37     DNS only   Auto             ║
╚═══════════════════════════════════════════════════════════════════╝
```

## Creating an API Token

Certbot needs a Cloudflare API token for DNS-01 challenges.

### Step 1: Navigate to API Tokens

1. Click your profile icon (top right)
2. Select **"My Profile"**
3. Go to **"API Tokens"** tab

### Step 2: Create Token

1. Click **"Create Token"**
2. Use the **"Edit zone DNS"** template
3. Configure permissions:

   | Permission | Access |
   |------------|--------|
   | Zone - DNS | Edit |
   | Zone - Zone | Read |

4. Configure zone resources:
   - **Include** → **Specific zone** → Select your domain

5. Click **"Continue to summary"**
6. Click **"Create Token"**
7. **Copy the token immediately** (it won't be shown again)

### Token Format

Your token will look like:
```
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-xxxxx
```

## Using the Token

### In Ansible

Add to `ansible/inventory.ini`:

```ini
cloudflare_token=your-cloudflare-api-token
```

### In Environment Variables

```bash
export CLOUDFLARE_TOKEN="your-cloudflare-api-token"
```

### In Certbot Credentials File

Create `/etc/letsencrypt/secrets/cloudflare.ini`:

```ini
dns_cloudflare_api_token = your-cloudflare-api-token
```

Set permissions:
```bash
chmod 600 /etc/letsencrypt/secrets/cloudflare.ini
```

## SSL Certificate Flow

### How DNS-01 Challenge Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Certbot    │     │  Let's       │     │  Cloudflare  │
│   (VPS)      │     │  Encrypt     │     │  DNS         │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │ 1. Request cert    │                    │
       │───────────────────>│                    │
       │                    │                    │
       │ 2. DNS challenge   │                    │
       │<───────────────────│                    │
       │                    │                    │
       │ 3. Create TXT record via API            │
       │────────────────────────────────────────>│
       │                    │                    │
       │                    │ 4. Verify TXT      │
       │                    │───────────────────>│
       │                    │                    │
       │                    │ 5. Verified        │
       │                    │<───────────────────│
       │                    │                    │
       │ 6. Issue cert      │                    │
       │<───────────────────│                    │
       │                    │                    │
       │ 7. Delete TXT record                    │
       │────────────────────────────────────────>│
       │                    │                    │
```

### Certbot Command

```bash
certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/secrets/cloudflare.ini \
  --email admin@yourdomain.com \
  --agree-tos \
  --non-interactive \
  -d "tunnel.yourdomain.com" \
  -d "*.tunnel.yourdomain.com"
```

## Verify Setup

### Check DNS Propagation

```bash
# Main domain
dig tunnel.yourdomain.com +short
# Should return: YOUR_VPS_IP

# Wildcard
dig test.tunnel.yourdomain.com +short
# Should return: YOUR_VPS_IP
```

### Check SSL Certificate

```bash
# After Certbot runs
certbot certificates

# Expected output:
Certificate Name: tunnel.yourdomain.com
  Domains: tunnel.yourdomain.com *.tunnel.yourdomain.com
  Expiry Date: 2024-03-15 (VALID: 89 days)
```

### Test HTTPS

```bash
curl -I https://tunnel.yourdomain.com/health
# Should return: HTTP/2 200
```

## Troubleshooting

### DNS Not Propagating

```bash
# Check nameservers
dig NS yourdomain.com

# Expected: Cloudflare nameservers
ns1.cloudflare.com.
ns2.cloudflare.com.
```

### Certificate Issuance Failed

```bash
# Check Certbot logs
cat /var/log/letsencrypt/letsencrypt.log

# Common issues:
# - Invalid API token
# - Wrong zone permissions
# - DNS propagation delay (wait and retry)
```

### Cloudflare Proxy Issues

If using Cloudflare proxy (orange cloud):
- WebSocket connections may fail
- Wildcard certificates won't work with HTTP-01 challenge
- Use DNS only (gray cloud) for tunnel subdomain

---

## Security Notes

1. **Token Scope**: Only grant permissions for the specific zone needed
2. **Token Storage**: Never commit tokens to git
3. **Token Rotation**: Rotate tokens periodically
4. **Minimal Permissions**: Use "Edit zone DNS" not Global API key

---

## Next Steps

- [MongoDB Setup](./mongodb.md) - Database configuration
- [Environment Variables](./environment.md) - All configuration options
- [Self-Hosting Guide](../deployment/self-hosting.md) - Complete deployment
