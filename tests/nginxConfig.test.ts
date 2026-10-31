/**
 * Custom-domain vhost templates and the upgrade rule.
 *
 * Reconcile rewrites a vhost only when it is still exactly what an older jrok
 * template produced. The fixtures are production's real v1 shapes (domain and
 * certificate path swapped for placeholders): the common one with trailing
 * spaces on blank lines, the newer one without, and one an operator pointed at
 * another server — the kind production has and must never lose.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  generateCustomDomainNginxConfig,
  generateJrokUpstreamConfig,
  isUnmodifiedGeneratedVhost,
  upstreamFileUpdate,
  vhostNeedsUpgrade,
  vhostTemplateVersion,
  CUSTOM_DOMAIN_VHOST_VERSION,
  JROK_UPSTREAM_NAME,
} from "../src/utils/nginxConfig";

const DOMAIN = "shop.customer.com";
const CERT_DIR = `/etc/letsencrypt/live/${DOMAIN}`;

function fixture(name: string, domain = DOMAIN, certDir = CERT_DIR): string {
  return readFileSync(join(import.meta.dir, "fixtures/nginx", name), "utf8")
    .replaceAll("{{CERT_DIR}}", certDir)
    .replaceAll("{{DOMAIN}}", domain);
}

describe("current template", () => {
  const vhost = generateCustomDomainNginxConfig(DOMAIN, CERT_DIR);

  test("is versioned", () => {
    expect(vhostTemplateVersion(vhost)).toBe(CUSTOM_DOMAIN_VHOST_VERSION);
  });

  test("proxies to the shared upstream with a Connection header that allows keepalive", () => {
    expect(vhost).toContain(`proxy_pass http://${JROK_UPSTREAM_NAME};`);
    expect(vhost).toContain("proxy_set_header Connection $jrok_connection_upgrade;");
    expect(vhost).not.toContain('Connection "upgrade"');
  });

  test("lets an idle WebSocket live for an hour", () => {
    expect(vhost).toContain("proxy_read_timeout 3600s;");
  });

  test("is recognised as unedited despite a different timestamp, and needs no upgrade", () => {
    const later = vhost.replace(/^# Generated: .*$/m, "# Generated: 2030-01-01T00:00:00.000Z");
    expect(isUnmodifiedGeneratedVhost(later, DOMAIN, CERT_DIR)).toBe(true);
    expect(vhostNeedsUpgrade(later, DOMAIN, CERT_DIR)).toBe(false);
  });
});

describe("upgrading production's v1 vhosts", () => {
  test("the common v1 shape (trailing spaces on blank lines) is upgraded", () => {
    const v1 = fixture("v1-vhost.conf");
    expect(vhostTemplateVersion(v1)).toBe(1);
    expect(vhostNeedsUpgrade(v1, DOMAIN, CERT_DIR)).toBe(true);
  });

  test("the newer v1 shape (no trailing spaces) is upgraded", () => {
    expect(vhostNeedsUpgrade(fixture("v1-vhost-no-trailing-spaces.conf"), DOMAIN, CERT_DIR)).toBe(true);
  });

  test("a vhost an operator pointed at another server is never upgraded", () => {
    expect(vhostNeedsUpgrade(fixture("v1-vhost-hand-edited.conf"), DOMAIN, CERT_DIR)).toBe(false);
  });

  test("a vhost with lines removed is never upgraded", () => {
    const trimmed = fixture("v1-vhost.conf").replace(/^\s*ssl_certificate .*\n/m, "");
    expect(vhostNeedsUpgrade(trimmed, DOMAIN, CERT_DIR)).toBe(false);
  });

  test("a vhost written for another domain or certificate path is not mistaken for this one", () => {
    const v1 = fixture("v1-vhost.conf");
    expect(vhostNeedsUpgrade(v1, "other.customer.com", CERT_DIR)).toBe(false);
    expect(vhostNeedsUpgrade(v1, DOMAIN, "/etc/letsencrypt/live/shop.customer.com-0001")).toBe(false);
  });

  test("a file claiming a version jrok never shipped is left alone", () => {
    const unknown = generateCustomDomainNginxConfig(DOMAIN, CERT_DIR)
      .replace(/^# jrok-vhost-template: \d+$/m, "# jrok-vhost-template: 99");
    expect(isUnmodifiedGeneratedVhost(unknown, DOMAIN, CERT_DIR)).toBe(false);
    expect(vhostNeedsUpgrade(unknown, DOMAIN, CERT_DIR)).toBe(false);
  });
});

describe("shared upstream file", () => {
  const wanted = generateJrokUpstreamConfig();

  test("is created when missing", () => {
    expect(upstreamFileUpdate(null)).toBe(wanted);
  });

  test("is left alone when current", () => {
    expect(upstreamFileUpdate(wanted)).toBeNull();
  });

  test("is rewritten when jrok wrote an older version", () => {
    const older = wanted.replace("keepalive 64;", "keepalive 32;");
    expect(upstreamFileUpdate(older)).toBe(wanted);
  });

  test("is never overwritten when someone else put a file there", () => {
    expect(upstreamFileUpdate("upstream jrok_local { server 10.0.0.5:3000; }\n")).toBeNull();
  });

  test("keeps the upstream connection open for ordinary requests", () => {
    expect(wanted).toContain("keepalive");
    expect(wanted).toMatch(/''\s+"";/);
  });
});
