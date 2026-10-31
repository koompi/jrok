/**
 * Binary frames on the agent WebSocket (docs/protocol/tunnel-frames.md). The
 * agent builds them in cli/src/index.ts (responseChunkFrame), mirrored below so
 * the wire format is pinned on both sides: a change to either breaks this test.
 */
import { describe, test, expect } from "bun:test";
import { encodeFrame, decodeFrame, FRAME_RESPONSE_CHUNK } from "../src/utils/tunnelFrames";

/** Mirror of the CLI's responseChunkFrame. */
function cliResponseChunkFrame(requestId: string, chunk: Buffer): Buffer {
  const id = Buffer.from(requestId, "utf8");
  return Buffer.concat([Buffer.from([0x01, id.length]), id, chunk]);
}

describe("binary frames", () => {
  test("round trip: kind, request id and every byte of the payload", () => {
    const payload = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    const frame = decodeFrame(encodeFrame(FRAME_RESPONSE_CHUNK, "req-1f2e", payload))!;
    expect(frame.kind).toBe(FRAME_RESPONSE_CHUNK);
    expect(frame.requestId).toBe("req-1f2e");
    expect(Buffer.from(frame.payload).equals(Buffer.from(payload))).toBe(true);
  });

  test("the agent's frames decode on the server", () => {
    const requestId = "6f1c2a4e-9b8d-4c3e-a1f0-2b3c4d5e6f70"; // what jrok's generateId produces
    const chunk = Buffer.from([0x00, 0xff, 0x1f, 0x8b, 0x08]); // binary, starts like gzip
    const frame = decodeFrame(cliResponseChunkFrame(requestId, chunk))!;
    expect(frame).toMatchObject({ kind: FRAME_RESPONSE_CHUNK, requestId });
    expect(Buffer.from(frame.payload).equals(chunk)).toBe(true);
  });

  test("an empty chunk is a valid frame", () => {
    const frame = decodeFrame(encodeFrame(FRAME_RESPONSE_CHUNK, "r", new Uint8Array()))!;
    expect(frame.payload.length).toBe(0);
  });

  test("anything too short to hold a request id is not a frame", () => {
    expect(decodeFrame(new Uint8Array([]))).toBeNull();
    expect(decodeFrame(new Uint8Array([0x01, 0x00, 0x41]))).toBeNull(); // id length 0
    expect(decodeFrame(new Uint8Array([0x01, 0x05, 0x41]))).toBeNull(); // id cut short
  });

  test("request ids must fit in one length byte", () => {
    expect(() => encodeFrame(FRAME_RESPONSE_CHUNK, "", new Uint8Array())).toThrow();
    expect(() => encodeFrame(FRAME_RESPONSE_CHUNK, "x".repeat(256), new Uint8Array())).toThrow();
    expect(decodeFrame(encodeFrame(FRAME_RESPONSE_CHUNK, "x".repeat(255), new Uint8Array([7])))!.requestId.length).toBe(255);
  });

  test("an unknown kind still decodes, so the receiver can ignore it", () => {
    expect(decodeFrame(encodeFrame(0x7f, "r", new Uint8Array([1])))!.kind).toBe(0x7f);
  });
});
