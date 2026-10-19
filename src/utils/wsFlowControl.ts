/**
 * Flow control for traffic going TO agents.
 *
 * Every visitor request and WebSocket frame for an app travels to its agent
 * over one WebSocket. Bun buffers up to 16MB per socket (backpressureLimit)
 * and then silently DROPS further sends (send() returns 0). So one visitor
 * streaming WebSocket frames into an app faster than the agent link drains
 * used to get every other visitor's requests to that app dropped: they hung
 * for TUNNEL_REQUEST_TIMEOUT_MS and then failed with 504.
 *
 * Two guards:
 * - Per visitor WebSocket: a byte rate and a message rate (token buckets).
 *   nginx's per-IP request limit only counts the upgrade, not the frames after.
 * - Per agent link: a visitor frame is refused once the agent's send buffer is
 *   past AGENT_WS_BUFFER_LIMIT_BYTES — below Bun's drop point, so requests from
 *   other visitors still get through.
 *
 * Setting any limit to 0 disables it.
 */

const MB = 1024 * 1024;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const WS_VISITOR_MAX_BYTES_PER_SEC = envNumber("WS_VISITOR_MAX_BYTES_PER_SEC", 4 * MB);
// One max-size frame (Bun's default maxPayloadLength is 16MB) always fits.
export const WS_VISITOR_BURST_BYTES = envNumber("WS_VISITOR_BURST_BYTES", 16 * MB);
export const WS_VISITOR_MAX_MESSAGES_PER_SEC = envNumber("WS_VISITOR_MAX_MESSAGES_PER_SEC", 500);
export const WS_VISITOR_MESSAGE_BURST = envNumber("WS_VISITOR_MESSAGE_BURST", 1000);
export const AGENT_WS_BUFFER_LIMIT_BYTES = envNumber("AGENT_WS_BUFFER_LIMIT_BYTES", 8 * MB);

/** Classic token bucket. rate <= 0 means unlimited. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly rate: number, private readonly burst: number, now = Date.now()) {
    this.tokens = burst;
    this.last = now;
  }

  take(amount: number, now = Date.now()): boolean {
    if (this.rate <= 0) return true;
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.rate) / 1000);
    this.last = now;
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }
}

/** Byte and message rate for one visitor WebSocket. */
export class VisitorFrameLimiter {
  private readonly bytes: TokenBucket;
  private readonly messages: TokenBucket;

  constructor(
    now = Date.now(),
    limits = {
      bytesPerSec: WS_VISITOR_MAX_BYTES_PER_SEC,
      burstBytes: WS_VISITOR_BURST_BYTES,
      messagesPerSec: WS_VISITOR_MAX_MESSAGES_PER_SEC,
      messageBurst: WS_VISITOR_MESSAGE_BURST,
    }
  ) {
    this.bytes = new TokenBucket(limits.bytesPerSec, limits.burstBytes, now);
    this.messages = new TokenBucket(limits.messagesPerSec, limits.messageBurst, now);
  }

  allow(byteLength: number, now = Date.now()): boolean {
    return this.messages.take(1, now) && this.bytes.take(byteLength, now);
  }
}

export function frameByteLength(data: string | Buffer | ArrayBuffer | Uint8Array): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  return data.byteLength;
}

/**
 * Bytes queued on a socket and not yet written: Bun's ServerWebSocket
 * (agent links) exposes getBufferedAmount(), a client WebSocket (the
 * cross-server relay) has bufferedAmount.
 */
export function bufferedBytes(ws: any): number {
  if (!ws) return 0;
  if (typeof ws.getBufferedAmount === "function") return ws.getBufferedAmount();
  return typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : 0;
}

export function isBacklogged(ws: any, limit = AGENT_WS_BUFFER_LIMIT_BYTES): boolean {
  return limit > 0 && bufferedBytes(ws) > limit;
}

/**
 * Send, reporting whether the message was accepted. Bun's ServerWebSocket
 * returns 0 when it dropped the message; other sockets return nothing.
 */
export function sendOrDrop(ws: { send(data: any): unknown }, data: string | Buffer): boolean {
  return ws.send(data) !== 0;
}
