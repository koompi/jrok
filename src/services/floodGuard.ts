/**
 * Flood protection for app traffic. Nothing sits in front of the edges
 * (decision D1, no Cloudflare proxy), and the per-IP request limit nginx used
 * to apply turned away real visitors, so jrok watches for floods itself.
 *
 * 1. Blocking floods. A visitor address that sends this edge more than
 *    FLOOD_REQUESTS (3000) requests in FLOOD_WINDOW_S (10) seconds is far
 *    beyond a person, or a carrier address shared by many people (a page load
 *    is 30–60 requests). It is blocked on every edge for FLOOD_BLOCK_S (600)
 *    seconds, doubled each time it comes back within a day, up to a day. The
 *    block is saved for every edge (securitySync: within 10 s there) and a
 *    person is told (Telegram). Blocked addresses are refused before any
 *    routing work.
 *    Never blocked: addresses in FLOOD_EXEMPT (comma-separated IPs or IPv4
 *    ranges, e.g. kconsole's hosts), private and loopback addresses, and
 *    requests another edge forwarded here (counted where they arrived).
 * 2. One app can't take an edge over. At most APP_MAX_WAITING (1000) of an
 *    app's requests wait here for it to start answering. Beyond that, that app
 *    alone gets 503 with Retry-After, and every other app is served as usual.
 *    Once a response has started (an event stream, a download) it no longer
 *    counts.
 *
 * Only app traffic is counted (tunnel hosts and custom domains), never agents
 * or jrok's API, which nginx limits. FLOOD_GUARD=off turns both off.
 */
import { ipMatchesAny } from "../utils/clientIp";

export interface FloodGuardOptions {
  requests: number;
  windowMs: number;
  blockMs: number;
  maxBlockMs: number;
  exempt: string[];
  appMaxWaiting: number;
  enabled: boolean;
  now?: () => number;
  /** Block an address on every edge for `seconds`. */
  block: (ip: string, reason: string, seconds: number) => void;
  /** Tell a person (Telegram); also logged. */
  notify?: (message: string) => void;
  log?: (message: string) => void;
}

/** Blocks this guard makes start with this (blockedResponse tells them apart). */
export const FLOOD_REASON_PREFIX = "Flood:";

const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16"];
const ESCALATION_RESET_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED = 200_000;

function isPrivate(ip: string): boolean {
  if (ip === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return ipMatchesAny(ip, PRIVATE);
}

export class FloodGuard {
  private readonly windows = new Map<string, { start: number; count: number; apps: Map<string, number> }>();
  private readonly offences = new Map<string, { level: number; last: number }>();
  private readonly waiting = new Map<string, number>();
  private readonly busyLogged = new Map<string, number>();
  private lastSweep = 0;

  constructor(private readonly opts: FloodGuardOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Count one request from `ip` to `app`. Returns true when this request made
   * the address a flood: it has just been blocked, and the caller refuses it.
   */
  count(ip: string, app: string, forwarded: boolean): boolean {
    if (!this.opts.enabled || forwarded || !ip || ip === "unknown") return false;
    if (isPrivate(ip) || ipMatchesAny(ip, this.opts.exempt)) return false;
    const now = this.now();
    this.sweep(now);

    let window = this.windows.get(ip);
    if (!window || now - window.start >= this.opts.windowMs) {
      window = { start: now, count: 0, apps: new Map() };
      this.windows.set(ip, window);
    }
    window.count++;
    window.apps.set(app, (window.apps.get(app) ?? 0) + 1);
    if (window.count <= this.opts.requests) return false;

    this.windows.delete(ip);
    const offence = this.offences.get(ip);
    const level = offence && now - offence.last < ESCALATION_RESET_MS ? offence.level + 1 : 0;
    this.offences.set(ip, { level, last: now });
    const blockMs = Math.min(this.opts.blockMs * 2 ** level, this.opts.maxBlockMs);
    const top = [...window.apps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? app;
    const seconds = Math.round(blockMs / 1000);
    const reason = `${FLOOD_REASON_PREFIX} over ${this.opts.requests} requests in ${this.opts.windowMs / 1000} s`;
    this.opts.block(ip, reason, seconds);
    const message = `🛑 <b>Flood blocked</b>: <code>${ip}</code> sent over ${this.opts.requests} requests in ${this.opts.windowMs / 1000} s ` +
      `(mostly to <code>${top}</code>). Blocked on every edge for ${seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : `${Math.round(seconds / 60)} min`}` +
      (level > 0 ? ` (offence ${level + 1} today)` : "") + ".";
    this.opts.log?.(message.replace(/<\/?[a-z]+>/g, ""));
    this.opts.notify?.(message);
    return true;
  }

  /**
   * A request for `app` is about to wait for the app to answer. False: the app
   * already has appMaxWaiting waiting, and this one must be refused.
   */
  startWaiting(app: string): boolean {
    if (!this.opts.enabled) return true;
    const n = this.waiting.get(app) ?? 0;
    if (n >= this.opts.appMaxWaiting) {
      const now = this.now();
      if (now - (this.busyLogged.get(app) ?? 0) > 60_000) {
        this.busyLogged.set(app, now);
        this.opts.log?.(`🚦 ${app}: ${n} requests already waiting for it to answer; refusing more (APP_MAX_WAITING)`);
      }
      return false;
    }
    this.waiting.set(app, n + 1);
    return true;
  }

  /** The app started answering (or failed): one fewer waiting. */
  stopWaiting(app: string): void {
    if (!this.opts.enabled) return;
    const n = (this.waiting.get(app) ?? 0) - 1;
    if (n > 0) this.waiting.set(app, n);
    else this.waiting.delete(app);
  }

  waitingFor(app: string): number {
    return this.waiting.get(app) ?? 0;
  }

  /** Forget windows that ended; bounded even under a flood from many addresses. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.opts.windowMs && this.windows.size < MAX_TRACKED) return;
    this.lastSweep = now;
    for (const [ip, window] of this.windows) {
      if (now - window.start >= this.opts.windowMs) this.windows.delete(ip);
    }
    for (const [ip, offence] of this.offences) {
      if (now - offence.last >= ESCALATION_RESET_MS) this.offences.delete(ip);
    }
    if (this.windows.size >= MAX_TRACKED) this.windows.clear();
  }
}

const number = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Options from the environment (see the top of this file). */
export function floodGuardOptionsFromEnv(): Omit<FloodGuardOptions, "block" | "notify" | "log"> {
  return {
    enabled: (process.env.FLOOD_GUARD || "").toLowerCase() !== "off",
    requests: number("FLOOD_REQUESTS", 3000),
    windowMs: number("FLOOD_WINDOW_S", 10) * 1000,
    blockMs: number("FLOOD_BLOCK_S", 600) * 1000,
    maxBlockMs: number("FLOOD_MAX_BLOCK_S", 86_400) * 1000,
    exempt: (process.env.FLOOD_EXEMPT || "").split(",").map((s) => s.trim()).filter(Boolean),
    appMaxWaiting: number("APP_MAX_WAITING", 1000),
  };
}

/** The answer to a blocked address, before any work: 429 for a flood block, 403 for any other. */
export function blockedResponse(block: { reason: string; secondsLeft: number }): Response {
  const flood = block.reason.startsWith(FLOOD_REASON_PREFIX);
  return new Response(
    JSON.stringify({ success: false, message: flood ? "Too many requests from your address. Try again later." : "Your address is blocked." }),
    { status: flood ? 429 : 403, headers: { "Content-Type": "application/json", "Retry-After": String(Math.max(1, block.secondsLeft)) } }
  );
}

/** The answer when an app already has too many requests waiting for it. */
export function appBusyResponse(): Response {
  return new Response(
    JSON.stringify({ success: false, message: "This app is receiving more requests than it can answer. Try again shortly." }),
    { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "5", "X-Jrok-App-Busy": "1" } }
  );
}
