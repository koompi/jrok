#!/usr/bin/env node

/**
 * Jrok Agent Client - CLI Tool
 * 
 * Expose local services (Docker, Kubernetes, ports) to public internet via reverse proxy
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const VERSION = "2.1.0";

// Config file path
const CONFIG_DIR = join(homedir(), '.jrok');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface StoredConfig {
  serverUrl?: string;
  apiKey?: string;
  organizationId?: string;
  organizationName?: string;
}

interface ClientConfig {
  serverUrl: string;
  domain: string;
  port?: number;
  localHost: string;
  authToken: string;
  serviceType?: 'port' | 'docker-swarm' | 'kubernetes';
  serviceName?: string;
}

interface ServiceInfo {
  domain: string;
  type: 'port' | 'docker-swarm' | 'kubernetes';
  target: string;
  connected: boolean;
  connectedAt?: string;
}

interface Organization {
  _id: string;
  name: string;
  slug: string;
  plan?: string;
}

interface ApiKey {
  _id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

// Load stored config
function loadStoredConfig(): StoredConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (error) {
    // Ignore errors
  }
  return {};
}

// Save config
function saveStoredConfig(config: StoredConfig): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('⚠️  Could not save config:', error instanceof Error ? error.message : error);
  }
}

function parseArgs(): { command: string; subcommand?: string; args: Record<string, string> } {
  const argv = process.argv.slice(2);
  const command = argv[0]?.toLowerCase() || 'help';
  let subcommand: string | undefined;
  const args: Record<string, string> = {};

  let startIndex = 1;
  // Check for subcommand (e.g., 'org list', 'apikey create')
  if (argv[1] && !argv[1].startsWith('--')) {
    subcommand = argv[1].toLowerCase();
    startIndex = 2;
  }

  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];

      if (value && !value.startsWith("--")) {
        args[key] = value;
        i++;
      } else {
        args[key] = 'true'; // Flag without value
      }
    }
  }

  return { command, subcommand, args };
}

function buildConfig(args: Record<string, string>): Partial<ClientConfig> {
  const storedConfig = loadStoredConfig();
  const serviceType = args['docker-service'] ? 'docker-swarm' : 
                     args['k8s-service'] ? 'kubernetes' : 
                     'port';

  return {
    serverUrl: args["server"] || process.env.JROK_SERVER || storedConfig.serverUrl,
    domain: args["domain"] || process.env.JROK_DOMAIN,
    port: args["port"] ? parseInt(args["port"]) : 
          process.env.JROK_PORT ? parseInt(process.env.JROK_PORT) : 
          serviceType === 'port' ? 3000 : undefined,
    localHost: args["host"] || process.env.JROK_HOST || "localhost",
    authToken: args["auth"] || process.env.JROK_AUTH || storedConfig.apiKey,
    serviceType: serviceType as 'port' | 'docker-swarm' | 'kubernetes',
    serviceName: args["docker-service"] || args["k8s-service"] || process.env.JROK_SERVICE,
  };
}

function validateConnectConfig(config: Partial<ClientConfig>): asserts config is ClientConfig {
  if (!config.serverUrl) {
    throw new Error("Missing serverUrl. Use --server or JROK_SERVER env var");
  }
  if (!config.domain) {
    throw new Error("Missing domain. Use --domain or JROK_DOMAIN env var");
  }
  if (!config.authToken) {
    throw new Error("Missing authToken. Use --auth or JROK_AUTH env var");
  }

  // Validate based on service type
  if (config.serviceType === 'port') {
    if (!config.port || config.port < 1 || config.port > 65535) {
      throw new Error("Invalid port number. Use --port (1-65535) or JROK_PORT");
    }
  } else if (config.serviceType === 'docker-swarm' || config.serviceType === 'kubernetes') {
    if (!config.serviceName) {
      throw new Error(`Missing service name. Use --${config.serviceType === 'docker-swarm' ? 'docker-service' : 'k8s-service'}`);
    }
  }
}

function validateBasicConfig(config: Partial<ClientConfig>): void {
  if (!config.serverUrl) {
    throw new Error("Missing serverUrl. Use --server or JROK_SERVER env var");
  }
  if (!config.authToken) {
    throw new Error("Missing authToken. Use --auth or JROK_AUTH env var");
  }
}

// Handle incoming HTTP request from server and proxy to local service
async function handleHttpRequest(message: any, ws: WebSocket, config: ClientConfig): Promise<void> {
  try {
    const { requestId, method, path, query, headers, body } = message;
    
    // Build URL to local service
    const localUrl = `http://${config.localHost}:${config.port}${path}${query || ''}`;
    
    console.log(`📥 ${method} ${path} → ${localUrl}`);
    
    // Forward request to local service
    const localResponse = await fetch(localUrl, {
      method,
      headers: headers || {},
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
    });
    
    // Read response
    const responseBody = await localResponse.text();
    const responseHeaders: Record<string, string> = {};
    localResponse.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Send response back to server
    ws.send(JSON.stringify({
      type: "http_response",
      requestId,
      status: localResponse.status,
      statusText: localResponse.statusText,
      headers: responseHeaders,
      body: responseBody,
    }));
    
    console.log(`📤 ${localResponse.status} ${localResponse.statusText}`);
  } catch (error) {
    console.error(`❌ Error forwarding request:`, error);
    
    // Send error response
    ws.send(JSON.stringify({
      type: "http_response",
      requestId: message.requestId,
      status: 502,
      statusText: "Bad Gateway",
      headers: { "Content-Type": "text/plain" },
      body: `Error connecting to local service: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }
}

async function connectAgent(config: ClientConfig): Promise<void> {
  const wsUrl = new URL(config.serverUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/ws/agent";
  wsUrl.searchParams.set("domain", config.domain);
  wsUrl.searchParams.set("serviceType", config.serviceType || 'port');
  wsUrl.searchParams.set("auth", config.authToken);

  // Set target based on service type
  if (config.serviceType === 'port') {
    wsUrl.searchParams.set("localPort", config.port!.toString());
    wsUrl.searchParams.set("localHost", config.localHost);
  } else if (config.serviceType === 'docker-swarm') {
    wsUrl.searchParams.set("dockerService", config.serviceName!);
  } else if (config.serviceType === 'kubernetes') {
    wsUrl.searchParams.set("k8sService", config.serviceName!);
  }

  const serviceDesc = config.serviceType === 'port' 
    ? `${config.localHost}:${config.port}`
    : config.serviceType === 'docker-swarm'
    ? `Docker Swarm: ${config.serviceName}`
    : `Kubernetes: ${config.serviceName}`;

  console.log(`\n🔌 Connecting to jrok server...`);
  console.log(`📍 Domain: ${config.domain}`);
  console.log(`🏠 Local Service: ${serviceDesc}`);
  console.log(`\n${config.serverUrl}\n`);

  const ws = new WebSocket(wsUrl.toString());
  let heartbeatInterval: NodeJS.Timeout;
  let reconnectAttempts = 0;

  ws.onopen = () => {
    reconnectAttempts = 0;
    console.log("✅ Connected to server!");
    console.log(`🌐 Your service is now available at: https://${config.domain}`);

    // Send heartbeat every 30 seconds
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 30000);
  };

  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data.toString());

      if (message.type === "welcome") {
        console.log(`✨ ${message.message}`);
        console.log(`🆔 Agent ID: ${message.agentId}`);
      } else if (message.type === "heartbeat_ack") {
        // Silent heartbeat acknowledgment
      } else if (message.type === "http_request") {
        // Handle incoming HTTP request from server
        await handleHttpRequest(message, ws, config);
      } else if (message.type === "status") {
        console.log(`📊 Status: ${message.message}`);
      } else {
        console.log(`📨 Server message:`, message);
      }
    } catch (error) {
      console.error("Failed to parse message:", error);
    }
  };

  ws.onerror = (error) => {
    console.error("❌ Connection error:", error);
  };

  ws.onclose = () => {
    clearInterval(heartbeatInterval);
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, 30000); // Max 30s delay
    
    console.log(`\n🔌 Disconnected from server`);
    console.log(`🔄 Attempting to reconnect in ${delay / 1000}s (attempt ${reconnectAttempts})...`);

    setTimeout(() => {
      connectAgent(config);
    }, delay);
  };
}

async function listServices(config: { serverUrl: string; authToken: string }): Promise<void> {
  try {
    const response = await fetch(`${config.serverUrl}/tunnels`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.authToken}`,
        'X-API-Key': config.authToken,
      },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const tunnels = data.tunnels || data || [];

    if (tunnels.length === 0) {
      console.log("📋 No active tunnels");
      console.log("💡 Create one with: jrok connect --domain myapp --port 3000");
      return;
    }

    console.log("\n📋 Active Tunnels:\n");
    console.log("Domain".padEnd(35), "Local".padEnd(20), "Status".padEnd(12), "Created");
    console.log("─".repeat(85));

    tunnels.forEach((tunnel: any) => {
      const status = tunnel.active ? "✅ Online" : "❌ Offline";
      const local = `${tunnel.localHost || 'localhost'}:${tunnel.localPort}`;
      const created = tunnel.createdAt ? new Date(tunnel.createdAt).toLocaleDateString() : 'N/A';
      console.log(
        (tunnel.domain || tunnel.subdomain || 'unknown').padEnd(35),
        local.padEnd(20),
        status.padEnd(12),
        created
      );
    });
    console.log("");
  } catch (error) {
    console.error("❌ Error listing tunnels:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function disconnectService(config: { serverUrl: string; domain: string; authToken: string }): Promise<void> {
  try {
    const response = await fetch(`${config.serverUrl}/tunnels/${config.domain}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${config.authToken}`,
        'X-API-Key': config.authToken,
      },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    console.log(`✅ Tunnel disconnected: ${config.domain}`);
  } catch (error) {
    console.error("❌ Error disconnecting tunnel:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ============== Organization Management ==============

async function listOrganizations(serverUrl: string, authToken: string): Promise<void> {
  try {
    const response = await fetch(`${serverUrl}/organizations`, {
      headers: { 
        'Authorization': `Bearer ${authToken}`,
        'X-API-Key': authToken,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || error.error || `API error: ${response.status}`);
    }

    const data = await response.json();
    const orgs = data.organizations || data || [];

    if (orgs.length === 0) {
      console.log("📋 No organizations found");
      console.log("💡 Create one at your dashboard or use: jrok org create --name 'My Org'");
      return;
    }

    console.log("\n📋 Your Organizations:\n");
    console.log("ID".padEnd(26), "Name".padEnd(25), "Slug".padEnd(20), "Role");
    console.log("─".repeat(85));

    orgs.forEach((org: any) => {
      console.log(
        (org.id || org._id).padEnd(26),
        org.name.slice(0, 24).padEnd(25),
        org.slug.slice(0, 19).padEnd(20),
        org.role || 'member'
      );
    });
    console.log("");
  } catch (error) {
    console.error("❌ Error listing organizations:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function createOrganization(serverUrl: string, authToken: string, name: string): Promise<void> {
  try {
    const response = await fetch(`${serverUrl}/organizations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-API-Key': authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || error.error || `API error: ${response.status}`);
    }

    const data = await response.json();
    const org = data.organization || data;
    console.log(`✅ Organization created: ${org.name}`);
    console.log(`🆔 ID: ${org.id || org._id}`);
    console.log(`🔗 Slug: ${org.slug}`);
    
    // Save to config
    const config = loadStoredConfig();
    config.organizationId = org.id || org._id;
    config.organizationName = org.name;
    saveStoredConfig(config);
    console.log(`💾 Set as default organization`);
  } catch (error) {
    console.error("❌ Error creating organization:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function setDefaultOrganization(orgId: string): Promise<void> {
  const config = loadStoredConfig();
  config.organizationId = orgId;
  saveStoredConfig(config);
  console.log(`✅ Default organization set to: ${orgId}`);
}

// ============== API Key Management ==============

async function listApiKeys(serverUrl: string, authToken: string, orgId: string): Promise<void> {
  try {
    const response = await fetch(`${serverUrl}/organizations/${orgId}/api-keys`, {
      headers: { 
        'Authorization': `Bearer ${authToken}`,
        'X-API-Key': authToken,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || error.error || `API error: ${response.status}`);
    }

    const data = await response.json();
    const keys = data.apiKeys || data || [];

    if (keys.length === 0) {
      console.log("🔑 No API keys found");
      console.log("💡 Create one with: jrok apikey create --name 'My Key' --org <org-id>");
      return;
    }

    console.log("\n🔑 API Keys:\n");
    console.log("ID".padEnd(26), "Prefix".padEnd(16), "Name".padEnd(20), "Permissions");
    console.log("─".repeat(85));

    keys.forEach((key: any) => {
      console.log(
        (key.id || key._id).padEnd(26),
        (key.keyPrefix || 'jrok_...').padEnd(16),
        key.name.slice(0, 19).padEnd(20),
        (key.permissions || []).join(', ').slice(0, 20)
      );
    });
    console.log("");
  } catch (error) {
    console.error("❌ Error listing API keys:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function createApiKey(
  serverUrl: string, 
  authToken: string, 
  orgId: string, 
  name: string,
  permissions: string[] = ['tunnel:create', 'tunnel:read', 'tunnel:delete']
): Promise<void> {
  try {
    const response = await fetch(`${serverUrl}/organizations/${orgId}/api-keys`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-API-Key': authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, permissions }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || error.error || `API error: ${response.status}`);
    }

    const data = await response.json();
    const rawKey = data.rawKey || data.key;
    
    console.log(`\n✅ API Key created: ${name}`);
    console.log(`\n⚠️  IMPORTANT: Save this key now! It will only be shown once.\n`);
    console.log(`🔑 API Key: ${rawKey}`);
    console.log(`\nTo use this key:`);
    console.log(`  jrok config --auth ${rawKey}`);
    console.log(`  # or`);
    console.log(`  export JROK_AUTH=${rawKey}`);
    console.log("");
  } catch (error) {
    console.error("❌ Error creating API key:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function revokeApiKey(serverUrl: string, authToken: string, orgId: string, keyId: string): Promise<void> {
  try {
    const response = await fetch(`${serverUrl}/organizations/${orgId}/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { 
        'Authorization': `Bearer ${authToken}`,
        'X-API-Key': authToken,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || error.error || `API error: ${response.status}`);
    }

    console.log(`✅ API key revoked: ${keyId}`);
  } catch (error) {
    console.error("❌ Error revoking API key:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ============== Config Management ==============

function showConfig(): void {
  const config = loadStoredConfig();
  
  console.log("\n⚙️  Current Configuration:\n");
  console.log(`Server URL:      ${config.serverUrl || '(not set)'}`);
  console.log(`API Key:         ${config.apiKey ? config.apiKey.slice(0, 15) + '...' : '(not set)'}`);
  console.log(`Organization ID: ${config.organizationId || '(not set)'}`);
  console.log(`Organization:    ${config.organizationName || '(not set)'}`);
  console.log(`\nConfig file: ${CONFIG_FILE}`);
  console.log("");
}

function setConfig(args: Record<string, string>): void {
  const config = loadStoredConfig();
  
  if (args.server) {
    config.serverUrl = args.server;
    console.log(`✅ Server URL set to: ${args.server}`);
  }
  if (args.auth) {
    config.apiKey = args.auth;
    console.log(`✅ API Key set: ${args.auth.slice(0, 15)}...`);
  }
  if (args.org) {
    config.organizationId = args.org;
    console.log(`✅ Organization ID set to: ${args.org}`);
  }
  
  saveStoredConfig(config);
}

function clearConfig(): void {
  saveStoredConfig({});
  console.log(`✅ Configuration cleared`);
}

// ============== Whoami ==============

async function whoami(serverUrl: string, authToken: string): Promise<void> {
  try {
    // Check if it's an API key or session token
    if (authToken.startsWith('jrok_')) {
      console.log("\n🔑 Using API Key authentication");
      console.log(`Key prefix: ${authToken.slice(0, 15)}...`);
      
      // Try to validate by making a request
      const response = await fetch(`${serverUrl}/organizations`, {
        headers: { 
          'Authorization': `Bearer ${authToken}`,
          'X-API-Key': authToken,
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        const orgs = data.organizations || data || [];
        console.log(`✅ API Key is valid`);
        console.log(`📋 Access to ${orgs.length} organization(s)`);
        if (orgs.length > 0) {
          console.log(`\nOrganizations:`);
          orgs.forEach((org: any) => {
            console.log(`  - ${org.name} (${org.slug})`);
          });
        }
      } else {
        console.log(`❌ API Key is invalid or expired`);
      }
    } else {
      // Session token - get user info
      const response = await fetch(`${serverUrl}/auth/me`, {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      
      if (!response.ok) {
        throw new Error('Invalid session token');
      }
      
      const data = await response.json();
      const user = data.user || data;
      console.log("\n👤 Current User:\n");
      console.log(`Name:   ${user.fullname || user.name}`);
      console.log(`Email:  ${user.email}`);
      console.log(`Role:   ${user.role}`);
      console.log(`Status: ${user.status}`);
      if (user.avatarUrl) {
        console.log(`Avatar: ${user.avatarUrl}`);
      }
    }
    console.log("");
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function showVersion(): void {
  console.log(`jrok v${VERSION}`);
  console.log(`Node ${process.version}`);
}

function showHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                   Jrok Agent Client v${VERSION}                   ║
║   Expose Local Services to Public Internet via Reverse Proxy         ║
╚══════════════════════════════════════════════════════════════════════╝

QUICK START:
  1. Get an API key from your dashboard
  2. jrok config --server https://tunnel.example.com --auth jrok_xxx
  3. jrok connect --domain myapp.example.com --port 3000

COMMANDS:
  connect              Connect a local service to public domain
  list                 List all connected services
  disconnect           Disconnect a service
  
  config               Show/set CLI configuration
  config --clear       Clear saved configuration
  
  org list             List your organizations
  org create           Create a new organization
  org use              Set default organization
  
  apikey list          List API keys for an organization
  apikey create        Create a new API key
  apikey revoke        Revoke an API key
  
  whoami               Show current user/API key info
  version              Show version information
  help                 Show this help message

CONFIG COMMANDS:
  jrok config                                    # Show current config
  jrok config --server https://...               # Set server URL
  jrok config --auth jrok_xxx                   # Set API key
  jrok config --org <org-id>                     # Set default organization
  jrok config --clear                            # Clear all saved config

ORGANIZATION COMMANDS:
  jrok org list                                  # List your organizations
  jrok org create --name "My Company"            # Create organization
  jrok org use --id <org-id>                     # Set default organization

API KEY COMMANDS:
  jrok apikey list --org <org-id>                # List API keys
  jrok apikey create --org <org-id> --name "CI"  # Create API key
  jrok apikey revoke --org <org-id> --id <key>   # Revoke API key

CONNECT EXAMPLES:
  # TCP Port (local dev server)
  jrok connect --domain dev.example.com --port 3000

  # Docker Swarm service
  jrok connect --domain api.example.com --docker-service my-api

  # Kubernetes service
  jrok connect --domain app.example.com --k8s-service my-svc:8080

OPTIONS:
  --server           Server URL (or use config/env)
  --auth             API key (or use config/env)
  --domain           Public domain name
  --port             Local port (default: 3000)
  --host             Local host (default: localhost)
  --docker-service   Docker Swarm service name
  --k8s-service      Kubernetes service:port
  --org              Organization ID
  --name             Name for org/apikey
  --id               ID for apikey operations

ENVIRONMENT VARIABLES:
  JROK_SERVER     Server URL
  JROK_AUTH       API key
  JROK_DOMAIN     Domain name
  JROK_PORT       Local port
  JROK_HOST       Local host

CONFIG FILE:
  ~/.jrok/config.json

For more info: https://github.com/koompi/jrok
`);
}

async function main(): Promise<void> {
  try {
    const { command, subcommand, args } = parseArgs();
    const storedConfig = loadStoredConfig();

    // Helper to get server URL and auth token
    const getServerAndAuth = () => {
      const serverUrl = args.server || process.env.JROK_SERVER || storedConfig.serverUrl;
      const authToken = args.auth || process.env.JROK_AUTH || storedConfig.apiKey;
      
      if (!serverUrl) {
        throw new Error("Missing server URL. Use --server, config, or JROK_SERVER env var");
      }
      if (!authToken) {
        throw new Error("Missing auth token. Use --auth, config, or JROK_AUTH env var");
      }
      
      return { serverUrl, authToken };
    };

    const getOrgId = () => {
      const orgId = args.org || storedConfig.organizationId;
      if (!orgId) {
        throw new Error("Missing organization ID. Use --org or set default with 'jrok org use --id <org-id>'");
      }
      return orgId;
    };

    switch (command) {
      case "connect": {
        const config = buildConfig(args);
        validateConnectConfig(config);
        await connectAgent(config);
        // Keep the process running
        await new Promise(() => {});
        break;
      }

      case "list": {
        const baseConfig = buildConfig(args);
        validateBasicConfig(baseConfig);
        await listServices({
          serverUrl: baseConfig.serverUrl!,
          authToken: baseConfig.authToken!,
        });
        break;
      }

      case "disconnect": {
        const baseConfig = buildConfig(args);
        validateBasicConfig(baseConfig);
        if (!baseConfig.domain) {
          throw new Error("Missing domain. Use --domain");
        }
        await disconnectService({
          serverUrl: baseConfig.serverUrl!,
          domain: baseConfig.domain,
          authToken: baseConfig.authToken!,
        });
        break;
      }

      case "config": {
        if (args.clear === 'true') {
          clearConfig();
        } else if (args.server || args.auth || args.org) {
          setConfig(args);
        } else {
          showConfig();
        }
        break;
      }

      case "org": {
        const { serverUrl, authToken } = getServerAndAuth();
        
        switch (subcommand) {
          case "list":
            await listOrganizations(serverUrl, authToken);
            break;
          case "create":
            if (!args.name) {
              throw new Error("Missing organization name. Use --name 'My Organization'");
            }
            await createOrganization(serverUrl, authToken, args.name);
            break;
          case "use":
            if (!args.id) {
              throw new Error("Missing organization ID. Use --id <org-id>");
            }
            await setDefaultOrganization(args.id);
            break;
          default:
            console.log("Usage: jrok org <list|create|use>");
            console.log("  list              List your organizations");
            console.log("  create --name     Create a new organization");
            console.log("  use --id          Set default organization");
        }
        break;
      }

      case "apikey": {
        const { serverUrl, authToken } = getServerAndAuth();
        const orgId = getOrgId();
        
        switch (subcommand) {
          case "list":
            await listApiKeys(serverUrl, authToken, orgId);
            break;
          case "create":
            if (!args.name) {
              throw new Error("Missing API key name. Use --name 'My Key'");
            }
            const permissions = args.permissions ? args.permissions.split(',') : undefined;
            await createApiKey(serverUrl, authToken, orgId, args.name, permissions);
            break;
          case "revoke":
            if (!args.id) {
              throw new Error("Missing API key ID. Use --id <key-id>");
            }
            await revokeApiKey(serverUrl, authToken, orgId, args.id);
            break;
          default:
            console.log("Usage: jrok apikey <list|create|revoke>");
            console.log("  list                  List API keys");
            console.log("  create --name         Create API key");
            console.log("  revoke --id           Revoke API key");
            console.log("\nOptions:");
            console.log("  --org <id>            Organization ID (or use default)");
            console.log("  --permissions <p1,p2> Comma-separated permissions");
        }
        break;
      }

      case "whoami": {
        const { serverUrl, authToken } = getServerAndAuth();
        await whoami(serverUrl, authToken);
        break;
      }

      case "version":
      case "--version":
      case "-v": {
        showVersion();
        break;
      }

      case "help":
      case "--help":
      case "-h": {
        showHelp();
        break;
      }

      default: {
        console.error(`❌ Unknown command: ${command}`);
        showHelp();
        process.exit(1);
      }
    }
  } catch (error) {
    console.error(
      "❌ Error:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

main();
