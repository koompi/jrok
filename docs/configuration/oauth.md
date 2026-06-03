# KOOMPI ID OAuth Setup

Configure KOOMPI ID as the authentication provider for your KProxy dashboard.

## What is KOOMPI ID?

KOOMPI ID is an OAuth 2.0 identity provider that allows users to sign in with their KOOMPI account. It provides:

- Single Sign-On (SSO) across KOOMPI services
- Secure OAuth 2.0 + PKCE authentication
- User profile information (name, email, avatar)

## Getting OAuth Credentials

### Step 1: Create a KOOMPI Account

1. Visit [id.koompi.org](https://id.koompi.org)
2. Sign up for a new account or sign in

### Step 2: Access Developer Dashboard

1. Go to [dash.koompi.org](https://dash.koompi.org)
2. Sign in with your KOOMPI ID

### Step 3: Create a New Project

1. Click **"Create Project"** or **"New Application"**
2. Fill in the details:
   - **Name**: Your project name (e.g., "KProxy Tunnel Service")
   - **Description**: Brief description of your service
   - **Website URL**: Your service URL (e.g., `https://live.yourdomain.com`)

### Step 4: Configure OAuth Settings

1. Navigate to your project's **OAuth Settings** or **Credentials**
2. Set the **Redirect URI(s)**:
   
   For production:
   ```
   https://live.yourdomain.com/auth/callback
   ```
   
   For development:
   ```
   http://localhost:3000/auth/callback
   ```

3. Copy the credentials:
   - **Client ID**: `koompi_xxxxxxxxxxxxxxx`
   - **Client Secret**: `secret_xxxxxxxxxxxxxxx`

> ⚠️ **Important**: Keep your Client Secret secure! Never expose it in client-side code or public repositories.

### Step 5: Configure KProxy

Add the credentials to your environment:

```bash
# .env
KOOMPI_CLIENT_ID=koompi_your_client_id
KOOMPI_CLIENT_SECRET=secret_your_client_secret
KOOMPI_REDIRECT_URI=https://live.yourdomain.com/auth/callback
```

Or in Ansible inventory:

```ini
koompi_client_id=koompi_your_client_id
koompi_client_secret=secret_your_client_secret
koompi_redirect_uri=https://live.yourdomain.com/auth/callback
```

## OAuth Flow

### How Authentication Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Browser    │     │  KProxy Server │     │  KOOMPI ID   │
│  (Dashboard) │     │              │     │    OAuth     │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │ 1. Click Login     │                    │
       │───────────────────>│                    │
       │                    │                    │
       │ 2. Redirect to KOOMPI                   │
       │<───────────────────│                    │
       │                    │                    │
       │ 3. User authenticates                   │
       │────────────────────────────────────────>│
       │                    │                    │
       │ 4. Redirect with code                   │
       │<────────────────────────────────────────│
       │                    │                    │
       │ 5. Exchange code for token              │
       │───────────────────>│───────────────────>│
       │                    │                    │
       │                    │ 6. Return tokens   │
       │                    │<───────────────────│
       │                    │                    │
       │ 7. Session created │                    │
       │<───────────────────│                    │
       │                    │                    │
```

### Endpoints Used

| Endpoint | Description |
|----------|-------------|
| `/auth/login` | Get OAuth login URL |
| `/auth/callback` | OAuth callback (POST for API, GET redirects to dashboard) |
| `/auth/me` | Get current user info |
| `/auth/logout` | End session |

## Dashboard Integration

The KProxy dashboard handles OAuth automatically:

1. User clicks "Sign in with KOOMPI ID"
2. Redirected to KOOMPI OAuth
3. After authentication, redirected back to `/callback`
4. Dashboard exchanges code for session token
5. User is logged in

## API Key Authentication

After logging in, users can create API keys for CLI use:

```bash
# Via dashboard: Create API key in organization settings

# Via CLI (after initial OAuth login)
kproxy apikey create --name "My Laptop" --org <org-id>
```

API keys have format: `kproxy_xxxxxxxxxxxxxxxx`

## Troubleshooting

### Invalid Redirect URI

**Error**: `redirect_uri_mismatch`

**Solution**: Ensure the redirect URI in KOOMPI dashboard matches exactly:
- Check for trailing slashes
- Check http vs https
- Check domain/port

### Invalid Client

**Error**: `invalid_client`

**Solution**: 
- Verify Client ID and Secret are correct
- Check environment variables are loaded
- Ensure no extra whitespace in credentials

### CORS Errors

**Error**: Cross-origin request blocked

**Solution**: Add your dashboard URL to `ALLOWED_ORIGINS`:
```bash
ALLOWED_ORIGINS=https://live.yourdomain.com,http://localhost:5173
```

### Session Expired

Sessions expire after 7 days. Users need to re-authenticate.

---

## Security Best Practices

1. **Never expose Client Secret** in client-side code
2. **Use HTTPS** for all production redirect URIs
3. **Rotate secrets** periodically
4. **Limit redirect URIs** to only necessary domains
5. **Use environment variables** for credentials, not hardcoded values

---

## Next Steps

- [Cloudflare Setup](./cloudflare.md) - DNS and SSL configuration
- [Environment Variables](./environment.md) - All configuration options
