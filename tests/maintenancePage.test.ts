import { describe, expect, test } from "bun:test";
import { join } from "path";
import { maintenancePage, statusPage, statusPageCode } from "../src/utils/maintenancePage";

test("the maintenance page names the app, the edge and the time, escaped", () => {
  const page = maintenancePage(join(import.meta.dir, "..", "index.html"), 'shop.example.com"><script>x</script>', "vps-sgp1", new Date("2026-11-01T02:31:45Z"))!;
  expect(page).toContain("shop.example.com&quot;&gt;&lt;script&gt;x&lt;/script&gt;");
  expect(page).not.toContain("<script>x</script>");
  expect(page).toContain("Error 503 · vps-sgp1 · 2026-11-01 02:31 UTC");
  expect(page).not.toContain("{{");
});

describe("pages for a custom domain jrok can't route yet", () => {
  const template = join(import.meta.dir, "..", "index.html");
  const at = new Date("2026-11-07T06:19:41Z");

  test("added but not verified: says it is getting ready, 503, and reloads itself every 10 s", () => {
    const page = statusPage(template, "domain-pending", "koompi.com", "vps-sgp3", at)!;
    expect(statusPageCode("domain-pending")).toBe(503);
    expect(page).toContain("<title>koompi.com is getting ready · KOOMPI Cloud</title>");
    expect(page).toContain("This domain is almost ready.");
    expect(page).toContain('<span class="host">koompi.com</span> was just added');
    expect(page).toContain('data-retry="10"');
    expect(page).toContain("Error 503 · vps-sgp3 · 2026-11-07 06:19 UTC");
    expect(page).not.toContain("Unauthorized");
    expect(page).not.toContain("{{");
  });

  test("no app uses it: says so, 404, and doesn't reload by itself", () => {
    const page = statusPage(template, "domain-unknown", "www.koompi.com", "vps-sgp1", at)!;
    expect(statusPageCode("domain-unknown")).toBe(404);
    expect(page).toContain("This domain isn’t connected to an app.");
    expect(page).toContain('data-retry=""');
    expect(page).toContain("Error 404 · vps-sgp1");
    expect(page).not.toContain("{{");
  });

  test("the tunnel-down page keeps its words and its 20 s, 40 s, then every minute", () => {
    const page = maintenancePage(template, "shop.example.com", "vps-sgp1", at)!;
    expect(page).toContain("This app isn’t available right now.");
    expect(page).toContain('data-retry="20,40,60"');
    expect(statusPageCode("tunnel-down")).toBe(503);
  });

  test("a host can't fill in a placeholder or inject markup", () => {
    for (const kind of ["domain-pending", "domain-unknown"] as const) {
      const page = statusPage(template, kind, '{{EDGE}}<img src=x onerror=alert(1)>', "vps-sgp1", at)!;
      expect(page).toContain("{{EDGE}}&lt;img src=x onerror=alert(1)&gt;");
      expect(page).not.toContain("<img src=x");
    }
  });

  test("the KOOMPI Cloud dashboard is linked by its name, never KConsole", () => {
    for (const kind of ["tunnel-down", "domain-pending", "domain-unknown"] as const) {
      const page = statusPage(template, kind, "a.example", "e", at)!;
      expect(page).toContain('href="https://koompi.cloud/dashboard"');
      expect(/kconsole/i.test(page)).toBe(false);
    }
  });
});
