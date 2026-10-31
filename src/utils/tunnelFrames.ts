/**
 * Binary frames on the agent WebSocket (docs/protocol/tunnel-frames.md).
 *
 *   byte 0      frame kind (FRAME_RESPONSE_CHUNK)
 *   byte 1      request id length N (1–255)
 *   2 … 2+N−1   request id, UTF-8
 *   rest        payload bytes
 */
export const FRAME_RESPONSE_CHUNK = 0x01;

export interface BinaryFrame {
  kind: number;
  requestId: string;
  payload: Uint8Array;
}

/** Build a frame. Throws if the request id doesn't fit in 1–255 bytes. */
export function encodeFrame(kind: number, requestId: string, payload: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(requestId);
  if (id.length < 1 || id.length > 255) throw new Error(`request id must be 1–255 bytes, got ${id.length}`);
  const frame = new Uint8Array(2 + id.length + payload.length);
  frame[0] = kind;
  frame[1] = id.length;
  frame.set(id, 2);
  frame.set(payload, 2 + id.length);
  return frame;
}

/** Parse a frame, or null if it is too short to be one. The payload is a view, not a copy. */
export function decodeFrame(data: Uint8Array): BinaryFrame | null {
  if (data.length < 3) return null;
  const idLength = data[1]!;
  if (idLength < 1 || data.length < 2 + idLength) return null;
  return {
    kind: data[0]!,
    requestId: new TextDecoder().decode(data.subarray(2, 2 + idLength)),
    payload: data.subarray(2 + idLength),
  };
}
