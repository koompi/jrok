/**
 * The cross-app guard (J1): one customer's app sending another customer's
 * visitors to it with their cookies. Every app is a sibling name of one site
 * (koompi.cloud), so the browser's SameSite rules let them.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  checkCrossAppRequest,
  crossAppMode,
  flushCrossAppReports,
  noteResponseCookies,
  resetCrossAppReports,
  siteDomain,
} from "../src/services/crossAppGuard";
import { loadAppGroups, parseAppGroups, resetAppGroups, toStored, MAX_APP_GROUP_ENTRIES } from "../src/services/appGroups";

const saved = { base: process.env.BASE_DOMAIN, legacy: process.env.LEGACY_BASE_DOMAINS, mode: process.env.CROSS_APP_GUARD, site: process.env.JROK_SITE };
afterAll(() => {
  for (const [name, value] of [["BASE_DOMAIN", saved.base], ["LEGACY_BASE_DOMAINS", saved.legacy], ["CROSS_APP_GUARD", saved.mode], ["JROK_SITE", saved.site]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetCrossAppReports();
  resetAppGroups();
});

const SHOP = "1111111111111111";
const EVIL = "2222222222222222";
let lines: string[] = [];

function groups() {
  loadAppGroups(toStored({
    version: "abcdef01",
    labels: { shop: SHOP, front: SHOP, api: SHOP, evil: EVIL },
    domains: { "app.koompi.cloud": EVIL, "shop.example.com": SHOP, "own.koompi.cloud": SHOP },
  }));
}

beforeEach(() => {
  process.env.BASE_DOMAIN = "public.koompi.cloud";
  process.env.LEGACY_BASE_DOMAINS = "tunnel.koompi.cloud";
  delete process.env.CROSS_APP_GUARD;
  delete process.env.JROK_SITE;
  lines = [];
  resetCrossAppReports((line) => lines.push(line));
  resetAppGroups();
  groups();
});

function req(headers: Record<string, string>) {
  return new Headers({ cookie: "session=1", ...headers });
}
const check = (method: string, headers: Record<string, string>, host = "shop.public.koompi.cloud") =>
  checkCrossAppRequest(method, req(headers), host);

describe("what is flagged", () => {
  test("a POST from another customer's app, with the visitor's cookies", () => {
    expect(check("POST", { origin: "https://evil.public.koompi.cloud" })).toEqual({ verdict: "cross-org", from: "evil", to: "shop", dropCookie: false });
    expect(lines).toEqual(["cross-org: evil -> shop (POST, report only)"]);
  });

  test("a WebSocket opened from another customer's page (cross-site WebSocket hijacking)", () => {
    expect(check("GET", { origin: "https://evil.public.koompi.cloud", upgrade: "websocket" })?.verdict).toBe("cross-org");
    expect(lines[0]).toContain("(websocket,");
  });

  test("a script's GET (fetch with credentials carries Origin)", () => {
    expect(check("GET", { origin: "https://evil.public.koompi.cloud" })?.verdict).toBe("cross-org");
  });

  test("a POST from an old browser that sends only Referer", () => {
    expect(check("POST", { referer: "https://evil.public.koompi.cloud/page" })?.verdict).toBe("cross-org");
  });

  test("a page that hid its origin (Referrer-Policy: no-referrer: Origin null) on a sibling name", () => {
    expect(check("POST", { origin: "null", "sec-fetch-site": "same-site" })).toMatchObject({ verdict: "hidden", to: "shop" });
    expect(check("PUT", { "sec-fetch-site": "same-site" })?.verdict).toBe("hidden");
  });

  test("an app on a custom domain of the site, either side", () => {
    expect(check("POST", { origin: "https://app.koompi.cloud" })?.verdict).toBe("cross-org");
    expect(check("POST", { origin: "https://evil.public.koompi.cloud" }, "own.koompi.cloud")?.verdict).toBe("cross-org");
  });

  test("an app KOOMPI Cloud didn't list: unknown", () => {
    expect(check("POST", { origin: "https://stranger.public.koompi.cloud" })?.verdict).toBe("unknown");
    resetAppGroups(); // never loaded
    expect(check("POST", { origin: "https://evil.public.koompi.cloud" })?.verdict).toBe("unknown");
  });
});

describe("what is not", () => {
  test("no cookies", () => {
    expect(checkCrossAppRequest("POST", new Headers({ origin: "https://evil.public.koompi.cloud" }), "shop.public.koompi.cloud")).toBeNull();
    expect(check("POST", { origin: "https://evil.public.koompi.cloud", cookie: " " })).toBeNull();
  });

  test("the same customer's other app (a frontend and its API)", () => {
    expect(check("POST", { origin: "https://front.public.koompi.cloud" })).toBeNull();
    expect(check("POST", { origin: "https://front.public.koompi.cloud", upgrade: "websocket" }, "api.public.koompi.cloud")).toBeNull();
  });

  test("the same app, under the other base domain or on itself", () => {
    expect(check("POST", { origin: "https://shop.tunnel.koompi.cloud" })).toBeNull();
    expect(check("POST", { origin: "https://shop.public.koompi.cloud" })).toBeNull();
  });

  test("a link followed from another app (GET, no Origin)", () => {
    expect(check("GET", { referer: "https://evil.public.koompi.cloud/" })).toBeNull();
    expect(check("HEAD", { referer: "https://evil.public.koompi.cloud/" })).toBeNull();
  });

  test("a preflight", () => {
    expect(check("OPTIONS", { origin: "https://evil.public.koompi.cloud" })).toBeNull();
  });

  test("another site: the browser's SameSite rules already apply", () => {
    expect(check("POST", { origin: "https://evil.example.com" })).toBeNull();
    expect(check("POST", { origin: "null", "sec-fetch-site": "cross-site" })).toBeNull();
    expect(check("POST", { origin: "https://evil.public.koompi.cloud" }, "shop.example.com")).toBeNull();
  });

  test("the site's own hosts (console, API): not customers' apps", () => {
    expect(check("POST", { origin: "https://koompi.cloud" })).toBeNull();
    expect(check("POST", { origin: "https://api.koompi.cloud" })).toBeNull();
    expect(check("POST", { origin: "https://public.koompi.cloud" })).toBeNull();
  });

  test("a hidden origin on a GET (a link) or from the same origin", () => {
    expect(check("GET", { "sec-fetch-site": "same-site" })).toBeNull();
    expect(check("POST", { origin: "null", "sec-fetch-site": "same-origin" })).toBeNull();
  });

  test("an Origin that isn't a URL", () => {
    expect(check("POST", { origin: "evil" })).toBeNull();
  });
});

describe("CROSS_APP_GUARD", () => {
  test("enforce: a different customer's request (or a hidden one) goes on without cookies; unknown passes", () => {
    process.env.CROSS_APP_GUARD = "enforce";
    expect(check("POST", { origin: "https://evil.public.koompi.cloud" })?.dropCookie).toBe(true);
    expect(check("POST", { origin: "null", "sec-fetch-site": "same-site" })?.dropCookie).toBe(true);
    expect(check("POST", { origin: "https://stranger.public.koompi.cloud" })?.dropCookie).toBe(false);
    expect(check("POST", { origin: "https://front.public.koompi.cloud" })).toBeNull();
    expect(lines).toEqual([
      "cross-org: evil -> shop (POST, cookies dropped)",
      "hidden: (a page that hid its origin) -> shop (POST, cookies dropped)",
      "unknown: stranger -> shop (POST, passed: customer unknown)",
    ]);
  });

  test("off: nothing", () => {
    process.env.CROSS_APP_GUARD = "off";
    expect(check("POST", { origin: "https://evil.public.koompi.cloud" })).toBeNull();
    expect(lines).toEqual([]);
  });

  test("default and anything unrecognised: report", () => {
    expect(crossAppMode()).toBe("report");
    process.env.CROSS_APP_GUARD = "Enforce-ish";
    expect(crossAppMode()).toBe("report");
    expect(check("POST", { origin: "https://evil.public.koompi.cloud" })?.dropCookie).toBe(false);
  });
});

describe("the log", () => {
  test("one line per pair, then a count when its 10 minutes end", () => {
    for (let i = 0; i < 3; i++) check("POST", { origin: "https://evil.public.koompi.cloud" });
    check("POST", { origin: "https://stranger.public.koompi.cloud" });
    expect(lines).toEqual(["cross-org: evil -> shop (POST, report only)", "unknown: stranger -> shop (POST, report only)"]);
    flushCrossAppReports();
    expect(lines.slice(2)).toEqual(["cross-org: evil -> shop (POST, report only): 3 in 10 minutes"]);
    check("POST", { origin: "https://evil.public.koompi.cloud" });
    expect(lines.length).toBe(4); // a new window starts with a line again
  });
});

describe("cookies set for every app (cookie tossing): reported", () => {
  const respond = (...cookies: string[]) => {
    const headers = new Headers();
    for (const c of cookies) headers.append("set-cookie", c);
    return headers;
  };

  test("Domain= the site or a base domain", () => {
    noteResponseCookies("shop.public.koompi.cloud", respond("a=1; Path=/; Domain=.public.koompi.cloud", "b=2; domain=koompi.cloud; Secure"));
    expect(lines).toEqual([
      "cookie: shop sets a cookie for public.koompi.cloud, which every app under it receives (report only)",
      "cookie: shop sets a cookie for koompi.cloud, which every app under it receives (report only)",
    ]);
  });

  test("not its own host, no Domain, or a custom domain's own", () => {
    noteResponseCookies("shop.public.koompi.cloud", respond("a=1; Domain=shop.public.koompi.cloud", "b=2; Path=/", "c=domain=koompi.cloud"));
    noteResponseCookies("shop.example.com", respond("a=1; Domain=example.com"));
    expect(lines).toEqual([]);
  });
});

describe("the site", () => {
  test("the primary base domain's parent, or JROK_SITE", () => {
    expect(siteDomain()).toBe("koompi.cloud");
    process.env.BASE_DOMAIN = "example.com";
    expect(siteDomain()).toBe("example.com");
    process.env.JROK_SITE = "Example.ORG.";
    expect(siteDomain()).toBe("example.org");
  });
});

describe("the map KOOMPI Cloud pushes (PUT /security/app-groups)", () => {
  const good = { version: "abcdef0123", labels: { shop: SHOP, "a-b.c": EVIL }, domains: { "shop.example.com": SHOP } };

  test("a good one", () => {
    const parsed = parseAppGroups(good);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(good);
    expect(parseAppGroups({ version: "abcdef0123" })).toEqual({ ok: true, value: { version: "abcdef0123", labels: {}, domains: {} } });
  });

  test("refused: not an object, a bad version, name or group", () => {
    for (const body of [
      null, [], "x",
      { ...good, version: "ABCDEF0123" }, { ...good, version: "abc" }, { labels: good.labels },
      { ...good, labels: { Shop: SHOP } }, { ...good, labels: { "a..b": SHOP } }, { ...good, labels: { "-a": SHOP } },
      { ...good, labels: { shop: "zz" } }, { ...good, labels: { shop: 7 } }, { ...good, labels: [] },
      { ...good, domains: { localhost: SHOP } }, { ...good, domains: { "a/b.com": SHOP } },
    ]) {
      expect([JSON.stringify(body), parseAppGroups(body).ok]).toEqual([JSON.stringify(body), false]);
    }
  });

  test(`at most ${MAX_APP_GROUP_ENTRIES} entries`, () => {
    const labels: Record<string, string> = {};
    for (let i = 0; i <= MAX_APP_GROUP_ENTRIES; i++) labels[`app${i}`] = SHOP;
    expect(parseAppGroups({ version: "abcdef0123", labels }).ok).toBe(false);
  });
});
