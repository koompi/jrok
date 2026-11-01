/**
 * The page a visitor gets for an app whose tunnel is down (jrok's index.html),
 * with the app's host, this edge and the time filled in, HTML-escaped. Read
 * once and kept: during an outage every visitor gets it.
 */
import { readFileSync } from "fs";

let template: string | null | undefined;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The page, or null if the template can't be read (the caller answers JSON then). */
export function maintenancePage(templatePath: string, host: string, edge: string, now = new Date()): string | null {
  if (template === undefined) {
    try {
      template = readFileSync(templatePath, "utf8");
    } catch {
      template = null;
    }
  }
  if (template === null) return null;
  const time = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return template
    .replaceAll("{{HOST}}", escapeHtml(host))
    .replaceAll("{{EDGE}}", escapeHtml(edge))
    .replaceAll("{{TIME}}", time);
}
