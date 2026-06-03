import type { Command } from "commander";
import { TunnelAgent, type AgentHooks, type ReadyInfo } from "../tunnel/agent";
import type { IpSecurity, IpMode, Protocol, ServiceType, TunnelOptions } from "../protocol";
import { CaptureStore } from "../inspector/store";
import { InspectorServer } from "../inspector/server";
import { out, isJson } from "../output";
import { contextFrom, fail } from "./shared";

interface TunnelFlags {
  domain?: string;
  host: string;
  forceNew?: boolean;
  restrict?: boolean;
  allowIp?: string;
  blockIp?: string;
  inspect?: boolean;
  inspectPort: string;
  retries?: string;
}

function buildIpSecurity(flags: TunnelFlags): IpSecurity | undefined {
  let mode: IpMode = "allow-all";
  const allowedIps = flags.allowIp?.split(",").map((s) => s.trim()).filter(Boolean);
  const blockedIps = flags.blockIp?.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowedIps?.length) mode = "allowlist";
  else if (blockedIps?.length) mode = "blocklist";
  else if (flags.restrict) mode = "allowlist";
  if (mode === "allow-all") return undefined;
  return { mode, allowedIps, blockedIps };
}

/** Start a long-running tunnel and wire up output, inspector and graceful shutdown. */
async function runTunnel(
  cmd: Command,
  partial: { protocol: Protocol; serviceType: ServiceType; port?: number; serviceName?: string },
  flags: TunnelFlags,
): Promise<void> {
  const ctx = contextFrom(cmd);
  if (!ctx.authToken) fail("Not authenticated. Run `kproxy login`, pass --auth <key>, or set KPROXY_AUTH.");

  if (partial.serviceType === "port" && (!partial.port || partial.port < 1 || partial.port > 65535)) {
    fail("A valid local port (1-65535) is required.");
  }

  const options: TunnelOptions = {
    serverUrl: ctx.serverUrl,
    domain: flags.domain,
    protocol: partial.protocol,
    serviceType: partial.serviceType,
    port: partial.port,
    localHost: flags.host,
    serviceName: partial.serviceName,
    authToken: ctx.authToken,
    forceNew: flags.forceNew,
    ipSecurity: buildIpSecurity(flags),
  };

  // Optional local request inspector.
  let inspector: InspectorServer | null = null;
  let store: CaptureStore | null = null;
  if (flags.inspect && partial.protocol === "http") {
    store = new CaptureStore();
    inspector = new InspectorServer(store, { host: flags.host, port: partial.port as number });
    try {
      const port = await inspector.start(parseInt(flags.inspectPort, 10) || 4040);
      out.info(out.colors.dim(`🔍 Inspector: http://127.0.0.1:${port}`));
    } catch {
      out.warn(`Could not start inspector on port ${flags.inspectPort} (continuing without it)`);
      inspector = null;
    }
  }

  const target =
    partial.serviceType === "port" ? `${flags.host}:${partial.port}`
    : partial.serviceType === "docker-swarm" ? `docker: ${partial.serviceName}`
    : `k8s: ${partial.serviceName}`;

  out.step(`Connecting to ${ctx.serverUrl}`);
  out.info(out.colors.dim(`Local target: ${target} · protocol: ${partial.protocol.toUpperCase()}`));

  const hooks: AgentHooks = {
    onConnecting: (attempt) => { if (attempt > 1) out.detail(`Reconnect attempt ${attempt}…`); },
    onConnected: () => out.success("Connected to server"),
    onReady: (info: ReadyInfo) => {
      if (isJson()) {
        out.json({ success: true, domain: info.domain, url: info.url, tcpPort: info.tcpPort, agentId: info.agentId, server: ctx.serverUrl });
        return;
      }
      if (info.url) {
        out.raw("");
        out.raw(out.colors.bold(out.colors.green(`  ${info.url}`)));
        out.raw(out.colors.dim(`  → ${target}`));
        out.raw("");
      }
      if (info.tcpPort) {
        out.raw("");
        out.success("TCP tunnel ready");
        out.raw(`  Connect to: ${out.colors.bold(`${info.serverHost}:${info.tcpPort}`)}`);
        out.raw(out.colors.dim(`  e.g. ssh user@${info.serverHost} -p ${info.tcpPort}`));
        out.raw("");
      }
      if (info.ipSecurity && info.ipSecurity.mode !== "allow-all") {
        out.info(out.colors.dim(`🔐 IP ${info.ipSecurity.mode}`));
      }
      out.info(out.colors.dim("Press Ctrl+C to stop."));
    },
    onStatus: (m) => out.detail(m),
    onRequest: (line) => { if (!isJson()) out.info(out.colors.dim(line)); },
    onCapture: store ? (c) => store!.add(c) : undefined,
    onDisconnected: (retryInMs, attempt) => {
      if (retryInMs === null) fail(`Disconnected and gave up after ${attempt} attempts.`);
      else out.warn(`Disconnected — reconnecting in ${Math.round(retryInMs / 1000)}s (attempt ${attempt})`);
    },
    onError: (m) => out.detail(`! ${m}`),
  };

  const agent = new TunnelAgent(options, hooks, {
    maxRetries: flags.retries ? parseInt(flags.retries, 10) : Infinity,
  });

  const shutdown = () => {
    out.raw("");
    out.info("Shutting down tunnel…");
    agent.stop();
    inspector?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  agent.start();
  // Keep the process alive.
  await new Promise<void>(() => {});
}

function addTunnelFlags(c: Command): Command {
  return c
    .option("-d, --domain <subdomain>", "request a specific subdomain")
    .option("-H, --host <host>", "local host to forward to", "localhost")
    .option("--force-new", "force a new subdomain even if your org already owns one")
    .option("--restrict", "restrict access (allowlist mode)")
    .option("--allow-ip <ips>", "comma-separated IPs/CIDRs to allow")
    .option("--block-ip <ips>", "comma-separated IPs/CIDRs to block")
    .option("--retries <n>", "max reconnect attempts before giving up (default: unlimited)");
}

export function registerTunnelCommands(program: Command): void {
  // kproxy http <port>
  const http = addTunnelFlags(
    program
      .command("http <port>")
      .description("Expose a local HTTP service")
      .option("--inspect", "open a local request inspector")
      .option("--inspect-port <port>", "inspector port", "4040"),
  );
  http.action(async (port: string, _o, cmd: Command) => {
    await runTunnel(cmd, { protocol: "http", serviceType: "port", port: parseInt(port, 10) }, cmd.optsWithGlobals() as TunnelFlags);
  });

  // kproxy tcp <port>
  const tcp = addTunnelFlags(program.command("tcp <port>").description("Expose a local TCP service (SSH, databases, …)"));
  tcp.action(async (port: string, _o, cmd: Command) => {
    await runTunnel(cmd, { protocol: "tcp", serviceType: "port", port: parseInt(port, 10) }, cmd.optsWithGlobals() as TunnelFlags);
  });

  // kproxy connect — backward-compatible omnibus command
  const connect = addTunnelFlags(
    program
      .command("connect")
      .description("Expose a service (legacy: use --port/--tcp/--docker-service/--k8s-service)")
      .option("-p, --port <port>", "local port to expose")
      .option("--tcp", "use a raw TCP tunnel instead of HTTP")
      .option("--docker-service <name>", "expose a Docker Swarm service")
      .option("--k8s-service <name>", "expose a Kubernetes service")
      .option("--inspect", "open a local request inspector")
      .option("--inspect-port <port>", "inspector port", "4040"),
  );
  connect.action(async (_o, cmd: Command) => {
    const f = cmd.optsWithGlobals() as TunnelFlags & {
      port?: string; tcp?: boolean; dockerService?: string; k8sService?: string;
    };
    const protocol: Protocol = f.tcp ? "tcp" : "http";
    if (f.dockerService) {
      await runTunnel(cmd, { protocol, serviceType: "docker-swarm", serviceName: f.dockerService }, f);
    } else if (f.k8sService) {
      await runTunnel(cmd, { protocol, serviceType: "kubernetes", serviceName: f.k8sService }, f);
    } else {
      await runTunnel(cmd, { protocol, serviceType: "port", port: f.port ? parseInt(f.port, 10) : undefined }, f);
    }
  });
}
