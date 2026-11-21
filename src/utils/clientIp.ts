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
 *
 * A request another edge forwarded here with the peer key (utils/peerLink.ts)
 * passed one more of our proxies, the sending edge, so it counts one hop more.
 */
import { isFromPeer } from "./peerLink";

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

const HEXTET = /^[0-9a-f]{1,4}$/;

/** An IPv6 address (as normalizeIp returns it) as a 128-bit number, or null. */
function ipv6ToBigInt(ip: string): bigint | null {
  let text = ip;
  // An IPv4 tail ("64:ff9b::192.0.2.1") is the last two hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!IPV4.test(tail)) return null;
    const n = ipv4ToInt(tail);
    text = `${text.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  let value = 0n;
  for (const group of [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest]) {
    if (!HEXTET.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** Exact match for any address; CIDR match for IPv4 ("10.0.0.0/8") and IPv6 ("2606:4700::/32") ranges. */
export function ipMatchesAny(ip: string, list: string[]): boolean {
  const addr = normalizeIp(ip);
  if (!addr) return false;
  const v4 = IPV4.test(addr);
  const addrV6 = v4 ? null : ipv6ToBigInt(addr);
  for (const entry of list) {
    const slash = entry.indexOf("/");
    const range = normalizeIp(slash === -1 ? entry : entry.slice(0, slash));
    if (!range || IPV4.test(range) !== v4) continue;
    const max = v4 ? 32 : 128;
    let bits = max;
    if (slash !== -1) {
      // "10.0.0.0/" once read as /0 and matched every address.
      const text = entry.slice(slash + 1).trim();
      if (!/^\d{1,3}$/.test(text)) continue;
      bits = Number(text);
      if (bits > max) continue;
    }
    if (v4) {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if (((ipv4ToInt(addr) & mask) >>> 0) === ((ipv4ToInt(range) & mask) >>> 0)) return true;
    } else {
      const rangeV6 = ipv6ToBigInt(range);
      if (addrV6 === null || rangeV6 === null) continue;
      const shift = BigInt(128 - bits);
      if (addrV6 >> shift === rangeV6 >> shift) return true;
    }
  }
  return false;
}

/**
 * Cloudflare's addresses (https://www.cloudflare.com/ips-v4 and ips-v6, read
 * 2026-11-21). CLOUDFLARE_IPS (comma-separated) replaces the list, for a range
 * Cloudflare adds before a jrok release does.
 */
export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
];

export function isCloudflareAddress(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const configured = (process.env.CLOUDFLARE_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return ipMatchesAny(ip, configured.length > 0 ? configured : CLOUDFLARE_RANGES);
}

/**
 * Client-address headers no proxy of ours sets (lower-case). The public
 * wildcard entry blanks them in nginx (ansible: jrok_visitor_only_headers,
 * which also lists X-Jrok-Peer-Key, stripped by peerLink.ts); a custom
 * domain's vhost passes them through, so jrok drops them for every app.
 */
export const VISITOR_ONLY_IP_HEADERS = [
  "x-client-ip", "client-ip", "cf-connecting-ip", "true-client-ip", "fastly-client-ip", "x-cluster-client-ip", "fly-client-ip",
];
/** Set by Cloudflare itself: kept when the connection jrok verified is one of Cloudflare's. */
const CLOUDFLARE_IP_HEADERS = new Set(["cf-connecting-ip", "true-client-ip"]);

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
/**
 * Did this connection come from one of our proxies (TRUSTED_PROXY_IPS)? With
 * none configured, every connection is taken to (the setup before it existed).
 * Headers our proxies set (the visitor address, nginx's ACME marker) count
 * only from them: anyone reaching jrok's port directly could write them.
 */
export function fromTrustedProxy(socketIp: string | null | undefined): boolean {
  const proxies = trustedProxyIps();
  const socket = normalizeIp(socketIp);
  return proxies.length === 0 || (socket !== null && ipMatchesAny(socket, proxies));
}

export function getClientIp(
  req: Request | Headers,
  socketIp?: string | null,
  options: ClientIpOptions = {}
): string {
  const headers = req instanceof Headers ? req : req.headers;
  const configuredHops = trustedProxyHops();
  const hops = options.trustedHops ?? (configuredHops > 0 && isFromPeer(headers) ? configuredHops + 1 : configuredHops);
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
 * The same goes for X-Client-IP, CF-Connecting-IP and the like: apps that sit
 * behind Cloudflare or a PaaS take them for the client (request-ip, Laravel's
 * TrustProxies), so a visitor sending one chose the address a custom domain's
 * app logs, rate-limits and allowlists on. They are dropped, except Cloudflare's
 * own two when the connection came from Cloudflare (an orange-clouded custom
 * domain, whose app reads its visitor there).
 *
 * `headers` must have lower-case keys (as produced by Headers.forEach).
 */
export function setForwardedClientHeaders(headers: Record<string, string>, clientIp: string | null | undefined): void {
  const ip = normalizeIp(clientIp);
  // RFC 7239 Forwarded: no proxy of ours sets it, so any value is the visitor's.
  delete headers["forwarded"];
  let fromCloudflare: boolean | null = null;
  for (const name of VISITOR_ONLY_IP_HEADERS) {
    if (!(name in headers)) continue;
    if (CLOUDFLARE_IP_HEADERS.has(name)) {
      fromCloudflare ??= isCloudflareAddress(ip);
      if (fromCloudflare) continue;
    }
    delete headers[name];
  }
  if (ip) {
    headers["x-forwarded-for"] = ip;
    headers["x-real-ip"] = ip;
  } else {
    delete headers["x-forwarded-for"];
    delete headers["x-real-ip"];
  }
}
