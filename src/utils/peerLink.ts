/**
 * How edges reach each other (P10, plan step 1.5 in
 * docs/plans/jrok-scale-out-plan.md).
 *
 * An edge forwards a request to the edge holding the app's agent. That used to
 * be plain http:// to the peer's jrok port: readable by anyone on the path once
 * edges sit in different data centres, and the peer believed the visitor IP
 * the connection claimed because it came from an allowed address.
 *
 * With FORWARD_URL set (https://<this edge's own name>), each edge records it
 * in serverHeartbeats and the others forward there instead: TLS to the peer's
 * nginx, verified against that name, into its edge-to-edge server block, which
 * hands the request to the local jrok (Ansible: nginx role). Every forwarded
 * request carries
 *
 *   X-Jrok-Peer-Key        the shared JROK_PEER_KEY: another edge sent this
 *   X-Jrok-Forwarded-Host  the visitor's Host (Host itself names the edge)
 *
 * A request with the right key passed two of our proxies (the sending edge,
 * then this nginx), so the visitor is one more hop from the right in
 * X-Forwarded-For (clientIp.ts). Neither header reaches a customer's app.
 *
 * Without FORWARD_URL (one edge, or a peer not yet upgraded) forwarding stays
 * plain http to serverHost:serverPort, as before.
 */
import { createHash, timingSafeEqual } from "crypto";

export const PEER_KEY_HEADER = "X-Jrok-Peer-Key";
export const FORWARDED_HOST_HEADER = "X-Jrok-Forwarded-Host";

/** Shorter keys are ignored: they could be guessed. `openssl rand -hex 32` */
const MIN_PEER_KEY_LENGTH = 32;

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** The key edges prove themselves to each other with, or null when unset or too short. */
export function peerKey(): string | null {
  const key = (process.env.JROK_PEER_KEY || "").trim();
  if (!key) return null;
  if (key.length < MIN_PEER_KEY_LENGTH) {
    warnOnce(`⚠️ JROK_PEER_KEY ignored: shorter than ${MIN_PEER_KEY_LENGTH} characters`);
    return null;
  }
  return key;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** True if another edge sent this request: it carries this edge's peer key. */
export function isFromPeer(headers: Headers): boolean {
  const presented = headers.get(PEER_KEY_HEADER);
  if (!presented) return false;
  const key = peerKey();
  // Compared as digests: equal length, and the time taken says nothing about the key.
  return key !== null && timingSafeEqual(digest(presented), digest(key));
}

/** This edge's FORWARD_URL as an origin ("https://edge-a.example.com"), or null. */
export function ownForwardUrl(): string | null {
  const raw = (process.env.FORWARD_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http(s)");
    if (url.protocol === "http:") warnOnce(`⚠️ FORWARD_URL ${raw} is not https: other edges will reach this one unencrypted`);
    return url.origin;
  } catch {
    warnOnce(`⚠️ FORWARD_URL ignored: "${raw}" is not an http(s) URL`);
    return null;
  }
}

/** Where to reach another edge: its FORWARD_URL, else its jrok port directly (plain). */
export function peerOrigin(
  target: { serverHost: string; serverPort: number; forwardUrl?: string },
  websocket = false
): string {
  const origin = target.forwardUrl || `http://${target.serverHost}:${target.serverPort}`;
  return websocket ? origin.replace(/^http/, "ws") : origin;
}

/**
 * The headers that say who the request is for and who sent it, on a request to
 * another edge. `set` and `remove` work on either a Headers or a plain object.
 */
export function addressPeerRequest(
  target: { forwardUrl?: string },
  originalHost: string | null,
  set: (name: string, value: string) => void,
  remove: (name: string) => void
): void {
  // Never pass on what a visitor sent under these names.
  remove(PEER_KEY_HEADER);
  remove(FORWARDED_HOST_HEADER);

  if (target.forwardUrl) {
    // Host is the edge's name (the URL's); the peer's nginx restores the
    // visitor's from X-Jrok-Forwarded-Host.
    remove("host");
    if (originalHost) set(FORWARDED_HOST_HEADER, originalHost);
    const key = peerKey();
    if (key) set(PEER_KEY_HEADER, key);
    else warnOnce("⚠️ JROK_PEER_KEY unset: edges receiving forwarded requests will not trust the visitor IP they carry");
  } else if (originalHost) {
    // Straight to the peer's jrok, which resolves the tunnel from Host.
    set("host", originalHost);
  }
}

/** Drop the edge-to-edge headers from what is sent on to a customer's app (lower-case keys). */
export function stripPeerHeaders(headers: Record<string, string>): void {
  delete headers[PEER_KEY_HEADER.toLowerCase()];
  delete headers[FORWARDED_HOST_HEADER.toLowerCase()];
}
