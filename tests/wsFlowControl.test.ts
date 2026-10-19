/**
 * Flow control for traffic going to agents (utils/wsFlowControl.ts).
 *
 * Bun drops sends silently once an agent link has 16MB queued, so a visitor
 * flooding an app's WebSocket used to get other visitors' requests to that
 * app dropped (they hung until the 504). These pin the limits that close the
 * flooding visitor first.
 */
import { describe, test, expect } from "bun:test";
import {
  TokenBucket,
  VisitorFrameLimiter,
  bufferedBytes,
  frameByteLength,
  isBacklogged,
  sendOrDrop,
} from "../src/utils/wsFlowControl";
import { relayVisitorFrame } from "../src/services/crossServerService";

const MB = 1024 * 1024;

describe("TokenBucket", () => {
  test("allows the burst, then refills at the rate", () => {
    const bucket = new TokenBucket(100, 200, 0);
    expect(bucket.take(200, 0)).toBe(true);
    expect(bucket.take(1, 0)).toBe(false);
    expect(bucket.take(50, 500)).toBe(true); // 0.5s → 50 tokens
    expect(bucket.take(1, 500)).toBe(false);
  });

  test("never refills past the burst", () => {
    const bucket = new TokenBucket(100, 200, 0);
    expect(bucket.take(200, 0)).toBe(true);
    expect(bucket.take(201, 60_000)).toBe(false);
    expect(bucket.take(200, 60_000)).toBe(true);
  });

  test("rate 0 means unlimited", () => {
    const bucket = new TokenBucket(0, 0, 0);
    expect(bucket.take(10 * MB, 0)).toBe(true);
  });
});

describe("VisitorFrameLimiter", () => {
  const limits = { bytesPerSec: 4 * MB, burstBytes: 16 * MB, messagesPerSec: 500, messageBurst: 1000 };

  test("one max-size (16MB) frame is allowed, a sustained flood is not", () => {
    const limiter = new VisitorFrameLimiter(0, limits);
    expect(limiter.allow(16 * MB, 0)).toBe(true);
    expect(limiter.allow(1 * MB, 0)).toBe(false);
    expect(limiter.allow(4 * MB, 1000)).toBe(true); // a second later, 4MB more
  });

  test("normal chat-sized traffic is never limited", () => {
    const limiter = new VisitorFrameLimiter(0, limits);
    // 100 messages/s of 1KB for 60s
    for (let ms = 0; ms < 60_000; ms += 10) {
      expect(limiter.allow(1024, ms)).toBe(true);
    }
  });

  test("tiny-frame floods hit the message limit", () => {
    const limiter = new VisitorFrameLimiter(0, limits);
    let allowed = 0;
    for (let i = 0; i < 5000; i++) if (limiter.allow(1, 0)) allowed++;
    expect(allowed).toBe(1000);
  });
});

describe("agent link backlog", () => {
  test("reads Bun's getBufferedAmount and a client socket's bufferedAmount", () => {
    expect(bufferedBytes({ getBufferedAmount: () => 5 })).toBe(5);
    expect(bufferedBytes({ bufferedAmount: 7 })).toBe(7);
    expect(bufferedBytes(undefined)).toBe(0);
  });

  test("backlogged above the limit only", () => {
    expect(isBacklogged({ getBufferedAmount: () => 8 * MB }, 8 * MB)).toBe(false);
    expect(isBacklogged({ getBufferedAmount: () => 8 * MB + 1 }, 8 * MB)).toBe(true);
    expect(isBacklogged({ getBufferedAmount: () => 100 * MB }, 0)).toBe(false); // disabled
  });

  test("sendOrDrop reports Bun's dropped send (0) as not sent", () => {
    expect(sendOrDrop({ send: () => 0 }, "x")).toBe(false);
    expect(sendOrDrop({ send: () => -1 }, "x")).toBe(true); // queued under backpressure
    expect(sendOrDrop({ send: () => 12 }, "x")).toBe(true);
    expect(sendOrDrop({ send: () => undefined }, "x")).toBe(true); // non-Bun socket
  });

  test("frame sizes are bytes, not characters", () => {
    expect(frameByteLength("héllo")).toBe(6);
    expect(frameByteLength(Buffer.alloc(10))).toBe(10);
  });
});

describe("cross-server relay", () => {
  test("queues frames before the peer opens, but not without limit", () => {
    const ws: any = { data: { peer: { readyState: 0 }, peerReady: false, pending: [] }, send() {}, close() {} };
    expect(relayVisitorFrame(ws, Buffer.alloc(4 * MB))).toBe(true);
    expect(relayVisitorFrame(ws, Buffer.alloc(4 * MB))).toBe(true);
    expect(relayVisitorFrame(ws, Buffer.alloc(1))).toBe(false); // past 8MB queued
    expect(ws.data.pending.length).toBe(2);
  });

  test("refuses frames while the open peer link is backed up", () => {
    const sent: any[] = [];
    const peer = { readyState: 1, bufferedAmount: 9 * MB, send: (d: any) => sent.push(d) };
    const ws: any = { data: { peer, peerReady: true, pending: [] }, send() {}, close() {} };
    expect(relayVisitorFrame(ws, "x")).toBe(false);
    peer.bufferedAmount = 0;
    expect(relayVisitorFrame(ws, "y")).toBe(true);
    expect(sent).toEqual(["y"]);
  });
});
