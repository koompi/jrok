/**
 * The pages a visitor gets instead of the app (jrok's index.html), with the
 * words for each case, the host, this edge and the time filled in. Read once
 * and kept: during an outage every visitor gets one.
 *
 *   tunnel-down    an app whose tunnel is down (no agent connected)
 *   domain-pending a custom domain added to an app, still being verified or
 *                  getting its certificate; the page reloads itself
 *   domain-unknown a name that points at the edges but no app uses
 */
import { readFileSync } from "fs";

export type StatusPageKind = "tunnel-down" | "domain-pending" | "domain-unknown";

const DASHBOARD = "https://koompi.cloud/dashboard";

interface PageWords {
  status: number;
  /** Seconds between automatic reloads, the last repeating; empty: only the button. */
  retry: number[];
  title: string;
  pill: string;
  heading: string;
  /** HTML; {{HOST}} becomes the escaped host. */
  lead: string;
  km: string;
  /** HTML. */
  owner: string;
}

const HOST = `<span class="host">{{HOST}}</span>`;

const PAGES: Record<StatusPageKind, PageWords> = {
  "tunnel-down": {
    status: 503,
    retry: [20, 40, 60],
    title: "{{HOST}} is unavailable",
    pill: "Temporarily unavailable",
    heading: "This app isn’t available right now.",
    lead: `${HOST} runs on KOOMPI Cloud and isn’t answering at the moment. It may be restarting or being updated, so this page will try again by itself.`,
    km: "គេហទំព័រនេះមិនអាចចូលបានជាបណ្ដោះអាសន្ន។ សូមព្យាយាមម្ដងទៀតក្នុងពេលបន្តិចទៀត។",
    owner: `Is this your app? See its status and logs in your <a href="${DASHBOARD}">KOOMPI Cloud dashboard</a>.`,
  },
  "domain-pending": {
    status: 503,
    retry: [10],
    title: "{{HOST}} is getting ready",
    pill: "Getting ready",
    heading: "This domain is almost ready.",
    lead: `${HOST} was just added to an app on KOOMPI Cloud. Its DNS records are being checked and its HTTPS certificate set up, which usually takes a minute or two. This page will try again by itself.`,
    km: "ឈ្មោះដែននេះកំពុងត្រូវបានរៀបចំ។ ជាធម្មតាវាចំណាយពេលមួយ ឬពីរនាទី ហើយទំព័រនេះនឹងព្យាយាមម្ដងទៀតដោយខ្លួនឯង។",
    owner: `Is this your domain? If this page stays for more than a few minutes, check its DNS records on your app’s Domains tab in the <a href="${DASHBOARD}">KOOMPI Cloud dashboard</a>.`,
  },
  "domain-unknown": {
    status: 404,
    retry: [],
    title: "{{HOST}} isn’t connected",
    pill: "Not connected",
    heading: "This domain isn’t connected to an app.",
    lead: `${HOST} points to KOOMPI Cloud, but no app here uses it yet.`,
    km: "ឈ្មោះដែននេះចង្អុលមក KOOMPI Cloud ប៉ុន្តែមិនទាន់ភ្ជាប់ជាមួយកម្មវិធីណាមួយនៅឡើយទេ។",
    owner: `Is this your domain? Open your app in the <a href="${DASHBOARD}">KOOMPI Cloud dashboard</a> and add it on the Domains tab.`,
  },
};

let template: string | null | undefined;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The HTTP status each page is served with. */
export function statusPageCode(kind: StatusPageKind): number {
  return PAGES[kind].status;
}

/** The page, or null if the template can't be read (the caller answers JSON then). */
export function statusPage(templatePath: string, kind: StatusPageKind, host: string, edge: string, now = new Date()): string | null {
  if (template === undefined) {
    try {
      template = readFileSync(templatePath, "utf8");
    } catch {
      template = null;
    }
  }
  if (template === null) return null;
  const words = PAGES[kind];
  const time = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  // The fixed words first and the visitor's host last, so nothing in the host
  // is ever read as a placeholder.
  return template
    .replaceAll("{{TITLE}}", words.title)
    .replaceAll("{{STATUS}}", words.pill)
    .replaceAll("{{HEADING}}", words.heading)
    .replaceAll("{{LEAD}}", words.lead)
    .replaceAll("{{KM}}", words.km)
    .replaceAll("{{OWNER}}", words.owner)
    .replaceAll("{{CODE}}", String(words.status))
    .replaceAll("{{RETRY}}", words.retry.join(","))
    .replaceAll("{{EDGE}}", escapeHtml(edge))
    .replaceAll("{{TIME}}", time)
    .replaceAll("{{HOST}}", escapeHtml(host));
}

/** The tunnel-down page. */
export function maintenancePage(templatePath: string, host: string, edge: string, now = new Date()): string | null {
  return statusPage(templatePath, "tunnel-down", host, edge, now);
}
