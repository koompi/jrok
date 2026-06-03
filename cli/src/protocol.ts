/**
 * KProxy agent <-> server wire protocol.
 *
 * This is a faithful, typed description of the existing protocol — the new CLI
 * MUST stay byte-compatible with the server (src/handlers/agentHandler.ts and
 * src/index.ts). Do not rename fields without changing the server too.
 */

export type Protocol = "http" | "tcp";
export type ServiceType = "port" | "docker-swarm" | "kubernetes";
export type IpMode = "allow-all" | "allowlist" | "blocklist";

export interface IpSecurity {
  mode: IpMode;
  allowedIps?: string[];
  blockedIps?: string[];
}

/** Everything needed to open an agent tunnel. */
export interface TunnelOptions {
  serverUrl: string;
  domain?: string; // requested subdomain; the server auto-generates one if omitted
  protocol: Protocol;
  serviceType: ServiceType;
  port?: number;
  localHost: string;
  serviceName?: string; // docker swarm / k8s service name
  authToken: string;
  forceNew?: boolean;
  ipSecurity?: IpSecurity;
}

// ---- Server -> agent messages ----
export type ServerMessage =
  | {
      type: "welcome";
      message?: string;
      agentId?: string;
      domain?: string;
      requestedDomain?: string;
      domainModified?: boolean;
      ipSecurity?: IpSecurity;
      tcpPort?: number;
    }
  | { type: "heartbeat_ack" }
  | {
      type: "http_request";
      requestId: string;
      method: string;
      path: string;
      query?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  | { type: "ws_connect"; wsId: string; path?: string; headers?: Record<string, string> }
  | { type: "ws_message"; wsId: string; data: string; isBinary?: boolean }
  | { type: "ws_close"; wsId: string; code?: number; reason?: string }
  | {
      type: "tcp_connect";
      connectionId: string;
      localPort?: number;
      localHost?: string;
      remoteAddress?: string;
      remotePort?: number;
    }
  | { type: "tcp_data"; connectionId: string; data: string }
  | { type: "tcp_close"; connectionId: string }
  | { type: "status"; message?: string };

/** Build the /ws/agent connection URL with all query parameters the server expects. */
export function buildAgentUrl(o: TunnelOptions): string {
  const url = new URL(o.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/agent";

  const p = url.searchParams;
  if (o.domain) p.set("domain", o.domain);
  p.set("serviceType", o.serviceType);
  p.set("auth", o.authToken);
  p.set("protocol", o.protocol);
  if (o.forceNew) p.set("forceNew", "true");

  if (o.ipSecurity) {
    p.set("ipSecurityMode", o.ipSecurity.mode);
    if (o.ipSecurity.allowedIps?.length) p.set("allowedIps", o.ipSecurity.allowedIps.join(","));
    if (o.ipSecurity.blockedIps?.length) p.set("blockedIps", o.ipSecurity.blockedIps.join(","));
  }

  if (o.serviceType === "port") {
    p.set("localPort", String(o.port));
    p.set("localHost", o.localHost);
  } else if (o.serviceType === "docker-swarm") {
    p.set("dockerService", o.serviceName ?? "");
  } else if (o.serviceType === "kubernetes") {
    p.set("k8sService", o.serviceName ?? "");
  }

  return url.toString();
}

/** Best-effort base domain for display (the server reports the authoritative one in `welcome`). */
export function getBaseDomain(serverUrl: string): string {
  try {
    const host = new URL(serverUrl).hostname;
    return host.replace(/^(api|tunnel)\./, "");
  } catch {
    return "tunnel.koompi.cloud";
  }
}
