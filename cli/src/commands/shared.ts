import type { Command } from "commander";
import { resolveContext, type CliContext } from "../config";
import { KproxyApi, ApiError } from "../api";
import { out, isJson } from "../output";

export interface GlobalOpts {
  server?: string;
  auth?: string;
  org?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

export function globalsFrom(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals() as GlobalOpts;
}

export function contextFrom(cmd: Command): CliContext {
  const g = globalsFrom(cmd);
  return resolveContext({ server: g.server, auth: g.auth, org: g.org });
}

/** Build an API client from the resolved context, failing fast if auth is required but missing. */
export function apiFrom(cmd: Command, requireAuth = true): { api: KproxyApi; ctx: CliContext } {
  const ctx = contextFrom(cmd);
  if (requireAuth && !ctx.authToken) {
    fail("Not authenticated. Run `kproxy login`, pass --auth <key>, or set KPROXY_AUTH.");
  }
  return { api: new KproxyApi(ctx.serverUrl, ctx.authToken), ctx };
}

/** Print an error (respecting --json) and exit. */
export function fail(message: string, code = 1): never {
  if (isJson()) {
    out.json({ success: false, error: message });
  } else {
    out.error(message);
  }
  process.exit(code);
}

export function handleError(err: unknown): never {
  if (err instanceof ApiError) {
    fail(err.status ? `API error (${err.status}): ${err.message}` : err.message);
  }
  fail(err instanceof Error ? err.message : String(err));
}

export function maskKey(key?: string): string {
  if (!key) return "(none)";
  if (key.length <= 12) return key.slice(0, 4) + "…";
  return key.slice(0, 10) + "…" + key.slice(-4);
}
