/**
 * The pages a visitor gets instead of the app: jrok's index.html with the
 * words and the picture (scenes/<scene>.svg, next to it) for each case, then
 * the host, this edge and the time filled in, HTML-escaped.
 *
 *   tunnel-down    an app whose tunnel is down (no agent connected): 503
 *   reconnecting   its agent is known but its socket isn't open, or it went
 *                  away before answering, or the edge holding it can't be
 *                  reached: 503 or 502
 *   no-answer      the app didn't start answering in time: 504
 *   domain-pending a custom domain added to an app, still being verified or
 *                  getting its certificate: 503
 *   domain-unknown a name that points at the edges but no app uses: 404
 *
 * The files are kept in memory and looked at again at most every 30 s: a
 * changed file is read again, so a new page needs no jrok restart. During an
 * outage every visitor gets one, so a page is filled in once per case and
 * file version, and only the host, edge and time per request.
 *
 * The waiting cases check by themselves whether the app is back (a HEAD of
 * the same address carrying PAGE_CHECK_HEADER, answered like a page load) and
 * open it as soon as it answers.
 */
import { readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { isPageLoad, normalizeHostname } from "./hostRouting";

export type StatusPageKind = "tunnel-down" | "reconnecting" | "no-answer" | "domain-pending" | "domain-unknown";

const DASHBOARD = "https://koompi.cloud/dashboard";
const DASHBOARD_LINK = `<a href="${DASHBOARD}">KOOMPI Cloud dashboard</a>`;

/** Sent by a waiting page's own check whether the app is back (index.html). */
export const PAGE_CHECK_HEADER = "X-Jrok-Page-Check";

interface PageWords {
  /** The status it is normally served with (the footer shows the real one). */
  status: number;
  /** scenes/<scene>.svg */
  scene: string;
  /** Seconds between checks whether the app is back, the last repeating; empty: only the button. */
  retry: number[];
  /** Seconds after which the page stops checking. */
  stop: number;
  title: string;
  pill: string;
  heading: string;
  /** HTML. */
  lead: string;
  km: string;
  /** HTML. */
  help: string;
}

const PAGES: Record<StatusPageKind, PageWords> = {
  "tunnel-down": {
    status: 503,
    scene: "down",
    retry: [5, 10, 15, 30, 60],
    stop: 600,
    title: "{{HOST}} will be back soon",
    pill: "Offline for now",
    heading: "This app is taking a short break",
    lead: "It isn’t running right now, most likely because it’s restarting or being updated. That usually takes a minute or two. This page keeps checking and opens the app as soon as it’s back.",
    km: "កម្មវិធីនេះមិនដំណើរការនៅពេលនេះទេ ប្រហែលជាកំពុងចាប់ផ្ដើមឡើងវិញ ឬកំពុងធ្វើបច្ចុប្បន្នភាព។ ទំព័រនេះនឹងបើកវាដោយស្វ័យប្រវត្តិ នៅពេលវាដំណើរការវិញ។",
    help: `<p><strong>Is this your app?</strong> See its status and logs in your ${DASHBOARD_LINK}.</p>`,
  },
  reconnecting: {
    status: 503,
    scene: "reconnecting",
    retry: [3, 5, 10, 20, 30, 60],
    stop: 600,
    title: "Reconnecting to {{HOST}}",
    pill: "Reconnecting",
    heading: "Reconnecting to this app",
    lead: "Its connection to KOOMPI Cloud dropped for a moment. It usually comes back by itself within a few seconds, and this page opens the app as soon as it does.",
    km: "ការតភ្ជាប់ទៅកម្មវិធីនេះបានដាច់មួយភ្លែត។ ជាធម្មតាវាភ្ជាប់ឡើងវិញដោយខ្លួនឯងក្នុងរយៈពេលប៉ុន្មានវិនាទី ហើយទំព័រនេះនឹងបើកកម្មវិធីភ្លាមៗ។",
    help: `<p><strong>Is this your app?</strong> If this lasts more than a minute or two, check its logs in your ${DASHBOARD_LINK}.</p>`,
  },
  "no-answer": {
    status: 504,
    scene: "slow",
    retry: [15, 30, 60],
    stop: 600,
    title: "{{HOST}} is taking too long",
    pill: "No answer yet",
    heading: "This app is taking too long to answer",
    lead: "It’s running, but it didn’t answer in time. It may be busy, or stuck on a slow task. This page will try again in a moment.",
    km: "កម្មវិធីនេះឆ្លើយតបយឺតពេក។ វាប្រហែលជារវល់ ឬកំពុងធ្វើការងារដែលចំណាយពេលយូរ។ ទំព័រនេះនឹងព្យាយាមម្ដងទៀតក្នុងពេលបន្តិចទៀត។",
    help: `<p><strong>Is this your app?</strong> It got the request but didn’t send an answer. Its logs in your ${DASHBOARD_LINK} show what it was doing.</p>`,
  },
  "domain-pending": {
    status: 503,
    scene: "ready",
    retry: [10, 15, 30],
    stop: 900,
    title: "{{HOST}} is getting ready",
    pill: "Getting ready",
    heading: "This domain is almost ready",
    lead: "It was just added to an app on KOOMPI Cloud. Its DNS records are being checked and its HTTPS certificate set up, which usually takes a minute or two. This page opens the app as soon as it’s ready.",
    km: "ឈ្មោះដែននេះកំពុងត្រូវបានរៀបចំ។ ជាធម្មតាវាចំណាយពេលមួយ ឬពីរនាទី ហើយទំព័រនេះនឹងព្យាយាមម្ដងទៀតដោយខ្លួនឯង។",
    help: `<p><strong>Is this your domain?</strong> If this page stays for more than a few minutes, check its DNS records on your app’s Domains tab in the ${DASHBOARD_LINK}.</p>`,
  },
  "domain-unknown": {
    status: 404,
    scene: "not-found",
    retry: [],
    stop: 0,
    title: "No app at {{HOST}}",
    pill: "Not found",
    heading: "No app lives here",
    lead: "This address points to KOOMPI Cloud, but no app uses it.",
    km: "ឈ្មោះដែននេះចង្អុលមក KOOMPI Cloud ប៉ុន្តែមិនទាន់ភ្ជាប់ជាមួយកម្មវិធីណាមួយនៅឡើយទេ។",
    help: `<p><strong>A few things to check</strong></p><ul><li>Is the address spelled right?</li><li>If you followed a link, the app may have moved to another address or been deleted.</li><li>Is this your domain? Open your app in the ${DASHBOARD_LINK} and add it on the Domains tab.</li></ul>`,
  },
};

// ---------------------------------------------------------------------------
// Files, kept in memory and looked at again at most every RECHECK_MS
// ---------------------------------------------------------------------------

const RECHECK_MS = 30_000;

interface CachedFile {
  text: string | null;
  mtimeMs: number;
  checkedAt: number;
}

const files = new Map<string, CachedFile>();

/**
 * The file's text, read again when its modification time changed. A file
 * that can't be read keeps its last good text (a deploy replacing it), or is
 * null if it never could be.
 */
function cachedFile(path: string): string | null {
  const now = Date.now();
  const entry = files.get(path);
  if (entry && now - entry.checkedAt < RECHECK_MS) return entry.text;
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {}
  if (entry && entry.mtimeMs === mtimeMs) {
    entry.checkedAt = now;
    return entry.text;
  }
  let text: string | null = null;
  if (mtimeMs >= 0) {
    try {
      text = readFileSync(path, "utf8");
    } catch {}
  }
  const next = { text: text ?? entry?.text ?? null, mtimeMs, checkedAt: now };
  files.set(path, next);
  return next.text;
}

/** An SVG file as markup for inside the page: no XML declaration or comments. */
function inlineSvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

/** Filled in once per case, status and file versions. */
const filled = new Map<string, { template: string; scene: string; page: string }>();

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The HTTP status each page is normally served with. */
export function statusPageCode(kind: StatusPageKind): number {
  return PAGES[kind].status;
}

/**
 * The page, or null if the template can't be read (the caller answers JSON
 * then). A missing picture leaves the page without one. `status` is the code
 * shown in the footer, when it isn't the case's usual one.
 */
export function statusPage(
  templatePath: string,
  kind: StatusPageKind,
  host: string,
  edge: string,
  now = new Date(),
  status = PAGES[kind].status,
): string | null {
  const template = cachedFile(templatePath);
  if (template === null) return null;
  const words = PAGES[kind];
  const scene = cachedFile(join(dirname(templatePath), "scenes", `${words.scene}.svg`)) ?? "";

  const key = `${templatePath}\n${kind}\n${status}`;
  let page = filled.get(key);
  if (!page || page.template !== template || page.scene !== scene) {
    // The fixed words first; the scene is ours too.
    const text = template
      .replaceAll("{{KIND}}", kind)
      .replaceAll("{{TITLE}}", words.title)
      .replaceAll("{{STATUS}}", words.pill)
      .replaceAll("{{HEADING}}", words.heading)
      .replaceAll("{{LEAD}}", words.lead)
      .replaceAll("{{KM}}", words.km)
      .replaceAll("{{HELP}}", words.help)
      .replaceAll("{{SCENE}}", inlineSvg(scene))
      .replaceAll("{{CODE}}", String(status))
      .replaceAll("{{RETRY}}", words.retry.join(","))
      .replaceAll("{{STOP}}", String(words.stop));
    page = { template, scene, page: text };
    filled.set(key, page);
  }

  const time = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  // The visitor's host last, so nothing in it is ever read as a placeholder.
  return page.page
    .replaceAll("{{EDGE}}", escapeHtml(edge))
    .replaceAll("{{TIME}}", time)
    .replaceAll("{{HOST}}", escapeHtml(host));
}

/** The tunnel-down page. */
export function maintenancePage(templatePath: string, host: string, edge: string, now = new Date()): string | null {
  return statusPage(templatePath, "tunnel-down", host, edge, now);
}

/**
 * A browser opening a page (utils/hostRouting.ts), or a waiting page checking
 * whether the app is back. Only these get a page instead of jrok's JSON.
 */
export function wantsPage(method: string, headers: Headers): boolean {
  if (isPageLoad(method, headers)) return true;
  return (method === "GET" || method === "HEAD") && headers.get(PAGE_CHECK_HEADER) === "1";
}

/**
 * jrok's own answer to a visitor, as a page for a browser opening it and
 * unchanged for everyone else (API clients, a page's own fetches, the deploy
 * worker's health check). The page keeps the answer's status and every one
 * of its headers; only Content-Type becomes HTML, with Cache-Control no-store.
 */
export function pageInstead(
  req: Request,
  answer: Response,
  kind: StatusPageKind,
  templatePath: string,
  edge: string,
): Response {
  if (!wantsPage(req.method, req.headers)) return answer;
  let host: string;
  try {
    host = normalizeHostname(new URL(req.url).hostname);
  } catch {
    return answer;
  }
  const page = statusPage(templatePath, kind, host, edge, new Date(), answer.status);
  if (page === null) return answer;
  // Its JSON isn't sent; let go of it (another edge's answer is a stream).
  try {
    answer.body?.cancel().catch(() => {});
  } catch {}
  const headers = new Headers(answer.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.delete("Content-Length");
  return new Response(req.method === "HEAD" ? null : page, { status: answer.status, statusText: answer.statusText, headers });
}
