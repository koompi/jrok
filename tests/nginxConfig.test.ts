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
  jrokPeers,
  isUnmodifiedGeneratedVhost,
  upstreamFileUpdate,
  vhostNeedsUpgrade,
  vhostTemplateVersion,
  renderVhostTemplate,
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

// Templates v3 and later are written only where nginx.conf defines the edge cache.
const WITH_EDGE_CACHE = join(import.meta.dir, "fixtures/nginx/nginx-with-edge-cache.conf");
function withNginxConf<T>(path: string, fn: () => T): T {
  const saved = process.env.NGINX_CONF_PATH;
  process.env.NGINX_CONF_PATH = path;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.NGINX_CONF_PATH;
    else process.env.NGINX_CONF_PATH = saved;
  }
}

describe("current template", () => {
  const vhost = withNginxConf(WITH_EDGE_CACHE, () => generateCustomDomainNginxConfig(DOMAIN, CERT_DIR));

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
    withNginxConf(WITH_EDGE_CACHE, () => expect(vhostNeedsUpgrade(later, DOMAIN, CERT_DIR)).toBe(false));
  });

  test("uses the edge cache, keyed by host, never for Authorization", () => {
    expect(vhost).toContain("proxy_cache jrok_cache;");
    expect(vhost).toContain("proxy_cache_key $scheme$host$request_uri;");
    expect(vhost).toContain("proxy_no_cache $jrok_not_shareable $http_authorization;");
    expect(vhost).not.toContain("proxy_cache_lock");
  });

  test("certificate challenges on port 80 go to jrok, marked; HTTPS clears the marker", () => {
    const [http, https] = vhost.split("# HTTPS server");
    expect(http).toContain("location /.well-known/acme-challenge/ {");
    expect(http).toContain(`proxy_pass http://${JROK_UPSTREAM_NAME};`);
    expect(http).toContain("proxy_set_header X-Jrok-Acme-Challenge 1;");
    expect(http).not.toContain("root /var/www/certbot");
    expect(https).toContain('proxy_set_header X-Jrok-Acme-Challenge "";');
  });

  test("unedited v3 vhosts upgrade to it; edited ones don't", () => {
    const v3 = renderVhostTemplate(3, DOMAIN, CERT_DIR);
    expect(withNginxConf(WITH_EDGE_CACHE, () => vhostNeedsUpgrade(v3, DOMAIN, CERT_DIR))).toBe(true);
    const edited = v3.replace("proxy_read_timeout 3600s;", "proxy_read_timeout 7200s;");
    expect(withNginxConf(WITH_EDGE_CACHE, () => vhostNeedsUpgrade(edited, DOMAIN, CERT_DIR))).toBe(false);
  });
});

describe("servers whose nginx.conf has no edge cache", () => {
  const missing = join(import.meta.dir, "fixtures/nginx/no-such-nginx.conf");

  test("get template v2, which needs no cache zone", () => {
    const vhost = withNginxConf(missing, () => generateCustomDomainNginxConfig(DOMAIN, CERT_DIR));
    expect(vhostTemplateVersion(vhost)).toBe(2);
    expect(vhost).not.toContain("proxy_cache");
  });

  test("keep their v2 vhosts; once nginx.conf has the cache, unedited ones upgrade", () => {
    const v2 = withNginxConf(missing, () => generateCustomDomainNginxConfig(DOMAIN, CERT_DIR));
    expect(withNginxConf(missing, () => vhostNeedsUpgrade(v2, DOMAIN, CERT_DIR))).toBe(false);
    expect(withNginxConf(WITH_EDGE_CACHE, () => vhostNeedsUpgrade(v2, DOMAIN, CERT_DIR))).toBe(true);

    const edited = v2.replace("proxy_read_timeout 3600s;", "proxy_read_timeout 7200s;");
    expect(withNginxConf(WITH_EDGE_CACHE, () => vhostNeedsUpgrade(edited, DOMAIN, CERT_DIR))).toBe(false);
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

describe("peer edges as backups (JROK_PEERS)", () => {
  const withPeers = (value: string | undefined, fn: () => void) => {
    const saved = process.env.JROK_PEERS;
    if (value === undefined) delete process.env.JROK_PEERS;
    else process.env.JROK_PEERS = value;
    try { fn(); } finally {
      if (saved === undefined) delete process.env.JROK_PEERS;
      else process.env.JROK_PEERS = saved;
    }
  };

  test("with no peers the upstream file is exactly what a single edge always had", () => {
    withPeers(undefined, () => {
      expect(generateJrokUpstreamConfig()).toContain("    server 127.0.0.1:3000;\n    keepalive 64;\n}");
    });
  });

  test("each peer is a backup server, used only while the local jrok is down", () => {
    withPeers("10.130.0.14:3000, 10.130.0.15:3000", () => {
      expect(generateJrokUpstreamConfig()).toContain(
        "    server 127.0.0.1:3000;\n    server 10.130.0.14:3000 backup;\n    server 10.130.0.15:3000 backup;\n    keepalive 64;\n}");
    });
  });

  test("anything that isn't host:port is dropped: it would be written into nginx config", () => {
    withPeers("10.0.0.2:3000; include /etc/passwd,edge-b.internal:3000,bad host:1,[fd00::2]:3000", () => {
      expect(jrokPeers()).toEqual(["edge-b.internal:3000", "[fd00::2]:3000"]);
    });
  });

  test("a changed peer list rewrites jrok's upstream file", () => {
    let current = "";
    withPeers(undefined, () => { current = generateJrokUpstreamConfig(); });
    withPeers("10.130.0.14:3000", () => {
      expect(upstreamFileUpdate(current)).toContain("server 10.130.0.14:3000 backup;");
    });
  });
});
