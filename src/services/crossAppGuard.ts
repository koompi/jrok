/**
 * One customer's app riding another customer's visitors (J1).
 *
 * Every app lives on a sibling name of one site: shop.public.koompi.cloud and
 * evil.public.koompi.cloud are both koompi.cloud to a browser. SameSite then
 * protects nothing between them: a page on evil.* can POST a form, fetch() with
 * credentials, or open a WebSocket to shop.*, and the browser sends shop's
 * cookies (Lax and Strict included) — cross-site request forgery and WebSocket
 * hijacking that a stranger's site could not do. (Cookies set by one app for
 * the whole site, "cookie tossing", are only reported: an app may share them
 * with its own siblings, and only the Public Suffix List stops the rest.)
 *
 * Checked on the edge holding the app's agent, just before the request goes
 * to it (a request another edge forwarded is checked once, here). Flagged:
 * a request with cookies, from a page on a sibling app (its Origin; a POST
 * without one, its Referer), to an app of a different customer (appGroups.ts):
 * "cross-org", or "unknown" when KOOMPI Cloud didn't say whose one of them is.
 * A GET carries an Origin only from a script (fetch, XHR, a WebSocket), never
 * from a link: following links between apps is never flagged. A page can hide
 * where it is (Referrer-Policy: no-referrer makes its form's Origin "null"),
 * but the browser still says the request came from another name of the site
 * (Sec-Fetch-Site: same-site): "hidden".
 *
 *   CROSS_APP_GUARD=report    default: log it, change nothing
 *   CROSS_APP_GUARD=enforce   also send "cross-org" and "hidden" requests on
 *                             without the visitor's cookies; "unknown" is
 *                             only reported
 *   CROSS_APP_GUARD=off
 *
 * The log (deduplicated per pair per 10 minutes) is how to tell, before
 * enforcing, which apps rely on another customer's app (none should).
 */
import { allBaseDomains, extractSubdomain, matchBaseDomain, primaryBaseDomain } from "../utils/baseDomains";
import { normalizeHostname } from "../utils/hostRouting";
import { groupOfDomain, groupOfLabel } from "./appGroups";

export type CrossAppMode = "off" | "report" | "enforce";
export type CrossAppVerdict = "cross-org" | "unknown" | "hidden";

const warned = new Set<string>();

export function crossAppMode(): CrossAppMode {
  const raw = (process.env.CROSS_APP_GUARD || "").trim().toLowerCase();
  if (raw === "" || raw === "report") return "report";
  if (raw === "off" || raw === "enforce") return raw;
  if (!warned.has(raw)) {
    warned.add(raw);
    console.warn(`⚠️ CROSS_APP_GUARD="${raw}" is not off, report or enforce: reporting only`);
  }
  return "report";
}

/**
 * The site every app shares: JROK_SITE, else the primary base domain's parent
 * ("koompi.cloud" for public.koompi.cloud; a two-label base is its own).
 */
export function siteDomain(): string {
  const configured = normalizeHostname(process.env.JROK_SITE || "");
  if (configured) return configured;
  const base = primaryBaseDomain();
  const labels = base.split(".");
  return labels.length >= 3 ? labels.slice(1).join(".") : base;
}

type App = { kind: "label" | "domain"; name: string };

/** The app on this host, if it is one of ours on the shared site. */
function appOn(host: string): App | null {
  if (matchBaseDomain(host) !== null) {
    const name = extractSubdomain(host);
    return name ? { kind: "label", name } : null;
  }
  const site = siteDomain();
  // A custom domain on the site is an app only if KOOMPI Cloud listed it: the
  // site's other hosts (its console, its API) are not customers'.
  if ((host === site || host.endsWith(`.${site}`)) && groupOfDomain(host) !== undefined) return { kind: "domain", name: host };
  return null;
}

const groupOf = (app: App) => (app.kind === "label" ? groupOfLabel(app.name) : groupOfDomain(app.name));

function hostOf(value: string | null): string | null {
  if (!value || value === "null") return null;
  try {
    return normalizeHostname(new URL(value).hostname);
  } catch {
    return null;
  }
}

export interface CrossAppFinding {
  verdict: CrossAppVerdict;
  from: string;
  to: string;
  /** Send it on without the visitor's cookies (enforce; cross-org or hidden). */
  dropCookie: boolean;
}

/**
 * Check a request about to go to the app on `host` (normalized). Null when
 * there is nothing to say: no cookies, not from a sibling app, the same app or
 * customer, or the guard is off.
 */
export function checkCrossAppRequest(method: string, headers: Headers, host: string): CrossAppFinding | null {
  const mode = crossAppMode();
  if (mode === "off") return null;
  if (!(headers.get("cookie") || "").trim()) return null;
  const verb = method.toUpperCase();
  if (verb === "OPTIONS") return null; // a preflight never carries cookies
  const websocket = (headers.get("upgrade") || "").toLowerCase() === "websocket";
  const unsafe = !websocket && verb !== "GET" && verb !== "HEAD";

  const origin = headers.get("origin");
  let fromHost = hostOf(origin);
  // A browser always sends Origin on a POST; an old one may give only Referer.
  // A GET's Referer is a followed link: never a finding.
  if (!fromHost && origin === null && unsafe) fromHost = hostOf(headers.get("referer"));
  if (fromHost === host) return null;

  const to = appOn(host);
  if (!to) return null;

  let verdict: CrossAppVerdict;
  let fromName: string;
  if (fromHost) {
    const from = appOn(fromHost);
    if (!from || (from.kind === to.kind && from.name === to.name)) return null;
    const fromGroup = groupOf(from);
    const toGroup = groupOf(to);
    if (fromGroup !== undefined && fromGroup === toGroup) return null;
    verdict = fromGroup !== undefined && toGroup !== undefined ? "cross-org" : "unknown";
    fromName = from.name;
  } else if (unsafe && (origin === null || origin === "null") && headers.get("sec-fetch-site") === "same-site") {
    verdict = "hidden";
    fromName = "(a page that hid its origin)";
  } else {
    return null;
  }

  const finding: CrossAppFinding = { verdict, from: fromName, to: to.name, dropCookie: mode === "enforce" && verdict !== "unknown" };
  const outcome = finding.dropCookie ? "cookies dropped" : mode === "enforce" ? "passed: customer unknown" : "report only";
  report(`${verdict}|${fromName}|${to.name}`, () => `${verdict}: ${fromName} -> ${to.name} (${websocket ? "websocket" : verb}, ${outcome})`);
  return finding;
}

/** The Domain attribute of a Set-Cookie value, normalized, or null. */
function cookieDomain(setCookie: string): string | null {
  for (const part of setCookie.split(";").slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim().toLowerCase() !== "domain") continue;
    const domain = part.slice(eq + 1).trim().toLowerCase().replace(/^\.+/, "");
    return domain || null;
  }
  return null;
}

/**
 * Report an app setting a cookie for the shared site or a base domain: every
 * other app under it gets that cookie (cookie tossing). Report only.
 */
export function noteResponseCookies(host: string, headers: Headers): void {
  if (crossAppMode() === "off" || !headers.has("set-cookie")) return;
  const to = appOn(host);
  if (!to) return;
  const shared = [siteDomain(), ...allBaseDomains()];
  for (const cookie of headers.getSetCookie()) {
    const domain = cookieDomain(cookie);
    if (!domain || !shared.some((d) => d === domain || d.endsWith(`.${domain}`))) continue;
    report(`cookie|${to.name}|${domain}`, () => `cookie: ${to.name} sets a cookie for ${domain}, which every app under it receives (report only)`);
  }
}

// ---- The log: one line when a pair is first seen, then a count per window ----

export const REPORT_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED = 10_000;
const seen = new Map<string, { since: number; count: number; line: string }>();
let overflowNoted = false;
let log: (line: string) => void = (line) => console.warn(`🧭 cross-app ${line}`);
let sweepTimer: Timer | null = null;

function report(key: string, line: () => string): void {
  const now = Date.now();
  const entry = seen.get(key);
  if (entry && now - entry.since < REPORT_WINDOW_MS) {
    entry.count++;
    return;
  }
  if (entry) flush(entry);
  if (!entry && seen.size >= MAX_TRACKED) {
    sweep(now);
    if (seen.size >= MAX_TRACKED) {
      if (!overflowNoted) log(`more than ${MAX_TRACKED} pairs in ${REPORT_WINDOW_MS / 60_000} minutes; the rest are not logged`);
      overflowNoted = true;
      return;
    }
  }
  const text = line();
  seen.set(key, { since: now, count: 1, line: text });
  log(text);
  if (!sweepTimer) {
    sweepTimer = setInterval(() => sweep(Date.now()), REPORT_WINDOW_MS);
    sweepTimer.unref?.();
  }
}

function flush(entry: { count: number; line: string }): void {
  if (entry.count > 1) log(`${entry.line}: ${entry.count} in ${REPORT_WINDOW_MS / 60_000} minutes`);
}

function sweep(now: number): void {
  for (const [key, entry] of seen) {
    if (now - entry.since < REPORT_WINDOW_MS) continue;
    flush(entry);
    seen.delete(key);
  }
  overflowNoted = false;
}

/** For tests: capture the log, forget what was seen. */
export function resetCrossAppReports(capture?: (line: string) => void): void {
  seen.clear();
  overflowNoted = false;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  log = capture ?? ((line) => console.warn(`🧭 cross-app ${line}`));
}

/** For tests: end the window now. */
export function flushCrossAppReports(): void {
  sweep(Number.POSITIVE_INFINITY);
}
