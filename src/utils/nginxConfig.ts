import { readFileSync } from "fs";
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

// -----------------------------------------------------------------------------
// Template versions
// -----------------------------------------------------------------------------
// Every vhost jrok writes says which template produced it. When the template
// changes, reconcile upgrades a vhost only if it is still exactly what an older
// template produced (timestamp and trailing whitespace aside) — proof nobody
// edited it. A hand-edited vhost (production has several that proxy straight to
// a customer's own server) is never touched.
//
// To change the template: copy the current renderer into VHOST_RENDERERS under
// its version, edit the new one, bump CUSTOM_DOMAIN_VHOST_VERSION.

/** Version written by generateCustomDomainNginxConfig. */
export const CUSTOM_DOMAIN_VHOST_VERSION = 4;

const VHOST_VERSION_MARKER = "# jrok-vhost-template:";

/** Upstream every custom-domain vhost proxies to (see generateJrokUpstreamConfig). */
export const JROK_UPSTREAM_NAME = "jrok_local";

/**
 * File holding that upstream. It lives in the sites directory, next to the
 * vhosts, so whatever nginx.conf includes them includes it too. A custom domain
 * always contains a dot, so its config file can never take this name.
 */
export const JROK_UPSTREAM_FILE = "00-jrok-upstream.conf";

const UPSTREAM_HEADER = "# Auto-generated by jrok server: shared by every custom-domain vhost";

/**
 * The upstream and Connection-header map the v2+ vhosts rely on.
 *
 * `keepalive` lets nginx reuse its connections to jrok instead of opening one
 * per request, which needs the Connection header to be empty — not "upgrade" —
 * for ordinary requests. The map's variable has its own name because
 * nginx.conf usually defines `$connection_upgrade` already, and nginx refuses a
 * second definition.
 */
/**
 * Other edges' jrok (`host:port`, comma-separated in JROK_PEERS), which nginx
 * uses only while this server's jrok is down: their jrok serves the request
 * from its own agents (P15 in docs/plans/jrok-scale-out-plan.md). Anything
 * that isn't a plain host:port is dropped, since it goes into nginx config.
 */
export function jrokPeers(): string[] {
  return (process.env.JROK_PEERS || "")
    .split(",")
    .map((peer) => peer.trim())
    .filter((peer) => {
      const ok = /^[A-Za-z0-9.-]+:\d{1,5}$/.test(peer) || /^\[[0-9A-Fa-f:]+\]:\d{1,5}$/.test(peer);
      if (peer && !ok) console.warn(`⚠️ Ignoring JROK_PEERS entry "${peer}" (want host:port)`);
      return ok;
    });
}

export function generateJrokUpstreamConfig(): string {
  const jrokPort = process.env.JROK_PORT || "3000";
  const backups = jrokPeers().map((peer) => `    server ${peer} backup;\n`).join("");

  return `${UPSTREAM_HEADER}

upstream ${JROK_UPSTREAM_NAME} {
    server 127.0.0.1:${jrokPort};
${backups}    keepalive 64;
}

map $http_upgrade $jrok_connection_upgrade {
    default upgrade;
    ''      "";
}
`;
}

/**
 * What the shared upstream file should be rewritten with, given what is on
 * disk now (null = missing). Returns null when no write is needed: the file is
 * current, or it wasn't written by jrok and is left alone.
 */
export function upstreamFileUpdate(current: string | null): string | null {
  const wanted = generateJrokUpstreamConfig();
  if (current === wanted) return null;
  if (current !== null && !current.startsWith(UPSTREAM_HEADER)) return null;
  return wanted;
}

/** Write the shared upstream file into `sitesPath` if it is missing or out of date. */
export async function ensureJrokUpstreamFile(sitesPath: string): Promise<void> {
  const { readFile, writeFile, mkdir } = await import("fs/promises");
  const path = `${sitesPath}/${JROK_UPSTREAM_FILE}`;
  const update = upstreamFileUpdate(await readFile(path, "utf8").catch(() => null));
  if (update === null) return;

  await mkdir(sitesPath, { recursive: true });
  await writeFile(path, update);
}

/** Template version a vhost was written with. Files from before versioning are 1. */
export function vhostTemplateVersion(content: string): number {
  const match = content.match(/^# jrok-vhost-template: (\d+)$/m);
  return match ? Number(match[1]) : 1;
}

/** Drop the timestamp line and trailing whitespace, which older templates left behind. */
function normaliseVhost(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.startsWith("# Generated:"))
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * True when `content` is exactly what the template it claims to come from
 * produces for this domain — i.e. nobody has edited it since jrok wrote it.
 */
export function isUnmodifiedGeneratedVhost(content: string, domain: string, certPath: string): boolean {
  const render = VHOST_RENDERERS[vhostTemplateVersion(content)];
  return render !== undefined && normaliseVhost(content) === normaliseVhost(render(domain, certPath));
}

/** True when reconcile should replace this vhost with the current template. */
export function vhostNeedsUpgrade(content: string, domain: string, certPath: string): boolean {
  return vhostTemplateVersion(content) < currentVhostVersion() &&
    isUnmodifiedGeneratedVhost(content, domain, certPath);
}

/**
 * Generate nginx server block config for a custom domain (with SSL).
 *
 * `domain` must already be sanitized by the caller — it is interpolated into
 * a config file and a filesystem path. The vhost proxies to the shared
 * upstream, so callers must also call ensureJrokUpstreamFile.
 */
export function generateCustomDomainNginxConfig(domain: string, certPath: string): string {
  return VHOST_RENDERERS[currentVhostVersion()]!(domain, certPath);
}

/**
 * Does nginx.conf define the edge cache (the `jrok_cache` zone and the
 * `$jrok_not_shareable` map, from the Ansible nginx role)? Template v3 uses
 * both, so it is only written where they exist; elsewhere v2, which nginx
 * would accept, stays current. NGINX_CONF_PATH overrides the location.
 */
export function edgeCacheAvailable(): boolean {
  try {
    const conf = readFileSync(process.env.NGINX_CONF_PATH || "/etc/nginx/nginx.conf", "utf8");
    return conf.includes("keys_zone=jrok_cache") && conf.includes("$jrok_not_shareable");
  } catch {
    return false;
  }
}

/** The template version this server writes: 4 with the edge cache (Ansible's nginx.conf), else 2. */
export function currentVhostVersion(): number {
  return edgeCacheAvailable() ? CUSTOM_DOMAIN_VHOST_VERSION : 2;
}

/**
 * Template v4: v3, with certificate challenges on port 80 answered by jrok,
 * which finds the answer on whichever edge's certbot asked for the certificate
 * (services/acmeChallenge.ts). The HTTPS block clears the marker header so a
 * visitor can't use it to reach that path instead of their app.
 */
function generateCustomDomainNginxConfigV4(domain: string, certPath: string): string {
  return generateCustomDomainNginxConfigV3(domain, certPath)
    .replace(`${VHOST_VERSION_MARKER} 3\n`, `${VHOST_VERSION_MARKER} 4\n`)
    .replace(`    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
`, `    location /.well-known/acme-challenge/ {
        proxy_pass http://${JROK_UPSTREAM_NAME};
        proxy_set_header Host $host;
        proxy_set_header X-Jrok-Acme-Challenge 1;
    }
`)
    .replace(`        proxy_set_header Connection $jrok_connection_upgrade;
`, `        proxy_set_header Connection $jrok_connection_upgrade;
        proxy_set_header X-Jrok-Acme-Challenge "";
`);
}

/** Template v3: v2 plus the edge cache (see the Ansible nginx role). */
function generateCustomDomainNginxConfigV3(domain: string, certPath: string): string {
  return generateCustomDomainNginxConfigV2(domain, certPath)
    .replace(`${VHOST_VERSION_MARKER} 2\n`, `${VHOST_VERSION_MARKER} 3\n`)
    .replace(`        proxy_set_header Connection $jrok_connection_upgrade;
`, `        proxy_set_header Connection $jrok_connection_upgrade;

        # Edge cache: only responses the app marks public / s-maxage, keyed by
        # host, never with Authorization; served while the app is down.
        proxy_cache jrok_cache;
        proxy_cache_key $scheme$host$request_uri;
        proxy_no_cache $jrok_not_shareable $http_authorization;
        proxy_cache_bypass $http_authorization;
        proxy_cache_use_stale error timeout updating http_502 http_503 http_504;
        proxy_cache_background_update on;
`);
}

/** Template version 2, kept so reconcile can recognise unedited v2 files. */
function generateCustomDomainNginxConfigV2(domain: string, certPath: string): string {
  return `# Custom domain: ${domain}
# Auto-generated by jrok server
${VHOST_VERSION_MARKER} 2
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
        proxy_pass http://${JROK_UPSTREAM_NAME};
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $server_name;

        # WebSocket support; empty for ordinary requests so the upstream
        # connection is reused.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $jrok_connection_upgrade;

        # Timeouts. The read timeout is the longest quiet gap nginx allows, so a
        # visitor's idle WebSocket survives an hour. Plain HTTP is cut off
        # sooner by jrok itself (TUNNEL_REQUEST_TIMEOUT_MS to first byte).
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 3600s;
    }
}
`;
}

/** Template version 1, kept so reconcile can recognise unedited v1 files. */
function generateCustomDomainNginxConfigV1(domain: string, certPath: string): string {
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

/** A vhost exactly as template `version` wrote it (tests and tooling). */
export function renderVhostTemplate(version: number, domain: string, certPath: string): string {
  const render = VHOST_RENDERERS[version];
  if (!render) throw new Error(`No vhost template version ${version}`);
  return render(domain, certPath);
}

/** Every template version jrok has shipped, by the number its files carry. */
const VHOST_RENDERERS: Record<number, (domain: string, certPath: string) => string> = {
  1: generateCustomDomainNginxConfigV1,
  2: generateCustomDomainNginxConfigV2,
  3: generateCustomDomainNginxConfigV3,
  4: generateCustomDomainNginxConfigV4,
};
