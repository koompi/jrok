import type { TunnelConfig, TcpPortAllocation } from "../types/index";

let config: TunnelConfig;

export function setConfig(cfg: TunnelConfig): void {
  config = cfg;
}

/**
 * Generate Nginx stream (TCP) configuration for a TCP tunnel
 * This uses nginx's stream module for raw TCP proxying
 */
function generateNginxStreamConfig(
  port: number,
  tunnelId: string,
  comment?: string
): string {
  return `# TCP Tunnel: ${comment || tunnelId}
# Port: ${port}
upstream tcp_${tunnelId} {
    server 127.0.0.1:${port};
}

server {
    listen ${port};
    listen [::]:${port};
    
    proxy_pass tcp_${tunnelId};
    proxy_timeout 600s;
    proxy_connect_timeout 10s;
}
`;
}

/**
 * Generate the main nginx stream block configuration file
 * This should be included in nginx.conf within the stream {} block
 */
function generateNginxStreamMainConfig(allocations: TcpPortAllocation[]): string {
  if (allocations.length === 0) {
    return `# No TCP tunnels configured\n`;
  }

  let config = `# jrok TCP Tunnels - Auto-generated
# Last updated: ${new Date().toISOString()}
# Total tunnels: ${allocations.length}

`;

  for (const alloc of allocations) {
    config += generateNginxStreamConfig(
      alloc.port,
      alloc.tunnelId,
      `${alloc.localHost}:${alloc.localPort}`
    );
    config += '\n';
  }

  return config;
}

/**
 * Generate HTTP/HTTPS Nginx configuration
 */
function generateNginxConfig(
  domain: string,
  localPort: number,
  localHost: string,
  useSSL: boolean = true,
  customDomain?: string
): string {
  // Determine which domain/cert to use
  const certDomain = customDomain || config.baseDomain;
  const fullDomain = customDomain ? `${domain}.${customDomain}` : `${domain}.${config.baseDomain}`;
  
  // Always proxy to jrok server (not directly to agent's local port)
  // The jrok server handles forwarding the request through WebSocket to the agent
  const jrokPort = process.env.JROK_PORT || "3000";

  const sslPart = useSSL
    ? `
    # SSL configuration
    ssl_certificate /etc/letsencrypt/live/${certDomain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${certDomain}/privkey.pem;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;`
    : "";

  const httpRedirect = useSSL
    ? `
server {
    listen 80;
    listen [::]:80;
    server_name ${fullDomain};
    return 301 https://$host$request_uri;
}`
    : "";

  return `${httpRedirect}

server {
    listen ${useSSL ? "443" : "80"} ${useSSL ? "ssl http2" : ""};
    listen ${useSSL ? "[::]:443" : "[::]:80"} ${useSSL ? "ssl http2" : ""};
    server_name ${fullDomain};
${sslPart}

    location / {
        proxy_pass http://localhost:${jrokPort};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`;
}

export { generateNginxConfig, generateNginxStreamConfig, generateNginxStreamMainConfig };

// =============================================================================
// CUSTOM DOMAIN VHOSTS
// =============================================================================
// Two paths need to produce byte-identical vhosts for a customer's own domain:
// domainService, when the domain is first registered on whichever server
// handled the API call, and certificateSyncService, when a *different* server
// pulls that domain's certificate out of MongoDB and has to serve it too. If
// those two ever drift, the same domain behaves differently depending on which
// server DNS sent the visitor to — the hardest class of bug to reproduce in a
// multi-server setup. So the template lives here, once.

export const NGINX_SITES_PATH = process.env.NGINX_SITES_PATH || "/etc/nginx/sites-enabled";

/**
 * Same value, resolved at call time rather than at module load.
 *
 * The const above is captured the moment this module is first imported, which
 * makes it depend on import order — anything that loads before the environment
 * is fully in place silently gets the default. Callers that can run early (or
 * under test) should use this.
 */
export function nginxSitesPath(): string {
  return process.env.NGINX_SITES_PATH || "/etc/nginx/sites-enabled";
}

/** Config filename nginx uses for a custom domain. Both writers must agree. */
export function nginxConfigFileName(domain: string): string {
  return `${domain.replace(/\./g, "_")}.conf`;
}

/**
 * Generate nginx server block config for a custom domain (with SSL).
 *
 * `domain` must already be sanitized by the caller — it is interpolated into
 * a config file and a filesystem path.
 */
export function generateCustomDomainNginxConfig(domain: string, certPath: string): string {
  const jrokPort = process.env.JROK_PORT || "3000";

  return `# Custom domain: ${domain}
# Auto-generated by jrok server
# Generated: ${new Date().toISOString()}

# HTTP -> HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};

    # SSL configuration
    ssl_certificate ${certPath}/fullchain.pem;
    ssl_certificate_key ${certPath}/privkey.pem;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Proxy to jrok server
    location / {
        proxy_pass http://localhost:${jrokPort};
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $server_name;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
`;
}
