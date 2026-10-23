/**
 * Visitor geolocation.
 *
 * The server resolves the visitor's location and sends it with each request as
 * `clientGeo`; the CLI passes it through in its `@jrok:req` events, which is
 * what kconsole's analytics read. Like the capability handshake, the two halves
 * are built separately and nothing types them together, so a rename on one side
 * would silently zero the location data — hence the source-level checks.
 *
 * Lookups against a real database run only when GEOIP_DIR points at one
 * (e.g. GEOIP_DIR=/var/lib/GeoIP bun test tests/geoip.test.ts).
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const cliSrc = readFileSync(join(root, "cli/src/index.ts"), "utf8");
const serverIndex = readFileSync(join(root, "src/index.ts"), "utf8");

describe("clientGeo contract", () => {
  test("server sends clientGeo with every forwarded http_request", () => {
    expect(serverIndex).toMatch(/clientGeo:\s*lookupGeo\(clientIp\)/);
  });

  test("CLI reads clientGeo and emits it with user agent and referrer", () => {
    expect(cliSrc).toMatch(/\{[^}]*\bclientGeo\b[^}]*\}\s*=\s*message/);
    expect(cliSrc).toMatch(/geo:\s*clientGeo/);
    expect(cliSrc).toMatch(/ua:\s*headerValue\(headers,\s*'user-agent'\)/);
    expect(cliSrc).toMatch(/ref:\s*headerValue\(headers,\s*'referer'\)/);
  });
});

describe("lookupGeo", () => {
  test("returns undefined for addresses that can't be located", async () => {
    const { lookupGeo } = await import("../src/services/geoipService");
    for (const ip of [undefined, null, "", "unknown", "not-an-ip", "10.0.0.1", "127.0.0.1"]) {
      expect(lookupGeo(ip as any)).toBeUndefined();
    }
  });

  const dir = process.env.GEOIP_DIR;
  const haveDb = !!dir && existsSync(join(dir, "GeoLite2-City.mmdb")) && existsSync(join(dir, "GeoLite2-ASN.mmdb"));

  test.skipIf(!haveDb)("locates public addresses with the installed databases", async () => {
    const { initGeoip, lookupGeo } = await import("../src/services/geoipService");
    await initGeoip();

    const google = lookupGeo("8.8.8.8");
    expect(google?.country).toBe("US");
    expect(google?.asn).toBe(15169);
    expect(typeof google?.org).toBe("string");

    expect(lookupGeo("2001:4860:4860::8888")?.asn).toBe(15169);
    expect(lookupGeo("192.168.1.1")).toBeUndefined();
  });
});
