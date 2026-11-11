/**
 * Writes every page jrok serves when an app can't be reached (index.html with
 * each case's words and picture) to a folder, with sample values, to look at
 * in a browser while changing them:
 *
 *   bun scripts/render-status-pages.ts [out-dir]     default /tmp/jrok-pages
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { statusPage, statusPageCode, type StatusPageKind } from "../src/utils/maintenancePage";

const out = process.argv[2] || "/tmp/jrok-pages";
const template = join(import.meta.dir, "..", "index.html");
const at = new Date("2026-11-11T14:02:00Z");

const samples: [StatusPageKind, string, number?][] = [
  ["tunnel-down", "shop-a1b2c3.koompi.app"],
  ["reconnecting", "shop-a1b2c3.koompi.app"],
  ["no-answer", "reports.koompi.app"],
  ["domain-pending", "www.angkor-coffee.com"],
  ["domain-unknown", "my-long-store-name-that-wraps.example.com"],
];

mkdirSync(out, { recursive: true });
for (const [kind, host, status] of samples) {
  const page = statusPage(template, kind, host, "edge-sgp1", at, status ?? statusPageCode(kind));
  if (!page) throw new Error(`no page for ${kind}: is ${template} there?`);
  writeFileSync(join(out, `${kind}.html`), page);
  console.log(`${kind}.html  ${(Buffer.byteLength(page) / 1024).toFixed(1)} KB`);
}
