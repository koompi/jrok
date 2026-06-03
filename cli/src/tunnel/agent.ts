import WebSocket from "ws";
import * as net from "net";
import { randomUUID } from "crypto";
import { buildAgentUrl, getBaseDomain, type TunnelOptions, type ServerMessage, type IpSecurity, type Protocol } from "../protocol";
import type { HttpCapture } from "../inspector/store";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "content-length",
]);

const HEARTBEAT_MS = 30_000;
const DEAD_AFTER_MS = 75_000; // no heartbeat_ack within this window => assume dead, reconnect
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface ReadyInfo {
  domain: string;
  agentId?: string;
  url?: string;
  tcpPort?: number;
  serverHost: string;
  protocol: Protocol;
  ipSecurity?: IpSecurity;
}

export interface AgentHooks {
  onConnecting?(attempt: number): void;
  onConnected?(): void;
  onReady?(info: ReadyInfo): void;
  onStatus?(message: string): void;
  onRequest?(line: string): void;
  onCapture?(cap: HttpCapture): void;
  onDisconnected?(retryInMs: number | null, attempt: number): void;
  onError?(message: string): void;
}

export interface AgentRunOptions {
  maxRetries?: number; // default Infinity — tunnels should keep trying
}

/**
 * Drives a single agent tunnel: connects to /ws/agent, proxies http/ws/tcp traffic
 * to the local service, keeps the link alive with heartbeats + dead-connection
 * detection, and reconnects with exponential backoff + jitter.
 */
export class TunnelAgent {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private deadTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastAckAt = 0;
  private attempt = 0;
  private stopped = false;

  private readonly localWs = new Map<string, WebSocket>();
  private readonly localTcp = new Map<string, net.Socket>();

  private readonly serverHost: string;
  private readonly baseDomain: string;

  constructor(
    private readonly options: TunnelOptions,
    private readonly hooks: AgentHooks = {},
    private readonly runOptions: AgentRunOptions = {},
  ) {
    this.serverHost = new URL(options.serverUrl).hostname;
    this.baseDomain = getBaseDomain(options.serverUrl);
  }

  /** Open the tunnel and keep it alive until stop() is called. */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Tear everything down and stop reconnecting. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    for (const s of this.localTcp.values()) { try { s.destroy(); } catch { /* ignore */ } }
    for (const w of this.localWs.values()) { try { w.close(1001, "agent shutdown"); } catch { /* ignore */ } }
    this.localTcp.clear();
    this.localWs.clear();
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.close(1000, "shutdown"); } catch { /* ignore */ } }
    this.ws = null;
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.deadTimer) clearInterval(this.deadTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = this.deadTimer = this.reconnectTimer = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.attempt += 1;
    this.hooks.onConnecting?.(this.attempt);

    const url = buildAgentUrl(this.options);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.lastAckAt = Date.now();
      this.hooks.onConnected?.();
      this.startHeartbeat();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      void this.handleMessage(msg);
    });

    ws.on("error", (err) => {
      this.hooks.onError?.(err instanceof Error ? err.message : String(err));
    });

    ws.on("close", () => {
      this.clearTimers();
      for (const w of this.localWs.values()) { try { w.close(1001, "server disconnected"); } catch { /* ignore */ } }
      this.localWs.clear();
      for (const s of this.localTcp.values()) { try { s.destroy(); } catch { /* ignore */ } }
      this.localTcp.clear();
      this.scheduleReconnect();
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: "heartbeat" })); } catch { /* ignore */ }
      }
    }, HEARTBEAT_MS);

    // Dead-connection detection: if the server stops acking heartbeats, force a reconnect.
    this.deadTimer = setInterval(() => {
      if (Date.now() - this.lastAckAt > DEAD_AFTER_MS) {
        this.hooks.onError?.("No heartbeat from server — reconnecting");
        try { this.ws?.terminate(); } catch { /* ignore */ }
      }
    }, HEARTBEAT_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const maxRetries = this.runOptions.maxRetries ?? Infinity;
    if (this.attempt > maxRetries) {
      this.hooks.onDisconnected?.(null, this.attempt);
      return;
    }
    const base = Math.min(2_000 * 2 ** Math.min(this.attempt, 5), MAX_RECONNECT_DELAY_MS);
    const jitter = Math.floor(Math.random() * 1_000); // de-synchronize many agents
    const delay = base + jitter;
    this.hooks.onDisconnected?.(delay, this.attempt);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  private async handleMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case "welcome": {
        const domain = (msg.domain as string) || this.options.domain || "";
        const ready: ReadyInfo = {
          domain,
          agentId: msg.agentId as string | undefined,
          serverHost: this.serverHost,
          protocol: this.options.protocol,
          ipSecurity: msg.ipSecurity as IpSecurity | undefined,
          tcpPort: msg.tcpPort as number | undefined,
        };
        if (this.options.protocol === "http") {
          ready.url = `https://${domain}.${this.baseDomain}`;
        }
        this.hooks.onReady?.(ready);
        break;
      }
      case "heartbeat_ack":
        this.lastAckAt = Date.now();
        break;
      case "http_request":
        await this.handleHttp(msg);
        break;
      case "ws_connect":
        this.handleWsConnect(msg);
        break;
      case "ws_message":
        this.handleWsMessage(msg);
        break;
      case "ws_close":
        this.handleWsClose(msg);
        break;
      case "tcp_connect":
        this.handleTcpConnect(msg);
        break;
      case "tcp_data":
        this.handleTcpData(msg);
        break;
      case "tcp_close":
        this.handleTcpClose(msg);
        break;
      case "status":
        if (msg.message) this.hooks.onStatus?.(String(msg.message));
        break;
      default:
        break;
    }
  }

  // ---- HTTP ----
  private async handleHttp(msg: Extract<ServerMessage, { type: "http_request" }>): Promise<void> {
    const started = Date.now();
    const localUrl = `http://${this.options.localHost}:${this.options.port}${msg.path}${msg.query ?? ""}`;
    const forwardHeaders: Record<string, string> = {};
    if (msg.headers) {
      for (const [k, v] of Object.entries(msg.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) forwardHeaders[k] = v;
      }
    }
    try {
      const resp = await fetch(localUrl, {
        method: msg.method,
        headers: forwardHeaders,
        body: msg.method !== "GET" && msg.method !== "HEAD" ? msg.body : undefined,
        redirect: "manual",
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      const bodyB64 = buf.toString("base64");
      const resHeaders: Record<string, string> = {};
      resp.headers.forEach((value, key) => (resHeaders[key] = value));

      this.send({
        type: "http_response",
        requestId: msg.requestId,
        status: resp.status,
        statusText: resp.statusText,
        headers: resHeaders,
        body: bodyB64,
        isBase64: true,
      });

      this.hooks.onRequest?.(`${msg.method} ${msg.path} → ${resp.status} (${Date.now() - started}ms)`);
      this.hooks.onCapture?.({
        id: randomUUID(),
        time: started,
        method: msg.method,
        path: `${msg.path}${msg.query ?? ""}`,
        status: resp.status,
        durationMs: Date.now() - started,
        reqHeaders: msg.headers,
        reqBodyB64: msg.body ? Buffer.from(msg.body).toString("base64") : undefined,
        resHeaders,
        resBodyB64: bodyB64,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({
        type: "http_response",
        requestId: msg.requestId,
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/plain" },
        body: `Error connecting to local service: ${message}`,
      });
      this.hooks.onRequest?.(`${msg.method} ${msg.path} → 502 (${message})`);
    }
  }

  // ---- WebSocket proxy ----
  private handleWsConnect(msg: Extract<ServerMessage, { type: "ws_connect" }>): void {
    const wsUrl = `ws://${this.options.localHost}:${this.options.port}${msg.path ?? "/"}`;
    try {
      const local = new WebSocket(wsUrl, { headers: msg.headers ?? {} });
      local.on("open", () => this.localWs.set(msg.wsId, local));
      local.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        this.send({
          type: "ws_message_response",
          wsId: msg.wsId,
          data: isBinary ? (data as Buffer).toString("base64") : data.toString(),
          isBinary,
        });
      });
      local.on("close", (code: number, reason: Buffer) => {
        this.localWs.delete(msg.wsId);
        this.send({ type: "ws_close_response", wsId: msg.wsId, code, reason: reason?.toString() ?? "" });
      });
      local.on("error", (err: Error) => {
        this.localWs.delete(msg.wsId);
        this.send({ type: "ws_error", wsId: msg.wsId, error: err.message });
      });
    } catch (err) {
      this.send({ type: "ws_error", wsId: msg.wsId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleWsMessage(msg: Extract<ServerMessage, { type: "ws_message" }>): void {
    const local = this.localWs.get(msg.wsId);
    if (!local || local.readyState !== WebSocket.OPEN) return;
    try {
      local.send(msg.isBinary ? Buffer.from(msg.data, "base64") : msg.data);
    } catch { /* ignore */ }
  }

  private handleWsClose(msg: Extract<ServerMessage, { type: "ws_close" }>): void {
    const local = this.localWs.get(msg.wsId);
    if (local) {
      try { local.close(msg.code ?? 1000, msg.reason ?? ""); } catch { /* ignore */ }
      this.localWs.delete(msg.wsId);
    }
  }

  // ---- TCP proxy ----
  private handleTcpConnect(msg: Extract<ServerMessage, { type: "tcp_connect" }>): void {
    try {
      const socket = net.createConnection({
        host: msg.localHost || this.options.localHost,
        port: msg.localPort || (this.options.port as number),
      });
      socket.on("connect", () => {
        this.localTcp.set(msg.connectionId, socket);
        this.send({ type: "tcp_connected", connectionId: msg.connectionId });
      });
      socket.on("data", (data: Buffer) => {
        this.send({ type: "tcp_data_response", connectionId: msg.connectionId, data: data.toString("base64") });
      });
      socket.on("close", () => {
        this.localTcp.delete(msg.connectionId);
        this.send({ type: "tcp_close_response", connectionId: msg.connectionId });
      });
      socket.on("error", (err: Error) => {
        this.localTcp.delete(msg.connectionId);
        this.send({ type: "tcp_error", connectionId: msg.connectionId, error: err.message });
      });
    } catch (err) {
      this.send({ type: "tcp_error", connectionId: msg.connectionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleTcpData(msg: Extract<ServerMessage, { type: "tcp_data" }>): void {
    const socket = this.localTcp.get(msg.connectionId);
    if (!socket) return;
    try { socket.write(Buffer.from(msg.data, "base64")); } catch { /* ignore */ }
  }

  private handleTcpClose(msg: Extract<ServerMessage, { type: "tcp_close" }>): void {
    const socket = this.localTcp.get(msg.connectionId);
    if (socket) {
      try { socket.end(); } catch { /* ignore */ }
      this.localTcp.delete(msg.connectionId);
    }
  }
}
