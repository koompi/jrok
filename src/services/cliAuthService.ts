/**
 * CLI device-authorization broker.
 *
 * Implements an OAuth-device-flow-style handshake so the CLI can authenticate
 * WITHOUT the user pasting an API key:
 *   1. CLI calls start() -> { deviceCode, userCode }.
 *   2. CLI opens the dashboard at /cli?code=<userCode> and polls poll(deviceCode).
 *   3. The signed-in user approves in the dashboard, which mints an API key and
 *      calls approve(userCode, apiKey, orgId).
 *   4. The CLI's next poll returns the minted key.
 *
 * Sessions are short-lived and held in memory only (single-use credentials).
 */
import crypto from "crypto";

export type DeviceStatus = "pending" | "approved" | "denied" | "expired";

interface DeviceSession {
  deviceCode: string;
  userCode: string;
  label?: string;
  status: "pending" | "approved" | "denied";
  apiKey?: string;
  organizationId?: string;
  createdAt: number;
  expiresAt: number;
}

const byDevice = new Map<string, DeviceSession>();
const byUser = new Map<string, string>(); // userCode -> deviceCode

const TTL_MS = 10 * 60_000; // 10 minutes
const INTERVAL_SEC = 3;
const MAX_SESSIONS = 5_000; // backstop against unbounded growth

// Human-friendly, unambiguous alphabet (no 0/O/1/I).
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genUserCode(): string {
  const bytes = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function normalize(userCode: string): string {
  return userCode.trim().toUpperCase();
}

function cleanup(): void {
  const now = Date.now();
  for (const s of byDevice.values()) {
    if (now > s.expiresAt) remove(s);
  }
}

function remove(s: DeviceSession): void {
  byDevice.delete(s.deviceCode);
  byUser.delete(s.userCode);
}

export function start(label?: string): {
  deviceCode: string;
  userCode: string;
  intervalSec: number;
  expiresInSec: number;
} {
  cleanup();
  if (byDevice.size >= MAX_SESSIONS) {
    // Drop the oldest to make room rather than failing outright.
    const oldest = [...byDevice.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) remove(oldest);
  }
  const deviceCode = crypto.randomBytes(32).toString("hex");
  let userCode = genUserCode();
  while (byUser.has(userCode)) userCode = genUserCode();

  const now = Date.now();
  const session: DeviceSession = {
    deviceCode,
    userCode,
    label: label?.slice(0, 60),
    status: "pending",
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  byDevice.set(deviceCode, session);
  byUser.set(userCode, deviceCode);
  return { deviceCode, userCode, intervalSec: INTERVAL_SEC, expiresInSec: TTL_MS / 1000 };
}

export function poll(deviceCode: string): { status: DeviceStatus; apiKey?: string; organizationId?: string } {
  cleanup();
  const s = byDevice.get(deviceCode);
  if (!s) return { status: "expired" };
  if (Date.now() > s.expiresAt) {
    remove(s);
    return { status: "expired" };
  }
  if (s.status === "approved") {
    const result = { status: "approved" as const, apiKey: s.apiKey, organizationId: s.organizationId };
    remove(s); // single-use: consume on delivery
    return result;
  }
  return { status: s.status };
}

/** Returns the pending session's metadata for an approver, or null if unknown/expired. */
export function peek(userCode: string): { label?: string } | null {
  cleanup();
  const deviceCode = byUser.get(normalize(userCode));
  if (!deviceCode) return null;
  const s = byDevice.get(deviceCode);
  if (!s || s.status !== "pending" || Date.now() > s.expiresAt) return null;
  return { label: s.label };
}

export function approve(userCode: string, apiKey: string, organizationId: string): boolean {
  cleanup();
  const deviceCode = byUser.get(normalize(userCode));
  if (!deviceCode) return false;
  const s = byDevice.get(deviceCode);
  if (!s || s.status !== "pending" || Date.now() > s.expiresAt) return false;
  s.status = "approved";
  s.apiKey = apiKey;
  s.organizationId = organizationId;
  return true;
}
