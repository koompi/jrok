import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PAGE_CHECK_HEADER,
  maintenancePage,
  pageInstead,
  statusPage,
  statusPageCode,
  wantsPage,
  type StatusPageKind,
} from "../src/utils/maintenancePage";

const template = join(import.meta.dir, "..", "index.html");
const at = new Date("2026-11-07T06:19:41Z");
const KINDS: StatusPageKind[] = ["tunnel-down", "reconnecting", "no-answer", "domain-pending", "domain-unknown"];

/** What Chrome sends opening a page. */
const BROWSER = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
/** What the deploy worker's tunnel health check sends (worker/deploy JrokService). */
const DEPLOY_WORKER = { accept: "application/json", "user-agent": "kconsole-health-check" };

afterEach(() => setSystemTime());

test("the maintenance page names the app, the edge and the time, escaped", () => {
  const page = maintenancePage(template, 'shop.example.com"><script>x</script>', "vps-sgp1", new Date("2026-11-01T02:31:45Z"))!;
  expect(page).toContain("shop.example.com&quot;&gt;&lt;script&gt;x&lt;/script&gt;");
  expect(page).not.toContain("<script>x</script>");
  expect(page).toContain("Error 503 · vps-sgp1 · 2026-11-01 02:31 UTC");
  expect(page).not.toContain("{{");
});

describe("one page per case", () => {
  test("app down: 503, the dolphin fixing a server, checks again 5 s, 10 s, 15 s, 30 s, then every minute for 10 minutes", () => {
    const page = maintenancePage(template, "shop.example.com", "vps-sgp1", at)!;
    expect(statusPageCode("tunnel-down")).toBe(503);
    expect(page).toContain("<title>shop.example.com will be back soon · KOOMPI Cloud</title>");
    expect(page).toContain("This app is taking a short break");
    expect(page).toContain('<body class="kind-tunnel-down">');
    expect(page).toContain('class="cone"');
    expect(page).toContain('data-retry="5,10,15,30,60" data-stop="600"');
  });

  test("reconnecting: 503 (or the 502 it was served with), checks again within seconds", () => {
    const page = statusPage(template, "reconnecting", "shop.example.com", "edge-sgp2", at)!;
    expect(statusPageCode("reconnecting")).toBe(503);
    expect(page).toContain("Reconnecting to this app");
    expect(page).toContain('data-retry="3,5,10,20,30,60"');
    expect(page).toContain('class="nudge"');
    expect(statusPage(template, "reconnecting", "shop.example.com", "edge-sgp2", at, 502)).toContain("Error 502 · edge-sgp2");
  });

  test("no answer in time: 504, the dolphin waiting by a stopwatch", () => {
    const page = statusPage(template, "no-answer", "reports.example.com", "edge-sgp1", at)!;
    expect(statusPageCode("no-answer")).toBe(504);
    expect(page).toContain("This app is taking too long to answer");
    expect(page).toContain("Error 504 · edge-sgp1");
    expect(page).toContain('class="dol spin"');
  });

  test("a custom domain added but not verified: 503, almost ready, checks again from 10 s for 15 minutes", () => {
    const page = statusPage(template, "domain-pending", "koompi.com", "vps-sgp3", at)!;
    expect(statusPageCode("domain-pending")).toBe(503);
    expect(page).toContain("<title>koompi.com is getting ready · KOOMPI Cloud</title>");
    expect(page).toContain("This domain is almost ready");
    expect(page).toContain('data-retry="10,15,30" data-stop="900"');
    expect(page).toContain("Error 503 · vps-sgp3 · 2026-11-07 06:19 UTC");
    expect(page).not.toContain("Unauthorized");
  });

  test("a name no app uses: 404, no app lives here, what to check, and no checking by itself", () => {
    const page = statusPage(template, "domain-unknown", "www.koompi.com", "vps-sgp1", at)!;
    expect(statusPageCode("domain-unknown")).toBe(404);
    expect(page).toContain("No app lives here");
    expect(page).toContain("Is the address spelled right?");
    expect(page).toContain("moved to another address or been deleted");
    expect(page).toContain('data-retry=""');
    expect(page).toContain("Error 404 · vps-sgp1");
  });

  test("every page: the host shown on its own, a Khmer line marked as Khmer, a real button, its own picture, nothing left to fill", () => {
    const scenes = new Set<string>();
    for (const kind of KINDS) {
      const page = statusPage(template, kind, "a.example", "e", at)!;
      expect(page).toContain('<span>a.example</span>');
      expect(page).toMatch(/<p class="km" lang="km">[ក-៿]/);
      expect(page).toContain('<button type="button" class="btn" id="retry">Try again</button>');
      expect(page).toContain('<html lang="en">');
      const scene = page.match(/<div class="art" aria-hidden="true">(<svg[\s\S]*?<\/svg>)<\/div>/)?.[1];
      expect(scene).toBeTruthy();
      scenes.add(scene!);
      expect(page).not.toContain("{{");
      expect(page).not.toContain("<?xml");
    }
    expect(scenes.size).toBe(KINDS.length);
  });

  test("the real KOOMPI Cloud logo, not the old star; KOOMPI Cloud by name, never KConsole; the dashboard linked", () => {
    const logo = readFileSync(join(import.meta.dir, "..", "scenes", "brand", "kc-logo.svg"), "utf8");
    const [cloud, wordmark] = [...logo.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    for (const kind of KINDS) {
      const page = statusPage(template, kind, "a.example", "e", at)!;
      expect(page).toContain(`<path class="lm" fill-rule="evenodd" d="${cloud}"/>`);
      expect(page).toContain(`<path class="lw" d="${wordmark}"/>`);
      expect(page).not.toContain("data:image/png");
      expect(page).toContain('href="https://koompi.cloud/dashboard"');
      expect(/kconsole/i.test(page)).toBe(false);
    }
  });

  test("self-contained and small: inline pictures only, nothing loaded but the fonts, under 40 KB", () => {
    for (const kind of KINDS) {
      const page = statusPage(template, kind, "a-rather-long-subdomain-name.koompi.app", "edge-sgp1", at)!;
      expect(Buffer.byteLength(page)).toBeLessThan(40 * 1024);
      expect(page).not.toContain("<img");
      const loaded = [...page.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => new URL(m[1]!).host);
      expect(new Set(loaded)).toEqual(new Set(["fonts.googleapis.com", "fonts.gstatic.com", "koompi.cloud"]));
      expect(page).toContain("prefers-reduced-motion");
      expect(page).toContain("prefers-color-scheme: dark");
    }
  });

  test("a host can't fill in a placeholder or inject markup", () => {
    for (const kind of KINDS) {
      const page = statusPage(template, kind, '{{EDGE}}<img src=x onerror=alert(1)>', "vps-sgp1", at)!;
      expect(page).toContain("{{EDGE}}&lt;img src=x onerror=alert(1)&gt;");
      expect(page).not.toContain("<img src=x");
    }
  });

  test("an edge name is escaped too", () => {
    expect(statusPage(template, "reconnecting", "a.example", '"><b>', at)).toContain("&quot;&gt;&lt;b&gt;");
  });
});

describe("files are looked at again every 30 s", () => {
  function copy() {
    const dir = mkdtempSync(join(tmpdir(), "jrok-pages-"));
    cpSync(template, join(dir, "index.html"));
    cpSync(join(import.meta.dir, "..", "scenes"), join(dir, "scenes"), { recursive: true });
    return { dir, page: join(dir, "index.html"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  function touch(path: string, text: string, seconds: number) {
    writeFileSync(path, text);
    utimesSync(path, seconds, seconds);
  }

  test("a changed template is served once its 30 s are up, without a restart", () => {
    const { page, cleanup } = copy();
    try {
      setSystemTime(new Date("2026-11-11T10:00:00Z"));
      expect(statusPage(page, "tunnel-down", "a.example", "e", at)).toContain("This app is taking a short break");

      touch(page, readFileSync(page, "utf8").replace("{{HEADING}}", "Changed: {{HEADING}}"), 1_900_000_000);
      setSystemTime(new Date("2026-11-11T10:00:20Z"));
      expect(statusPage(page, "tunnel-down", "a.example", "e", at)).not.toContain("Changed:");

      setSystemTime(new Date("2026-11-11T10:00:31Z"));
      expect(statusPage(page, "tunnel-down", "a.example", "e", at)).toContain("Changed: This app is taking a short break");
    } finally {
      cleanup();
    }
  });

  test("so is a changed picture", () => {
    const { dir, page, cleanup } = copy();
    try {
      setSystemTime(new Date("2026-11-11T11:00:00Z"));
      expect(statusPage(page, "no-answer", "a.example", "e", at)).toContain('class="dol spin"');
      touch(join(dir, "scenes", "slow.svg"), '<svg viewBox="0 0 1 1"><!-- note --><circle class="new-clock"/></svg>', 1_900_000_100);
      setSystemTime(new Date("2026-11-11T11:00:31Z"));
      const changed = statusPage(page, "no-answer", "a.example", "e", at)!;
      expect(changed).toContain('<svg viewBox="0 0 1 1"><circle class="new-clock"/></svg>');
      expect(changed).not.toContain("<!-- note -->");
    } finally {
      cleanup();
    }
  });

  test("a template that disappears (a deploy replacing it) keeps the last one; one that never existed gives no page", () => {
    const { page, cleanup } = copy();
    try {
      setSystemTime(new Date("2026-11-11T12:00:00Z"));
      expect(statusPage(page, "reconnecting", "a.example", "e", at)).toContain("Reconnecting to this app");
      unlinkSync(page);
      setSystemTime(new Date("2026-11-11T12:01:00Z"));
      expect(statusPage(page, "reconnecting", "a.example", "e", at)).toContain("Reconnecting to this app");
    } finally {
      cleanup();
    }
    expect(statusPage("/nonexistent/jrok/index.html", "reconnecting", "a.example", "e", at)).toBeNull();
  });
});

describe("who gets a page", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  test("a browser opening a page, and a waiting page checking whether the app is back", () => {
    expect(wantsPage("GET", h(BROWSER))).toBe(true);
    expect(wantsPage("HEAD", h({ "sec-fetch-mode": "cors", [PAGE_CHECK_HEADER]: "1" }))).toBe(true);
    expect(wantsPage("GET", h({ "sec-fetch-mode": "cors", [PAGE_CHECK_HEADER]: "1" }))).toBe(true);
  });

  test("not the deploy worker, API clients, a page's own fetches, or a form post", () => {
    expect(wantsPage("GET", h(DEPLOY_WORKER))).toBe(false);
    expect(wantsPage("GET", h({ accept: "*/*" }))).toBe(false);
    expect(wantsPage("GET", h({ "sec-fetch-mode": "cors", accept: "text/html" }))).toBe(false);
    expect(wantsPage("POST", h(BROWSER))).toBe(false);
    expect(wantsPage("POST", h({ [PAGE_CHECK_HEADER]: "1" }))).toBe(false);
  });
});

describe("pageInstead: jrok's own answer as a page for a browser, unchanged for everyone else", () => {
  const reconnecting = () => new Response(
    JSON.stringify({ success: false, message: "Agent for shop is not connected" }),
    { status: 503, headers: { "Content-Type": "application/json", "X-Jrok-Tunnel": "reconnecting", "Retry-After": "5" } },
  );
  const req = (headers: Record<string, string>, method = "GET") =>
    new Request("https://Shop.Koompi.App/cart?x=1", { method, headers });

  test("a browser gets the page with the same status and every header, as uncacheable HTML", async () => {
    const res = pageInstead(req(BROWSER), reconnecting(), "reconnecting", template, "edge-sgp1");
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Jrok-Tunnel")).toBe("reconnecting");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("Reconnecting to this app");
    expect(body).toContain("<span>shop.koompi.app</span>");
    expect(body).toContain("Error 503 · edge-sgp1");
  });

  test("the deploy worker and API clients get exactly the same answer, JSON and all", async () => {
    for (const headers of [DEPLOY_WORKER, { accept: "*/*" }, {}]) {
      const answer = reconnecting();
      const res = pageInstead(req(headers), answer, "reconnecting", template, "edge-sgp1");
      expect(res).toBe(answer);
      expect(await res.json()).toEqual({ success: false, message: "Agent for shop is not connected" });
    }
  });

  test("the waiting page's own check gets the page's status and headers, without a body", async () => {
    const res = pageInstead(req({ "sec-fetch-mode": "cors", [PAGE_CHECK_HEADER]: "1" }, "HEAD"), reconnecting(), "reconnecting", template, "e");
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Jrok-Tunnel")).toBe("reconnecting");
    expect(await res.text()).toBe("");
  });

  test("the footer shows the status it is served with", async () => {
    const gone = new Response("{}", { status: 502, headers: { "Content-Type": "application/json", "X-Jrok-Route": "unreachable" } });
    const res = pageInstead(req(BROWSER), gone, "reconnecting", template, "edge-sgp3");
    expect(res.status).toBe(502);
    expect(res.headers.get("X-Jrok-Route")).toBe("unreachable");
    expect(await res.text()).toContain("Error 502 · edge-sgp3");
  });

  test("no template: the JSON answer, as before there were pages", () => {
    const answer = reconnecting();
    expect(pageInstead(req(BROWSER), answer, "reconnecting", "/nonexistent/index.html", "e")).toBe(answer);
  });
});
