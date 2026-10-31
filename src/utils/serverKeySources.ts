/**
 * Where the server key (API_KEY, JROK_ADMIN_KEY) is accepted from (plan 3.4).
 *
 * The server key opens every privileged endpoint: suspensions, IP blocks,
 * certificates, cluster stats. With SERVER_KEY_SOURCES set (IPs and IPv4
 * CIDRs, comma-separated: kconsole's addresses and the edges, from Ansible),
 * a request carrying it from anywhere else is refused, so a leaked key is
 * useless elsewhere. This machine (loopback: the certbot hook, deploys) is
 * always allowed. Unset: accepted from anywhere, as before. Super-admin
 * sessions and API keys are not affected.
 */
import { ipMatchesAny } from "./clientIp";

export function serverKeySources(): string[] {
  return (process.env.SERVER_KEY_SOURCES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** May a request from `clientIp` (as jrok worked it out, utils/clientIp.ts) use the server key? */
export function serverKeyAllowedFrom(clientIp: string, sources = serverKeySources()): boolean {
  if (sources.length === 0) return true;
  return ipMatchesAny(clientIp, ["127.0.0.1", "::1", ...sources]);
}
