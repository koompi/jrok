/**
 * Who is actually on the other end of a request.
 *
 * jrok sits behind nginx, which forwards with
 *
 *   proxy_set_header X-Real-IP       $remote_addr;
 *   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 *
 * $proxy_add_x_forwarded_for APPENDS the address nginx saw to whatever
 * X-Forwarded-For the client sent. So a visitor who sends
 * `X-Forwarded-For: 10.0.0.1` arrives here as `10.0.0.1, <their real IP>`.
 * Everything to the left of what our own proxy appended is the client's own
 * claim. jrok used to read the LEFTMOST entry, which let anyone pick their IP:
 * walk past a customer's IP allowlist, dodge a global IP block, reset the auth
 * brute-force limiter at will, and hand a forged address to the customer's app.
 *
 * The rule now: only the entries our trusted proxies appended count, and each
 * trusted proxy appends exactly one. With TRUSTED_PROXY_HOPS proxies in front of
 * jrok, the client is the entry that many places from the RIGHT. One nginx (the
 * shipped topology) means the rightmost entry. Zero means nothing in front of
 * jrok, so the headers are pure client input and only the socket counts.
 *
 *   TRUSTED_PROXY_HOPS=1          default; one nginx in front (ansible, nginxConfig.ts)
 *   TRUSTED_PROXY_HOPS=2          e.g. Cloudflare -> nginx -> jrok
 *   TRUSTED_PROXY_HOPS=0          jrok is directly on the internet
 *
 * Hop counting assumes every request arrives through those proxies. If jrok's
 * own port is reachable from the internet (the ansible playbook opens 3000), a
 * caller can skip nginx and write the "trusted" entry themselves. Firewall the
 * port, or set TRUSTED_PROXY_IPS to the addresses nginx (and peer jrok servers,
 * which forward cross-server traffic) connect from; a connection from anywhere
 * else then has its forwarding headers ignored.
 *
 *   TRUSTED_PROXY_IPS=127.0.0.1,::1,10.0.0.0/8
 */

export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/** Proxies in front of jrok whose X-Forwarded-For entries are believed. */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRUSTED_PROXY_HOPS;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_TRUSTED_PROXY_HOPS;
}

/** Socket addresses allowed to speak for a client. Empty means "trust by hop count alone". */
export function trustedProxyIps(): string[] {
  return (process.env.TRUSTED_PROXY_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:.]+$/;

/**
 * Canonical form of an address, or null if it isn't one.
 *
 * Accepts the shapes that turn up in practice — "[::1]", "1.2.3.4:5678",
 * "::ffff:1.2.3.4" (Bun reports IPv4 clients like this on a dual-stack socket)
 * — and rejects anything else. The value ends up in logs and in headers sent to
 * customer apps, so garbage must not pass through as an "IP".
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim().toLowerCase();
  if (!ip) return null;

  if (ip.startsWith("[")) {
    // "[v6]" or "[v6]:port"
    const end = ip.indexOf("]");
    if (end === -1) return null;
    ip = ip.slice(1, end);
  } else if (ip.includes(".") && ip.indexOf(":") === ip.lastIndexOf(":") && ip.includes(":")) {
    // "v4:port"
    ip = ip.slice(0, ip.indexOf(":"));
  }

  if (ip.startsWith("::ffff:") && IPV4.test(ip.slice(7))) {
    ip = ip.slice(7);
  }

  if (IPV4.test(ip)) return ip;
  if (ip.includes(":") && IPV6.test(ip) && ip.length <= 45) return ip;
  return null;
}

/** The comma-separated entries of an X-Forwarded-For value, left to right. */
export function parseForwardedFor(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) | parseInt(octet, 10)) >>> 0, 0);
}

/** Exact match for any address; CIDR match for IPv4 ranges ("10.0.0.0/8"). */
export function ipMatchesAny(ip: string, list: string[]): boolean {
  const addr = normalizeIp(ip);
  if (!addr) return false;
  for (const entry of list) {
    const slash = entry.indexOf("/");
    if (slash === -1) {
      if (normalizeIp(entry) === addr) return true;
      continue;
    }
    const range = normalizeIp(entry.slice(0, slash));
    const bits = Number(entry.slice(slash + 1));
    if (!range || !IPV4.test(range) || !IPV4.test(addr) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      continue;
    }
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((ipv4ToInt(addr) & mask) >>> 0) === ((ipv4ToInt(range) & mask) >>> 0)) return true;
  }
  return false;
}

export interface ClientIpOptions {
  /** Defaults to TRUSTED_PROXY_HOPS. */
  trustedHops?: number;
  /** Defaults to TRUSTED_PROXY_IPS. */
  trustedProxies?: string[];
}

/**
 * The visitor's address, or "unknown".
 *
 * @param req       the request, or just its headers
 * @param socketIp  the TCP peer, from `server.requestIP(req)?.address`
 */
export function getClientIp(
  req: Request | Headers,
  socketIp?: string | null,
  options: ClientIpOptions = {}
): string {
  const headers = req instanceof Headers ? req : req.headers;
  const hops = options.trustedHops ?? trustedProxyHops();
  const socket = normalizeIp(socketIp);

  // Nothing in front of us: every header is the client's own claim.
  if (hops <= 0) return socket ?? "unknown";

  // A connection that didn't come from one of our proxies doesn't get to
  // say who the client is.
  const proxies = options.trustedProxies ?? trustedProxyIps();
  if (proxies.length > 0 && socket && !ipMatchesAny(socket, proxies)) {
    return socket;
  }

  const chain = parseForwardedFor(headers.get("x-forwarded-for"));
  if (chain.length > 0) {
    // Each trusted proxy appended one entry, so the client — as the outermost
    // trusted proxy saw it — sits `hops` places from the right. A chain shorter
    // than that was written entirely by our proxies; its first entry is the
    // furthest-out address any of them recorded.
    const entry = chain[Math.max(0, chain.length - hops)];
    // nginx always writes a valid $remote_addr there; anything else means the
    // request didn't come through it, so fall back to who actually connected.
    return normalizeIp(entry) ?? socket ?? "unknown";
  }

  // A proxy that sets only X-Real-IP ($remote_addr) and not X-Forwarded-For.
  const realIp = normalizeIp(headers.get("x-real-ip"));
  if (realIp) return realIp;

  return socket ?? "unknown";
}

/**
 * Rewrite the client-identifying headers sent on to a customer's app so they
 * carry only what jrok worked out, never what the visitor claimed.
 *
 * Apps commonly read the LEFTMOST X-Forwarded-For entry as the client (Express
 * with `trust proxy`, Rails, Django middlewares, most rate limiters), so passing
 * nginx's chain through would hand them the forged first hop. A single entry is
 * the format they already get from one proxy.
 *
 * `headers` must have lower-case keys (as produced by Headers.forEach).
 */
export function setForwardedClientHeaders(headers: Record<string, string>, clientIp: string | null | undefined): void {
  const ip = normalizeIp(clientIp);
  // RFC 7239 Forwarded: no proxy of ours sets it, so any value is the visitor's.
  delete headers["forwarded"];
  if (ip) {
    headers["x-forwarded-for"] = ip;
    headers["x-real-ip"] = ip;
  } else {
    delete headers["x-forwarded-for"];
    delete headers["x-real-ip"];
  }
}
