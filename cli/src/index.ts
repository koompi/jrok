#!/usr/bin/env node

/**
 * Jrok Agent Client - CLI Tool
 * 
 * Expose local services (Docker, Kubernetes, ports) to public internet via reverse proxy
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';

const VERSION = "2.4.0"; // Updated for TCP tunnel support (SSH, MongoDB, etc.)
const DEFAULT_SERVER = "https://tunnel.koompi.cloud";
const GITHUB_API = "https://api.github.com/repos/koompi/jrok";
const GITHUB_RAW = "https://raw.githubusercontent.com/koompi/jrok";
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Config file path
const CONFIG_DIR = join(homedir(), '.jrok');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

interface StoredConfig {
  serverUrl?: string;
  apiKey?: string;
  organizationId?: string;
  organizationName?: string;
  lastUpdateCheck?: number;
  skipUpdateCheck?: boolean;
}

interface ClientConfig {
  serverUrl: string;
  domain: string;
  port?: number;
  localHost: string;
  authToken: string;
  serviceType?: 'port' | 'docker-swarm' | 'kubernetes';
  serviceName?: string;
  protocol?: 'http' | 'tcp'; // 'http' for HTTP/HTTPS/WSS, 'tcp' for raw TCP (SSH, MongoDB, etc.)
  forceNew?: boolean; // Force creation of new subdomain even if same org owns it
  // Multi-agent load balancing options
  groupMode?: boolean; // Enable group mode for load-balanced multi-agent deployments
  instanceId?: string; // Unique instance identifier for this agent in the group
  // IP Security options
  ipSecurity?: {
    mode: 'allow-all' | 'allowlist' | 'blocklist';
    allowedIps?: string[];
    blockedIps?: string[];
  };
  organizationId?: string; // Organization ID for authorization
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

// Helper to prompt user for input
async function promptInput(question: string, isPassword = false): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Compare semantic versions
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

// Check for updates from GitHub releases
async function checkForUpdates(silent = false): Promise<{ hasUpdate: boolean; latestVersion?: string }> {
  try {
    const response = await fetch(`${GITHUB_API}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    });

    if (!response.ok) {
      if (!silent) console.log('⚠️  Could not check for updates');
      return { hasUpdate: false };
    }

    const data = await response.json();
    const latestVersion = data.tag_name.replace(/^v/, ''); // Remove 'v' prefix

    if (compareVersions(latestVersion, VERSION) > 0) {
      if (!silent) {
        console.log(`\n📦 Update available: ${VERSION} → ${latestVersion}`);
        console.log(`   Run 'jrok doctor' to update\n`);
      }
      return { hasUpdate: true, latestVersion };
    }

    if (!silent) {
      console.log('✅ You are using the latest version');
    }
    return { hasUpdate: false };
  } catch (error) {
    if (!silent) {
      console.log('⚠️  Could not check for updates:', error instanceof Error ? error.message : error);
    }
    return { hasUpdate: false };
  }
}

// Auto-check for updates on startup (if not checked recently)
async function autoCheckForUpdates(): Promise<void> {
  const config = loadStoredConfig();

  // Skip if user disabled it or checked recently
  if (config.skipUpdateCheck) return;

  const now = Date.now();
  const lastCheck = config.lastUpdateCheck || 0;

  if (now - lastCheck < UPDATE_CHECK_INTERVAL) return;

  // Update last check time
  config.lastUpdateCheck = now;
  saveStoredConfig(config);

  // Check for updates silently
  await checkForUpdates(true);
}

// Generate a short UUID for subdomain
function generateSubdomain(): string {
  return randomUUID().split('-')[0]; // Use first segment (8 chars)
}

// Extract base domain from server URL
function getBaseDomain(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    return url.hostname;
  } catch {
    return 'tunnel.koompi.cloud';
  }
}

function parseArgs(): { command: string; subcommand?: string; args: Record<string, string> } {
  const argv = process.argv.slice(2);
  let command = argv[0]?.toLowerCase() || 'help';
  let subcommand: string | undefined;
  const args: Record<string, string> = {};

  let startIndex = 1;

  // Check if first arg is --port (shorthand for connect)
  if (command === '--port' || command === '-p') {
    command = 'connect';
    startIndex = 0; // Process all args including --port
  } else if (command.startsWith('--')) {
    // Any flag as first argument means implicit connect
    command = 'connect';
    startIndex = 0;
  } else {
    // Check for subcommand (e.g., 'org list', 'apikey create')
    if (argv[1] && !argv[1].startsWith('--')) {
      subcommand = argv[1].toLowerCase();
      startIndex = 2;
    }
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
    } else if (arg === '-p' && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      // Support -p as shorthand for --port
      args['port'] = argv[i + 1];
      i++;
    }
  }

  return { command, subcommand, args };
}

function buildConfig(args: Record<string, string>): Partial<ClientConfig> {
  const storedConfig = loadStoredConfig();
  const serviceType = args['docker-service'] ? 'docker-swarm' :
    args['k8s-service'] ? 'kubernetes' :
      'port';

  // Check if TCP protocol is requested
  const isTcp = args['tcp'] === 'true' || args['tcp'] === '' || process.env.JROK_PROTOCOL === 'tcp';

  // Check if force-new is requested (always create new subdomain)
  const forceNew = args['force-new'] === 'true' || args['force-new'] === '' || args['new'] === 'true' || args['new'] === '';

  // Check if group mode is requested (multi-agent load balancing)
  const groupMode = args['group'] === 'true' || args['group'] === '' || process.env.JROK_GROUP_MODE === 'true';
  const instanceId = args['instance-id'] || process.env.JROK_INSTANCE_ID;

  // Parse IP security options
  let ipSecurity: ClientConfig['ipSecurity'] | undefined;

  // --restrict flag: enable allowlist mode (only specified IPs can access)
  if (args['restrict'] === 'true' || args['restrict'] === '') {
    ipSecurity = { mode: 'allowlist', allowedIps: [] };
  }

  // --allow-ip: specify IPs for allowlist (implies allowlist mode)
  if (args['allow-ip']) {
    const allowedIps = args['allow-ip'].split(',').map(ip => ip.trim()).filter(ip => ip);
    ipSecurity = { mode: 'allowlist', allowedIps };
  }

  // --block-ip: specify IPs for blocklist (implies blocklist mode)
  if (args['block-ip']) {
    const blockedIps = args['block-ip'].split(',').map(ip => ip.trim()).filter(ip => ip);
    ipSecurity = { mode: 'blocklist', blockedIps };
  }

  return {
    serverUrl: args["server"] || process.env.JROK_SERVER || storedConfig.serverUrl || DEFAULT_SERVER,
    domain: args["domain"] || process.env.JROK_DOMAIN,
    port: args["port"] ? parseInt(args["port"]) :
      process.env.JROK_PORT ? parseInt(process.env.JROK_PORT) :
        serviceType === 'port' ? 3000 : undefined,
    localHost: args["host"] || process.env.JROK_HOST || "localhost",
    authToken: args["auth"] || process.env.JROK_AUTH || storedConfig.apiKey,
    serviceType: serviceType as 'port' | 'docker-swarm' | 'kubernetes',
    serviceName: args["docker-service"] || args["k8s-service"] || process.env.JROK_SERVICE,
    protocol: isTcp ? 'tcp' : 'http',
    forceNew,
    groupMode,
    instanceId,
    ipSecurity,
    organizationId: args["org"] || storedConfig.organizationId,
  };
}

function validateConnectConfig(config: Partial<ClientConfig>): asserts config is ClientConfig {
  if (!config.serverUrl) {
    throw new Error("Missing serverUrl. Use --server or JROK_SERVER env var");
  }
  // Domain is now optional - will auto-generate if not provided
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

// Module-level constant — created once, not on every HTTP request
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'content-length', // Let fetch handle this
]);

// Handle incoming HTTP request from server and proxy to local service
async function handleHttpRequest(message: any, ws: WebSocket, config: ClientConfig): Promise<void> {
  try {
    const { requestId, method, path, query, headers, body, clientIp } = message;

    // Build URL to local service
    const localUrl = `http://${config.localHost}:${config.port}${path}${query || ''}`;

    console.log(`📥 ${method} ${path} → ${localUrl} [${clientIp || 'unknown'}]`);

    // Filter out hop-by-hop headers that shouldn't be forwarded
    const forwardHeaders: Record<string, string> = {};

    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
          forwardHeaders[key] = value as string;
        }
      }
    }

    // Forward request to local service
    const localResponse = await fetch(localUrl, {
      method,
      headers: forwardHeaders,
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
      redirect: 'manual', // Don't follow redirects automatically
    });

    // Read response - use ArrayBuffer for binary content
    const responseBuffer = await localResponse.arrayBuffer();
    const responseBody = Buffer.from(responseBuffer).toString('base64');
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
      isBase64: true,
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

// Store active WebSocket connections to local services
const localWsConnections = new Map<string, WebSocket>();

// Handle WebSocket connection request from server
async function handleWsConnect(message: any, serverWs: WebSocket, config: ClientConfig): Promise<void> {
  const { wsId, path, headers } = message;

  // Build WebSocket URL to local service
  const wsUrl = `ws://${config.localHost}:${config.port}${path || '/'}`;

  console.log(`🔌 WS Connect: ${path} → ${wsUrl} [${wsId}]`);

  try {
    // Create WebSocket connection to local service
    const localWs = new WebSocket(wsUrl, {
      headers: headers || {},
    });

    localWs.on('open', () => {
      console.log(`✅ WS Connected: ${path} [${wsId}]`);
      localWsConnections.set(wsId, localWs);
    });

    localWs.on('message', (data: Buffer | string) => {
      // Forward message from local service to server
      const isBinary = Buffer.isBuffer(data);
      serverWs.send(JSON.stringify({
        type: "ws_message_response",
        wsId,
        data: isBinary ? data.toString('base64') : data.toString(),
        isBinary,
      }));
    });

    localWs.on('close', (code: number, reason: Buffer) => {
      console.log(`🔌 WS Closed: ${path} [${wsId}] (${code})`);
      localWsConnections.delete(wsId);

      // Notify server about close
      serverWs.send(JSON.stringify({
        type: "ws_close_response",
        wsId,
        code,
        reason: reason?.toString() || '',
      }));
    });

    localWs.on('error', (error: Error) => {
      console.error(`❌ WS Error: ${path} [${wsId}]:`, error.message);
      localWsConnections.delete(wsId);

      // Notify server about error
      serverWs.send(JSON.stringify({
        type: "ws_error",
        wsId,
        error: error.message,
      }));
    });
  } catch (error) {
    console.error(`❌ Failed to connect WebSocket [${wsId}]:`, error);

    // Notify server about error
    serverWs.send(JSON.stringify({
      type: "ws_error",
      wsId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

// Handle WebSocket message from server (forward to local service)
function handleWsMessage(message: any): void {
  const { wsId, data, isBinary } = message;
  const localWs = localWsConnections.get(wsId);

  if (!localWs || localWs.readyState !== WebSocket.OPEN) {
    console.warn(`⚠️ No active WebSocket for [${wsId}]`);
    return;
  }

  try {
    // Decode and forward message to local service
    const payload = isBinary ? Buffer.from(data, 'base64') : data;
    localWs.send(payload);
  } catch (error) {
    console.error(`❌ Error forwarding WS message [${wsId}]:`, error);
  }
}

// Handle WebSocket close request from server
function handleWsClose(message: any): void {
  const { wsId, code, reason } = message;
  const localWs = localWsConnections.get(wsId);

  if (localWs) {
    console.log(`🔌 WS Close request: [${wsId}]`);
    localWs.close(code || 1000, reason || '');
    localWsConnections.delete(wsId);
  }
}

// ============ TCP Tunnel Handlers ============
import * as net from 'net';

// Store active TCP connections to local services
const localTcpConnections = new Map<string, net.Socket>();

// Handle TCP connection request from server
async function handleTcpConnect(message: any, serverWs: WebSocket, config: ClientConfig): Promise<void> {
  const { connectionId, localPort, localHost, remoteAddress, remotePort } = message;

  console.log(`🔌 TCP Connect: ${remoteAddress}:${remotePort} → ${localHost}:${localPort} [${connectionId}]`);

  try {
    // Create TCP connection to local service
    const localSocket = net.createConnection({
      host: localHost || config.localHost,
      port: localPort || config.port,
    });

    localSocket.on('connect', () => {
      console.log(`✅ TCP Connected: ${localHost}:${localPort} [${connectionId}]`);
      localTcpConnections.set(connectionId, localSocket);

      // Notify server that we're connected
      serverWs.send(JSON.stringify({
        type: "tcp_connected",
        connectionId,
      }));
    });

    localSocket.on('data', (data: Buffer) => {
      // Forward data from local service to server
      serverWs.send(JSON.stringify({
        type: "tcp_data_response",
        connectionId,
        data: data.toString('base64'),
      }));
    });

    localSocket.on('close', () => {
      console.log(`🔌 TCP Closed: ${localHost}:${localPort} [${connectionId}]`);
      localTcpConnections.delete(connectionId);

      // Notify server about close
      serverWs.send(JSON.stringify({
        type: "tcp_close_response",
        connectionId,
      }));
    });

    localSocket.on('error', (error: Error) => {
      console.error(`❌ TCP Error: ${localHost}:${localPort} [${connectionId}]:`, error.message);
      localTcpConnections.delete(connectionId);

      // Notify server about error
      serverWs.send(JSON.stringify({
        type: "tcp_error",
        connectionId,
        error: error.message,
      }));
    });
  } catch (error) {
    console.error(`❌ Failed to connect TCP [${connectionId}]:`, error);

    // Notify server about error
    serverWs.send(JSON.stringify({
      type: "tcp_error",
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

// Handle TCP data from server (forward to local service)
function handleTcpData(message: any, serverWs: WebSocket): void {
  const { connectionId, data } = message;
  const localSocket = localTcpConnections.get(connectionId);

  if (!localSocket) {
    console.warn(`⚠️ No active TCP connection for [${connectionId}]`);
    return;
  }

  try {
    // Decode and forward data to local service
    const buffer = Buffer.from(data, 'base64');
    localSocket.write(buffer);
  } catch (error) {
    console.error(`❌ Error forwarding TCP data [${connectionId}]:`, error);
  }
}

// Handle TCP close request from server
function handleTcpClose(message: any): void {
  const { connectionId } = message;
  const localSocket = localTcpConnections.get(connectionId);

  if (localSocket) {
    console.log(`🔌 TCP Close request: [${connectionId}]`);
    localSocket.end();
    localTcpConnections.delete(connectionId);
  }
}

async function connectAgent(config: ClientConfig): Promise<void> {
  const baseDomain = getBaseDomain(config.serverUrl);
  const fullDomain = `${config.domain}.${baseDomain}`;
  const protocol = config.protocol || 'http';

  const wsUrl = new URL(config.serverUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/ws/agent";
  wsUrl.searchParams.set("domain", config.domain);
  wsUrl.searchParams.set("serviceType", config.serviceType || 'port');
  wsUrl.searchParams.set("auth", config.authToken);
  wsUrl.searchParams.set("protocol", protocol);
  if (config.organizationId) {
    wsUrl.searchParams.set("organizationId", config.organizationId);
  }
  if (config.forceNew) {
    wsUrl.searchParams.set("forceNew", "true");
  }

  // Multi-agent group mode settings
  if (config.groupMode) {
    wsUrl.searchParams.set("groupMode", "true");
    if (config.instanceId) {
      wsUrl.searchParams.set("instanceId", config.instanceId);
    }
  }

  // IP Security settings
  if (config.ipSecurity) {
    wsUrl.searchParams.set("ipSecurityMode", config.ipSecurity.mode);
    if (config.ipSecurity.allowedIps && config.ipSecurity.allowedIps.length > 0) {
      wsUrl.searchParams.set("allowedIps", config.ipSecurity.allowedIps.join(','));
    }
    if (config.ipSecurity.blockedIps && config.ipSecurity.blockedIps.length > 0) {
      wsUrl.searchParams.set("blockedIps", config.ipSecurity.blockedIps.join(','));
    }
  }

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
  console.log(`📡 Protocol: ${protocol.toUpperCase()}`);
  if (config.groupMode) {
    console.log(`⚖️  Mode: Load-balanced Group${config.instanceId ? ` (instance: ${config.instanceId})` : ''}`);
  }
  console.log(`\n${config.serverUrl}\n`);

  const ws = new WebSocket(wsUrl.toString(), {
    // Enable WebSocket-level ping/pong for better connection stability
    // This helps keep connections alive through proxies and load balancers
  });
  let heartbeatInterval: NodeJS.Timeout;
  let pingInterval: NodeJS.Timeout;
  let reconnectAttempts = 0;

  // Store TCP port when received from server
  let tcpPort: number | null = null;

  ws.onopen = () => {
    reconnectAttempts = 0;
    console.log("✅ Connected to server!");

    if (protocol === 'http') {
      console.log(`🌐 Your service is now available at: https://${fullDomain}`);
    } else {
      console.log(`🔌 TCP tunnel connecting... (port will be assigned)`);
    }

    // Send heartbeat every 15 seconds (more frequent to prevent idle disconnects)
    // This gives better resilience against network issues and idle connection drops
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === 1) {  // WebSocket.OPEN = 1
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 15000);

    // Send WebSocket ping every 30 seconds for connection keepalive
    // This helps with proxies that drop idle WebSocket connections
    pingInterval = setInterval(() => {
      if (ws.readyState === 1) {  // WebSocket.OPEN = 1
        ws.ping();
      }
    }, 30000);
  };

  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data.toString());

      if (message.type === "welcome") {
        console.log(`✨ ${message.message}`);
        console.log(`🆔 Agent ID: ${message.agentId}`);

        // Check if domain was modified due to conflict
        if (message.domainModified && message.domain) {
          console.log(`\n⚠️  Requested subdomain "${message.requestedDomain}" was taken`);
          console.log(`📛 Using "${message.domain}" instead`);
          // Update the displayed URL with actual domain
          const actualFullDomain = `${message.domain}.${baseDomain}`;
          if (protocol === 'http') {
            console.log(`🌐 Your service is available at: https://${actualFullDomain}`);
          }
        }

        // Display group mode info
        if (message.groupMode) {
          console.log(`\n⚖️  Group Mode: Active`);
          console.log(`   📦 Instance ID: ${message.instanceId}`);
          console.log(`   👥 Group Members: ${message.groupMemberCount}`);
          console.log(`   🔄 Load Balancing: Round-robin`);
        }

        // Display IP security status if enabled
        if (message.ipSecurity) {
          console.log(`\n🔐 IP Security: ${message.ipSecurity.mode}`);
          if (message.ipSecurity.mode === 'allowlist') {
            console.log(`   ✅ Only ${message.ipSecurity.allowedIps} allowed IPs can access`);
          } else if (message.ipSecurity.mode === 'blocklist') {
            console.log(`   🚫 ${message.ipSecurity.blockedIps} IPs are blocked`);
          }
        }

        // For TCP tunnels, display the assigned port
        if (message.tcpPort) {
          tcpPort = message.tcpPort;
          const serverHost = new URL(config.serverUrl).hostname;
          const actualDomain = message.domain || config.domain;
          console.log(`\n🚀 TCP tunnel ready!`);
          console.log(`📡 Connect to: ${serverHost}:${tcpPort}`);
          console.log(`   Example: ssh user@${serverHost} -p ${tcpPort}`);
          console.log(`   Example: mongo --host ${serverHost} --port ${tcpPort}`);
        }
      } else if (message.type === "heartbeat_ack") {
        // Silent heartbeat acknowledgment
      } else if (message.type === "http_request") {
        // Handle incoming HTTP request from server
        await handleHttpRequest(message, ws, config);
      } else if (message.type === "ws_connect") {
        // Handle WebSocket connection request from server
        await handleWsConnect(message, ws, config);
      } else if (message.type === "ws_message") {
        // Handle WebSocket message from server (forward to local)
        handleWsMessage(message);
      } else if (message.type === "ws_close") {
        // Handle WebSocket close request from server
        handleWsClose(message);
      } else if (message.type === "tcp_connect") {
        // Handle TCP connection request from server
        await handleTcpConnect(message, ws, config);
      } else if (message.type === "tcp_data") {
        // Handle TCP data from server (forward to local)
        handleTcpData(message, ws);
      } else if (message.type === "tcp_close") {
        // Handle TCP close request from server
        handleTcpClose(message);
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
    clearInterval(pingInterval);
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, 30000); // Max 30s delay

    // Close all local WebSocket connections
    for (const [wsId, localWs] of localWsConnections.entries()) {
      try {
        localWs.close(1001, 'Server disconnected');
      } catch (e) {
        // Ignore close errors
      }
    }
    localWsConnections.clear();

    console.log(`\n🔌 Disconnected from server`);
    console.log(`🔄 Attempting to reconnect in ${delay / 1000}s (attempt ${reconnectAttempts})...`);

    setTimeout(() => {
      connectAgent(config);
    }, delay);
  };
}

async function listServices(config: { serverUrl: string; authToken: string }): Promise<void> {
  try {
    const baseDomain = getBaseDomain(config.serverUrl);

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
      console.log("💡 Create one with: jrok --port 3000");
      return;
    }

    console.log("\n📋 Active Tunnels:\n");
    console.log("Domain".padEnd(45), "Local".padEnd(20), "Status".padEnd(12), "Created");
    console.log("─".repeat(95));

    tunnels.forEach((tunnel: any) => {
      const status = tunnel.active ? "✅ Online" : "❌ Offline";
      const local = `${tunnel.localHost || 'localhost'}:${tunnel.localPort}`;
      const created = tunnel.createdAt ? new Date(tunnel.createdAt).toLocaleDateString() : 'N/A';
      const subdomain = tunnel.domain || tunnel.subdomain || 'unknown';
      const fullDomain = subdomain.includes('.') ? subdomain : `${subdomain}.${baseDomain}`;
      console.log(
        fullDomain.padEnd(45),
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

// ============== Custom Domain Management ==============

async function registerCustomDomain(
  serverUrl: string,
  authToken: string,
  domainName: string,
  email: string,
  subdomain?: string
): Promise<void> {
  try {
    const response = await fetch(`${serverUrl}/domains`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-API-Key': authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        domain: domainName,
        certbotEmail: email,
        subdomain,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || error.error || `API error: ${response.status}`);
    }

    const data = await response.json();
    const domain = data.domain || data;
    const cnameTarget = domain.cnameTarget || domain.targetSubdomain + '.tunnel.koompi.cloud';
    const verificationToken = domain.verificationToken;

    // Check if this is an apex domain (e.g., example.com vs www.example.com)
    const parts = domainName.split('.');
    const isApex = parts.length <= 2 || (parts.length === 3 && parts[1].length <= 3);

    console.log(`\n✅ Custom domain registered: ${domainName}\n`);

    if (isApex) {
      console.log(`📝 APEX DOMAIN DETECTED - TXT record verification required\n`);
      console.log(`   Add these DNS records:\n`);
      console.log(`   1. TXT record (for verification):`);
      console.log(`      ${domainName}  TXT  jrok-verify=${verificationToken}\n`);
      console.log(`   2. A record (for traffic - get IP from your tunnel server):\n`);
    } else {
      console.log(`📝 NEXT STEP: Add one of these DNS records:\n`);
      if (verificationToken) {
        console.log(`   Option A - TXT record (recommended):`);
        console.log(`      ${domainName}  TXT  jrok-verify=${verificationToken}\n`);
      }
      console.log(`   Option B - CNAME record:`);
      console.log(`      ${domainName}  CNAME  ${cnameTarget}\n`);
    }

    console.log(`After adding the DNS record, verify with:`);
    console.log(`   jrok domain status --name ${domainName}`);
    console.log(`   jrok domain verify --name ${domainName}`);
  } catch (error) {
    console.error("❌ Error registering domain:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function checkDomainStatus(serverUrl: string, authToken: string, domainName: string): Promise<void> {
  try {
    const response = await fetch(`${serverUrl}/domains/${encodeURIComponent(domainName)}/verify-status`, {
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

    console.log(`\n📋 Verification Status for ${domainName}:\n`);

    // TXT Status
    if (data.txtVerified !== undefined || data.verificationToken) {
      console.log(`   TXT Record:`);
      console.log(`     Expected: jrok-verify=${data.verificationToken || '(token)'}`);
      console.log(`     Verified: ${data.txtVerified ? '✅ Yes' : '❌ No'}`);
    }

    // CNAME Status
    console.log(`   CNAME Record:`);
    console.log(`     Expected: ${data.cnameTarget}`);
    console.log(`     Actual:   ${data.actualCname || '(none found)'}`);
    console.log(`     Verified: ${data.cnameVerified || data.verified ? '✅ Yes' : '❌ No'}`);

    const isVerified = data.txtVerified || data.cnameVerified || data.verified;

    if (!isVerified) {
      // Check if apex domain
      const parts = domainName.split('.');
      const isApex = parts.length <= 2 || (parts.length === 3 && parts[1].length <= 3);

      console.log(`\n💡 Add one of these DNS records:`);
      if (data.verificationToken) {
        console.log(`\n   TXT record${isApex ? ' (required for apex domains)' : ''}:`);
        console.log(`      ${domainName}  TXT  jrok-verify=${data.verificationToken}`);
      }
      if (!isApex) {
        console.log(`\n   CNAME record (subdomains only):`);
        console.log(`      ${domainName}  CNAME  ${data.cnameTarget}`);
      }
      if (data.error) {
        console.log(`\n   Error: ${data.error}`);
      }
    } else {
      console.log(`\n🎉 Domain verification passed!`);
      console.log(`   Run: jrok domain verify --name ${domainName}`);
    }
  } catch (error) {
    console.error("❌ Error checking domain status:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function verifyCustomDomain(serverUrl: string, authToken: string, domainName: string): Promise<void> {
  try {
    console.log(`\n🔍 Verifying domain ${domainName}...`);

    const response = await fetch(`${serverUrl}/domains/${encodeURIComponent(domainName)}/verify`, {
      method: 'POST',
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
    const domain = data.domain || data;

    console.log(`\n✅ Domain verified and certificate issued!\n`);
    console.log(`   Domain: ${domain.domain}`);
    console.log(`   Active: ${domain.active ? '✅' : '❌'}`);
    console.log(`   Synced: ${domain.synced ? '✅' : '❌'}`);
    if (domain.certExpiry) {
      console.log(`   Certificate expires: ${new Date(domain.certExpiry).toLocaleDateString()}`);
    }
    console.log(`\n🎉 Your custom domain is now ready to use!`);
  } catch (error) {
    console.error("❌ Error verifying domain:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function listCustomDomains(serverUrl: string, authToken: string): Promise<void> {
  try {
    const response = await fetch(`${serverUrl}/domains`, {
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
    const domains = data.domains || data || [];

    if (domains.length === 0) {
      console.log("\n📋 No custom domains registered\n");
      console.log("💡 Register one with: jrok domain register --name example.com --email you@email.com");
      return;
    }

    console.log("\n📋 Custom Domains:\n");
    console.log("Domain".padEnd(30), "CNAME Target".padEnd(35), "Status".padEnd(15), "SSL");
    console.log("─".repeat(95));

    domains.forEach((d: any) => {
      const status = d.cnameVerified ? (d.active ? 'Active' : 'Pending SSL') : 'Awaiting CNAME';
      const ssl = d.active && d.synced ? '✅' : '❌';
      console.log(
        d.domain.slice(0, 29).padEnd(30),
        (d.cnameTarget || '-').slice(0, 34).padEnd(35),
        status.padEnd(15),
        ssl
      );
    });
    console.log("");
  } catch (error) {
    console.error("❌ Error listing domains:", error instanceof Error ? error.message : error);
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
  jrok --port 3000                               # That's it! 🚀
  
  First time? You'll be prompted for your API key.
  Get one from: ${DEFAULT_SERVER}

SIMPLE USAGE:
  jrok --port 3000                    # Expose localhost:3000 (auto subdomain)
  jrok --port 8080                    # Expose localhost:8080 (auto subdomain)
  jrok --port 3000 --domain myapp     # Expose as myapp.tunnel.koompi.cloud

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
  
  domain register      Register a custom domain (e.g., mysite.com)
  domain verify        Verify CNAME and issue SSL certificate
  domain status        Check CNAME verification status
  domain list          List all custom domains
  
  doctor               Check for updates and system health
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

CUSTOM DOMAIN COMMANDS:
  jrok domain register --name mysite.com --email me@email.com
  jrok domain status --name mysite.com           # Check CNAME
  jrok domain verify --name mysite.com           # Verify & issue SSL
  jrok domain list                               # List all domains

CONNECT EXAMPLES:
  # Quick start - HTTP/HTTPS tunnel (auto subdomain)
  jrok --port 3000
  
  # With custom subdomain
  jrok --port 3000 --domain myapp

  # Force new subdomain (creates myapp-a7b3 if myapp exists)
  jrok --port 3000 --domain myapp --force-new

  # TCP tunnel for SSH access
  jrok --tcp --port 22 --domain ssh-server
  
  # TCP tunnel for MongoDB
  jrok --tcp --port 27017 --domain mongodb
  
  # TCP tunnel for Redis
  jrok --tcp --port 6379 --domain redis

  # Docker Swarm service
  jrok connect --domain api --docker-service my-api

  # Kubernetes service
  jrok connect --domain app --k8s-service my-svc:8080

IP SECURITY EXAMPLES:
  # Restrict access to specific IPs only (internal tools)
  jrok --port 3000 --allow-ip 192.168.1.0/24,10.0.0.5
  
  # Block specific IPs
  jrok --port 8080 --block-ip 1.2.3.4,5.6.7.8
  
  # Enable restrict mode (no IPs allowed until you add them via dashboard)
  jrok --port 3000 --restrict
  
  # Combine with TCP tunnels for secure internal services
  jrok --tcp --port 22 --allow-ip 10.0.0.0/8 --domain ssh-internal
  jrok --tcp --port 27017 --allow-ip 192.168.1.100 --domain mongodb-prod

MULTI-AGENT LOAD BALANCING (for container deployments):
  # Start multiple agents with the same domain - traffic is load-balanced
  
  # Instance 1 (container 1)
  jrok --port 3000 --domain myapp --group --instance-id container-1
  
  # Instance 2 (container 2)
  jrok --port 3000 --domain myapp --group --instance-id container-2
  
  # Instance 3 (container 3)
  jrok --port 3000 --domain myapp --group --instance-id container-3
  
  # All instances share the same URL: https://myapp.tunnel.koompi.cloud
  # Requests are automatically distributed across all running instances

OPTIONS:
  --server           Server URL (default: ${DEFAULT_SERVER})
  --auth             API key (or use config/env)
  --domain           Subdomain (optional, auto-generated if not provided)
  --port             Local port (default: 3000)
  --host             Local host (default: localhost)
  --tcp              Enable TCP tunneling (for SSH, MongoDB, etc.)
  --force-new        Force new subdomain (add suffix even if you own the domain)
  --group            Enable group mode for load-balanced multi-agent deployments
  --instance-id      Unique instance identifier (auto-generated if not provided)
  --docker-service   Docker Swarm service name
  --k8s-service      Kubernetes service:port
  --org              Organization ID
  --name             Name for org/apikey/domain
  --email            Email for SSL certificate
  --subdomain        Custom subdomain for domain mapping
  --id               ID for apikey operations
  
  # IP Security Options
  --allow-ip         Comma-separated list of allowed IPs/CIDRs (enables allowlist mode)
  --block-ip         Comma-separated list of blocked IPs/CIDRs (enables blocklist mode)
  --restrict         Enable allowlist mode with empty list (blocks all until IPs added)

ENVIRONMENT VARIABLES:
  JROK_SERVER        Server URL (default: ${DEFAULT_SERVER})
  JROK_AUTH          API key
  JROK_DOMAIN        Subdomain
  JROK_PORT          Local port
  JROK_HOST          Local host
  JROK_GROUP_MODE    Enable group mode (true/false)
  JROK_INSTANCE_ID   Instance identifier for group mode

CONFIG FILE:
  ~/.jrok/config.json

For more info: https://github.com/koompi/jrok
`);
}

async function main(): Promise<void> {
  try {
    const { command, subcommand, args } = parseArgs();

    // Auto-check for updates on startup (skip for non-interactive commands)
    if (!['version', 'help', '--version', '-v', '--help', '-h'].includes(command)) {
      await autoCheckForUpdates();
    }
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

        // If no auth token, prompt for it
        if (!config.authToken) {
          console.log(`\n🔐 No API key configured.`);
          console.log(`   Get one from your dashboard at ${config.serverUrl || DEFAULT_SERVER}\n`);
          const authToken = await promptInput('Enter your API key: ');
          if (!authToken) {
            console.error('❌ API key is required');
            process.exit(1);
          }
          config.authToken = authToken;

          // Save for future use
          const storedCfg = loadStoredConfig();
          storedCfg.apiKey = authToken;
          if (!storedCfg.serverUrl) {
            storedCfg.serverUrl = config.serverUrl || DEFAULT_SERVER;
          }
          saveStoredConfig(storedCfg);
          console.log(`💾 Configuration saved to ${CONFIG_FILE}\n`);
        }

        // Auto-generate domain if not provided
        if (!config.domain) {
          config.domain = generateSubdomain();
          console.log(`🎲 Generated subdomain: ${config.domain}`);
        }

        validateConnectConfig(config);
        await connectAgent(config);
        // Keep the process running
        await new Promise(() => { });
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

      case "domain": {
        const { serverUrl, authToken } = getServerAndAuth();

        switch (subcommand) {
          case "register": {
            if (!args.name) {
              throw new Error("Missing domain name. Use --name example.com");
            }
            if (!args.email) {
              throw new Error("Missing certbot email. Use --email you@example.com");
            }
            await registerCustomDomain(serverUrl, authToken, args.name, args.email, args.subdomain);
            break;
          }
          case "verify": {
            if (!args.name) {
              throw new Error("Missing domain name. Use --name example.com");
            }
            await verifyCustomDomain(serverUrl, authToken, args.name);
            break;
          }
          case "status": {
            if (!args.name) {
              throw new Error("Missing domain name. Use --name example.com");
            }
            await checkDomainStatus(serverUrl, authToken, args.name);
            break;
          }
          case "list": {
            await listCustomDomains(serverUrl, authToken);
            break;
          }
          default:
            console.log("Usage: jrok domain <register|verify|status|list>");
            console.log("");
            console.log("Custom Domain Management:");
            console.log("  register --name <domain> --email <email>  Register a custom domain");
            console.log("  verify --name <domain>                     Verify CNAME and issue certificate");
            console.log("  status --name <domain>                     Check CNAME verification status");
            console.log("  list                                       List all custom domains");
            console.log("");
            console.log("Options:");
            console.log("  --name <domain>       Domain name (e.g., example.com)");
            console.log("  --email <email>       Email for SSL certificate");
            console.log("  --subdomain <name>    Custom subdomain to map to (optional)");
            console.log("");
            console.log("Example flow:");
            console.log("  1. jrok domain register --name mysite.com --email me@email.com");
            console.log("  2. Add CNAME record: mysite.com -> mysite-com.tunnel.koompi.cloud");
            console.log("  3. jrok domain status --name mysite.com   # Check CNAME");
            console.log("  4. jrok domain verify --name mysite.com   # Issue certificate");
        }
        break;
      }

      case "doctor": {
        console.log('🏥 Running jrok health check...\n');
        console.log(`📌 Current version: ${VERSION}`);

        // Check for updates
        const { hasUpdate, latestVersion } = await checkForUpdates(false);

        if (hasUpdate) {
          console.log(`\n🔄 To update to v${latestVersion}, run:`);
          console.log(`   curl -fsSL ${GITHUB_RAW}/v${latestVersion}/install.sh | bash`);

          // Prompt for auto-update
          const answer = await promptInput('\n🚀 Would you like to update now? (y/n): ');
          if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
            console.log('\n📦 Updating jrok...');
            const { execSync } = require('child_process');
            try {
              const installCmd = `curl -fsSL ${GITHUB_RAW}/v${latestVersion}/install.sh | bash`;
              execSync(installCmd, { stdio: 'inherit', shell: '/bin/bash' });
              console.log('\n✅ Update complete! Please restart your terminal.');
            } catch (error) {
              console.error('\n❌ Update failed. Please try manually:');
              console.error(`   curl -fsSL ${GITHUB_RAW}/v${latestVersion}/install.sh | bash`);
            }
          }
        }

        // Check config
        console.log('\n📝 Configuration:');
        const config = loadStoredConfig();
        console.log(`   Config file: ${CONFIG_FILE}`);
        console.log(`   Server: ${config.serverUrl || 'not set'}`);
        console.log(`   API Key: ${config.apiKey ? '✓ configured' : '✗ not set'}`);
        console.log(`   Organization: ${config.organizationName || 'not set'}`);

        // Test server connection
        if (config.serverUrl && config.apiKey) {
          try {
            console.log('\n🔌 Testing server connection...');
            const response = await fetch(`${config.serverUrl}/organizations`, {
              headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'X-API-Key': config.apiKey,
                'Content-Type': 'application/json',
              },
            });

            if (response.ok) {
              const data = await response.json();
              const orgs = data.organizations || data || [];
              console.log('✅ Server connection OK');
              console.log(`   Access to ${orgs.length} organization(s)`);
              if (orgs.length > 0) {
                console.log(`   Organizations: ${orgs.map((o: any) => o.name).join(', ')}`);
              }
            } else {
              console.log('❌ Server connection failed');
              console.log(`   Status: ${response.status} ${response.statusText}`);
            }
          } catch (error) {
            console.log('❌ Could not connect to server');
            console.log(`   Error: ${error instanceof Error ? error.message : error}`);
          }
        }

        console.log('\n✨ Health check complete!');
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
