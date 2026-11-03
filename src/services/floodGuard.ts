/**
 * Flood protection for app traffic. Nothing sits in front of the edges
 * (decision D1, no Cloudflare proxy), and the per-IP request limit nginx used
 * to apply turned away real visitors, so jrok watches for floods itself.
 *
 * 1. One address flooding one app. An address (an IPv6 /64 counts as one)
 *    sending one app more than FLOOD_REQUESTS (3000) requests in FLOOD_WINDOW_S
 *    (10) seconds is far beyond a person (a page load is 30–60). The rest of
 *    that window is refused (429) for that app alone. Doing it again within
 *    FLOOD_REPEAT_S (3600) blocks the address for that app on every edge for
 *    FLOOD_BLOCK_S (600) seconds, doubled each further time within the hour, up
 *    to FLOOD_MAX_BLOCK_S (3600). The block is saved for every edge
 *    (securitySync: within 10 s there) and a person is told (Telegram). The
 *    address's other apps are served as usual.
 *    It used to count every app together and block the address on every app
 *    and every edge, for up to a day: a school whose class opened its live
 *    previews at once, or a busy carrier address, lost all of KOOMPI Cloud.
 * 2. One address asking for names at random. Every name under a base domain
 *    costs MongoDB lookups, app or not. An address asking this edge for more
 *    than FLOOD_NAMES (500) different names in a window is refused every app
 *    on this edge alone (the same durations); people use a handful.
 *    Never counted: addresses in FLOOD_EXEMPT (comma-separated IPs or IPv4
 *    ranges, e.g. kconsole's hosts), private and loopback addresses, and
 *    requests another edge forwarded here (counted where they arrived).
 * 3. One app can't take an edge over. At most APP_MAX_WAITING (1000) of an
 *    app's requests wait here for it to start answering. Beyond that, that app
 *    alone gets 503 with Retry-After, and every other app is served as usual.
 *    Once a response has started (an event stream, a download) it no longer
 *    counts. Once an app has half that waiting, one address may have at most
 *    its share waiting, max(50, APP_MAX_WAITING / 10); beyond it that address
 *    alone gets 429. One client with many slow requests used to take every
 *    slot, and everyone else got 503. Below half there is no share, so a
 *    school or carrier address with many people behind it isn't refused while
 *    the app keeps up. Exempt and private addresses have none.
 *
 * Only app traffic is counted (tunnel hosts and custom domains), never agents
 * or jrok's API, which nginx limits. FLOOD_GUARD=off turns all three off.
 */
import { isIP } from "net";
import { ipMatchesAny, normalizeIp } from "../utils/clientIp";

export interface FloodGuardOptions {
  requests: number;
  windowMs: number;
  blockMs: number;
  maxBlockMs: number;
  /** A second flood of the same app within this long is blocked. */
  repeatMs: number;
  /** Different names one address may ask for in a window. */
  names: number;
  exempt: string[];
  appMaxWaiting: number;
  enabled: boolean;
  now?: () => number;
  /** Block `address` (a floodKey) for `app` on every edge for `seconds`. */
  block: (address: string, app: string, reason: string, seconds: number) => void;
  /** Tell a person (Telegram); also logged. */
  notify?: (message: string) => void;
  log?: (message: string) => void;
}

/** Why a request is refused, and for how long. */
export interface FloodRefusal {
  reason: string;
  secondsLeft: number;
}

/** Blocks and refusals this guard makes start with this (blockedResponse tells them apart). */
export const FLOOD_REASON_PREFIX = "Flood:";

const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16"];
const MAX_TRACKED = 200_000;

function isPrivate(ip: string): boolean {
  if (ip === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return ipMatchesAny(ip, PRIVATE);
}

/**
 * What the guard counts and blocks by: the address, or for IPv6 its /64
 * ("2001:db8:1:2::/64"), which one customer line usually gets whole.
 */
export function floodKey(ip: string): string {
  const addr = normalizeIp(ip) ?? ip.trim().toLowerCase();
  if (isIP(addr) !== 6) return addr;
  const [head = "", tail = ""] = addr.split("::");
  const left = head ? head.split(":") : [];
  const right = addr.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = addr.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

const duration = (seconds: number) => (seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : `${Math.round(seconds / 60)} min`);

export class FloodGuard {
  private readonly appWindows = new Map<string, { start: number; count: number; over: boolean }>();
  private readonly nameWindows = new Map<string, { start: number; names: Set<string> }>();
  private readonly offences = new Map<string, { count: number; last: number }>();
  private readonly localBlocks = new Map<string, number>();
  private readonly waiting = new Map<string, number>();
  private readonly waitingByAddress = new Map<string, number>();
  private readonly busyLogged = new Map<string, number>();
  private lastSweep = 0;

  constructor(private readonly opts: FloodGuardOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** One more offence of `key`; its number within repeatMs. */
  private offence(key: string, now: number): number {
    const previous = this.offences.get(key);
    const count = previous && now - previous.last < this.opts.repeatMs ? previous.count + 1 : 1;
    this.offences.set(key, { count, last: now });
    return count;
  }

  /** How long the n-th block within repeatMs lasts. */
  private blockSeconds(n: number): number {
    return Math.round(Math.min(this.opts.blockMs * 2 ** Math.max(0, n - 1), this.opts.maxBlockMs) / 1000);
  }

  /**
   * Count one request from `ip` to `app`. Null: it may go on. Otherwise it is
   * refused, and why: a flood of this app (the rest of the window, or a block
   * just made), or of names.
   */
  count(ip: string, app: string, forwarded: boolean): FloodRefusal | null {
    if (!this.opts.enabled || forwarded || !ip || ip === "unknown") return null;
    if (isPrivate(ip) || ipMatchesAny(ip, this.opts.exempt)) return null;
    const now = this.now();
    this.sweep(now);
    const key = floodKey(ip);
    const windowS = this.opts.windowMs / 1000;

    const blockedUntil = this.localBlocks.get(key);
    if (blockedUntil !== undefined && blockedUntil > now) {
      return { reason: `${FLOOD_REASON_PREFIX} over ${this.opts.names} names in ${windowS} s`, secondsLeft: Math.ceil((blockedUntil - now) / 1000) };
    }

    // 2. Names asked for at random (this edge only).
    let names = this.nameWindows.get(key);
    if (!names || now - names.start >= this.opts.windowMs) {
      names = { start: now, names: new Set() };
      this.nameWindows.set(key, names);
    }
    if (!names.names.has(app)) {
      names.names.add(app);
      if (names.names.size > this.opts.names) {
        this.nameWindows.delete(key);
        const seconds = this.blockSeconds(this.offence(key, now));
        this.localBlocks.set(key, now + seconds * 1000);
        const message = `🛑 <b>Flood blocked</b>: <code>${key}</code> asked this edge for over ${this.opts.names} different names in ${windowS} s. ` +
          `Refused every app on this edge for ${duration(seconds)}.`;
        this.opts.log?.(message.replace(/<\/?[a-z]+>/g, ""));
        this.opts.notify?.(message);
        return { reason: `${FLOOD_REASON_PREFIX} over ${this.opts.names} names in ${windowS} s`, secondsLeft: seconds };
      }
    }

    // 1. One app flooded.
    const appKey = `${key}|${app}`;
    let window = this.appWindows.get(appKey);
    if (!window || now - window.start >= this.opts.windowMs) {
      window = { start: now, count: 0, over: false };
      this.appWindows.set(appKey, window);
    }
    window.count++;
    if (window.count <= this.opts.requests) return null;

    const reason = `${FLOOD_REASON_PREFIX} over ${this.opts.requests} requests to ${app} in ${windowS} s`;
    const rest = { reason, secondsLeft: Math.max(1, Math.ceil((window.start + this.opts.windowMs - now) / 1000)) };
    if (window.over) return rest;
    window.over = true;

    const n = this.offence(appKey, now);
    if (n === 1) {
      this.opts.log?.(`🚦 ${key} sent ${app} over ${this.opts.requests} requests in ${windowS} s: the rest of this window refused`);
      return rest;
    }
    const seconds = this.blockSeconds(n - 1);
    this.opts.block(key, app, reason, seconds);
    const message = `🛑 <b>Flood blocked</b>: <code>${key}</code> sent <code>${app}</code> over ${this.opts.requests} requests in ${windowS} s ` +
      `again within ${duration(this.opts.repeatMs / 1000)}. Blocked for that app on every edge for ${duration(seconds)}` +
      (n > 2 ? ` (offence ${n} this hour)` : "") + ". Its other apps are served.";
    this.opts.log?.(message.replace(/<\/?[a-z]+>/g, ""));
    this.opts.notify?.(message);
    return { reason, secondsLeft: seconds };
  }

  /** The address a waiting request counts against, or null for none (exempt, private, unknown). */
  private waitingAddress(ip: string | undefined): string | null {
    if (!ip || ip === "unknown" || isPrivate(ip) || ipMatchesAny(ip, this.opts.exempt)) return null;
    return floodKey(ip);
  }

  /**
   * A request for `app` from `ip` is about to wait for the app to answer.
   * "app": the app already has appMaxWaiting waiting; refuse it (503).
   * "address": the app is half full and this address has its share waiting;
   * refuse this address alone (429). "ok": count it until stopWaiting.
   */
  startWaiting(app: string, ip?: string): "ok" | "app" | "address" {
    if (!this.opts.enabled) return "ok";
    const n = this.waiting.get(app) ?? 0;
    const now = this.now();
    if (n >= this.opts.appMaxWaiting) {
      if (now - (this.busyLogged.get(app) ?? 0) > 60_000) {
        this.busyLogged.set(app, now);
        this.opts.log?.(`🚦 ${app}: ${n} requests already waiting for it to answer; refusing more (APP_MAX_WAITING)`);
      }
      return "app";
    }
    const address = this.waitingAddress(ip);
    if (address !== null) {
      const key = `${app}|${address}`;
      const mine = this.waitingByAddress.get(key) ?? 0;
      const share = Math.max(50, Math.floor(this.opts.appMaxWaiting / 10));
      if (n >= this.opts.appMaxWaiting / 2 && mine >= share) {
        if (now - (this.busyLogged.get(key) ?? 0) > 60_000) {
          this.busyLogged.set(key, now);
          this.opts.log?.(`🚦 ${app}: ${address} has ${mine} of its ${n} waiting requests; refusing that address more`);
        }
        return "address";
      }
      this.waitingByAddress.set(key, mine + 1);
    }
    this.waiting.set(app, n + 1);
    return "ok";
  }

  /** The app started answering (or failed): one fewer waiting. */
  stopWaiting(app: string, ip?: string): void {
    if (!this.opts.enabled) return;
    const n = (this.waiting.get(app) ?? 0) - 1;
    if (n > 0) this.waiting.set(app, n);
    else this.waiting.delete(app);
    const address = this.waitingAddress(ip);
    if (address === null) return;
    const key = `${app}|${address}`;
    const mine = (this.waitingByAddress.get(key) ?? 0) - 1;
    if (mine > 0) this.waitingByAddress.set(key, mine);
    else this.waitingByAddress.delete(key);
  }

  waitingFor(app: string): number {
    return this.waiting.get(app) ?? 0;
  }

  /** Forget windows that ended; bounded even under a flood from many addresses. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.opts.windowMs && this.appWindows.size < MAX_TRACKED && this.nameWindows.size < MAX_TRACKED) return;
    this.lastSweep = now;
    for (const [key, window] of this.appWindows) {
      if (now - window.start >= this.opts.windowMs) this.appWindows.delete(key);
    }
    for (const [key, window] of this.nameWindows) {
      if (now - window.start >= this.opts.windowMs) this.nameWindows.delete(key);
    }
    for (const [key, offence] of this.offences) {
      if (now - offence.last >= this.opts.repeatMs) this.offences.delete(key);
    }
    for (const [key, until] of this.localBlocks) {
      if (until <= now) this.localBlocks.delete(key);
    }
    for (const [key, at] of this.busyLogged) {
      if (now - at > 60_000) this.busyLogged.delete(key);
    }
    if (this.appWindows.size >= MAX_TRACKED) this.appWindows.clear();
    if (this.nameWindows.size >= MAX_TRACKED) this.nameWindows.clear();
    if (this.offences.size >= MAX_TRACKED) this.offences.clear();
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
    maxBlockMs: number("FLOOD_MAX_BLOCK_S", 3600) * 1000,
    repeatMs: number("FLOOD_REPEAT_S", 3600) * 1000,
    names: number("FLOOD_NAMES", 500),
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

/** The answer when one address already has its share of an app's waiting requests. */
export function addressBusyResponse(): Response {
  return new Response(
    JSON.stringify({ success: false, message: "Too many of your requests are waiting for this app. Try again shortly." }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "5" } }
  );
}

/** The answer when an app already has too many requests waiting for it. */
export function appBusyResponse(): Response {
  return new Response(
    JSON.stringify({ success: false, message: "This app is receiving more requests than it can answer. Try again shortly." }),
    { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "5", "X-Jrok-App-Busy": "1" } }
  );
}
