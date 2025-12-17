import type { TunnelConfig } from "../types/index";

let config: TunnelConfig;

export function setConfig(cfg: TunnelConfig): void {
  config = cfg;
}

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

export { generateNginxConfig };
