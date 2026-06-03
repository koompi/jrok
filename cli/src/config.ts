import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { DEFAULT_SERVER } from "./version";

export interface ProfileConfig {
  serverUrl?: string;
  apiKey?: string;
  organizationId?: string;
  organizationName?: string;
}

export interface StoredConfig extends ProfileConfig {
  lastUpdateCheck?: number;
  skipUpdateCheck?: boolean;
  currentProfile?: string;
  profiles?: Record<string, ProfileConfig>;
}

const CONFIG_DIR = join(homedir(), ".kproxy");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
// Legacy location (pre-rename) — read once and migrated to ~/.kproxy.
const LEGACY_CONFIG_FILE = join(homedir(), ".jrok", "config.json");

export const configPaths = { dir: CONFIG_DIR, file: CONFIG_FILE, legacy: LEGACY_CONFIG_FILE };

export function loadConfig(): StoredConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as StoredConfig;
    }
    if (existsSync(LEGACY_CONFIG_FILE)) {
      const legacy = JSON.parse(readFileSync(LEGACY_CONFIG_FILE, "utf-8")) as StoredConfig;
      saveConfig(legacy); // migrate forward so future runs use ~/.kproxy
      return legacy;
    }
  } catch {
    // Corrupt/unreadable config — fall back to empty rather than crashing.
  }
  return {};
}

export function saveConfig(config: StoredConfig): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    try {
      chmodSync(CONFIG_FILE, 0o600);
    } catch {
      // chmod is a no-op on some platforms (Windows) — ignore.
    }
  } catch (err) {
    process.stderr.write(`⚠ Could not save config: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** The stored values for the active profile (currentProfile overlaid on the root config). */
export function activeProfile(config: StoredConfig): ProfileConfig {
  const base: ProfileConfig = {
    serverUrl: config.serverUrl,
    apiKey: config.apiKey,
    organizationId: config.organizationId,
    organizationName: config.organizationName,
  };
  const name = config.currentProfile;
  if (name && config.profiles?.[name]) {
    return { ...base, ...config.profiles[name] };
  }
  return base;
}

export interface CliContext {
  serverUrl: string;
  authToken?: string;
  organizationId?: string;
  organizationName?: string;
}

/**
 * Resolve the effective context from (in priority order): explicit flags, env vars
 * (KPROXY_* then legacy JROK_*), the stored/active-profile config, then defaults.
 */
export function resolveContext(opts: { server?: string; auth?: string; org?: string } = {}): CliContext {
  const stored = activeProfile(loadConfig());
  const env = process.env;
  return {
    serverUrl: opts.server || env.KPROXY_SERVER || env.JROK_SERVER || stored.serverUrl || DEFAULT_SERVER,
    authToken: opts.auth || env.KPROXY_AUTH || env.JROK_AUTH || stored.apiKey,
    organizationId: opts.org || env.KPROXY_ORG || env.JROK_ORG || stored.organizationId,
    organizationName: stored.organizationName,
  };
}
