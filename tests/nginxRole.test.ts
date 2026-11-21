/**
 * What the Ansible nginx role's nginx.conf promises visitors (audit 2026-11-21):
 * - J2: the edge cache keeps a file the app says nothing about only when its
 *   type is its extension's and, fetched with a cookie, it has Last-Modified.
 *   Otherwise one visitor's account JSON at /account/x.css, or a per-user
 *   script, was handed to whoever asked for that URL within the hour.
 * - J3/J4: a public entry never passes on a visitor's X-Jrok-Peer-Key (with it
 *   jrok trusts one more X-Forwarded-For hop) nor the client-IP headers no
 *   proxy of ours sets (an app reading one got the visitor's claim).
 * Checked in nginx 1.18 with the rendered role too; here the maps are
 * evaluated as nginx does (exact keys, then regexes in order, then default).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const role = readFileSync(join(import.meta.dir, "../ansible/roles/nginx/tasks/main.yml"), "utf8");

type NginxMap = { source: string; exact: Map<string, string>; regex: [RegExp, string][]; fallback: string };

function parseMap(name: string): NginxMap {
  const m = role.match(new RegExp(`map\\s+("?)([^\\s"]+)\\1\\s+\\$${name}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no map $${name} in the nginx role`);
  const map: NginxMap = { source: m[2]!, exact: new Map(), regex: [], fallback: "" };
  for (const line of m[3]!.split("\n")) {
    const r = line.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))\s+(\S+);/);
    if (!r) continue;
    const [, quoted, bare, value] = r;
    if (bare === "default") map.fallback = value!;
    else if ((quoted ?? bare)!.startsWith("~*")) map.regex.push([new RegExp((quoted ?? bare)!.slice(2), "i"), value!]);
    else if ((quoted ?? bare)!.startsWith("~")) map.regex.push([new RegExp((quoted ?? bare)!.slice(1)), value!]);
    else map.exact.set((quoted ?? bare)!, value!);
  }
  return map;
}

function evaluate(name: string, vars: Record<string, string>): string {
  const map = parseMap(name);
  const source = map.source.replace(/\$(\w+)/g, (_, v: string) => (v in vars ? vars[v]! : evaluate(v, vars)));
  if (map.exact.has(source)) return map.exact.get(source)!;
  for (const [re, value] of map.regex) if (re.test(source)) return value;
  return map.fallback;
}

type Fetch = { uri: string; type?: string; cacheControl?: string; cookie?: string; lastModified?: boolean };
function shareable(f: Fetch): boolean {
  return evaluate("jrok_not_shareable", {
    uri: f.uri,
    upstream_http_content_type: f.type ?? "",
    upstream_http_cache_control: f.cacheControl ?? "",
    upstream_http_last_modified: f.lastModified ? "Wed, 18 Nov 2026 10:00:00 GMT" : "",
    http_cookie: f.cookie ?? "",
  }) === "0";
}

describe("the edge cache (J2)", () => {
  test("keeps the files a static server sends, and what the app marks public", () => {
    expect(shareable({ uri: "/assets/index-3f2a.js", type: "application/javascript", cookie: "sid=alice", lastModified: true })).toBe(true);
    expect(shareable({ uri: "/app.js", type: "text/javascript; charset=utf-8" })).toBe(true);
    expect(shareable({ uri: "/m.mjs", type: "text/javascript" })).toBe(true);
    expect(shareable({ uri: "/site.css", type: "TEXT/CSS" })).toBe(true);
    expect(shareable({ uri: "/f.woff2", type: "font/woff2", cookie: "sid=alice", lastModified: true })).toBe(true);
    expect(shareable({ uri: "/f.woff", type: "application/font-woff" })).toBe(true);
    expect(shareable({ uri: "/a.wasm", type: "application/wasm" })).toBe(true);
    expect(shareable({ uri: "/_next/static/chunks/x.js", type: "application/javascript", cacheControl: "public, max-age=31536000, immutable", cookie: "sid=alice" })).toBe(true);
    expect(shareable({ uri: "/api/feed", type: "application/json", cacheControl: "s-maxage=60" })).toBe(true);
  });

  test("never one visitor's own: a type that isn't the extension's, or a script made for the cookie it came with", () => {
    // Web cache deception: an account's JSON answered at a .css path.
    expect(shareable({ uri: "/account/x.css", type: "application/json", cookie: "sid=alice" })).toBe(false);
    expect(shareable({ uri: "/account/x.css", type: "application/json", lastModified: true })).toBe(false);
    expect(shareable({ uri: "/api.php/x.js", type: "text/html" })).toBe(false);
    expect(shareable({ uri: "/download/x.ttf", type: "application/octet-stream", lastModified: true })).toBe(false);
    // A per-user script (no Last-Modified), however the cookie is written.
    expect(shareable({ uri: "/config.js", type: "application/javascript", cookie: "sid=alice" })).toBe(false);
    expect(shareable({ uri: "/p.css", type: "text/css", cookie: "a=x|y; sid=alice" })).toBe(false);
    expect(shareable({ uri: "/p.css", type: "text/css", cookie: "|1|" })).toBe(false);
    // What the app says nothing about, or keeps for itself, as before.
    expect(shareable({ uri: "/logo.png", type: "image/png", lastModified: true })).toBe(false);
    expect(shareable({ uri: "/x.css", type: "text/css", cacheControl: "max-age=60" })).toBe(false);
    expect(shareable({ uri: "/x.js", type: "application/javascript", cacheControl: "private, max-age=60" })).toBe(false);
    // The visitor writes the URL: it can't reach the fields before it.
    expect(shareable({ uri: "/x|public|.css", type: "application/json" })).toBe(false);
  });
});

/** The block that starts at the first "{" after `from`, braces counted (Jinja's tags balance). */
function block(from: number): string {
  const open = role.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < role.length; i++) {
    if (role[i] === "{") depth++;
    else if (role[i] === "}" && --depth === 0) return role.slice(open, i + 1);
  }
  throw new Error("unbalanced braces in the nginx role");
}
function serverWith(marker: string): string {
  const at = role.indexOf(marker);
  if (at < 0) throw new Error(`no server with ${marker} in the nginx role`);
  return block(role.lastIndexOf("server {", at));
}
const LOOP = '{% for h in jrok_visitor_only_headers %}\n            proxy_set_header {{ h }} "";\n            {% endfor %}';

describe("a visitor's own headers (J3, J4)", () => {
  test("are the edge-to-edge key and every client-IP header no proxy of ours sets", () => {
    const list = role.match(/\{% set jrok_visitor_only_headers = \[([^\]]*)\] %\}/)?.[1] ?? "";
    for (const h of ["X-Jrok-Peer-Key", "X-Client-IP", "Client-IP", "CF-Connecting-IP", "True-Client-IP", "Fastly-Client-IP", "X-Cluster-Client-IP"]) {
      expect(list).toContain(`'${h}'`);
    }
    // jrok sets these itself, from the connection: never blank them.
    for (const h of ["X-Forwarded-For", "X-Real-IP"]) expect(list).not.toContain(`'${h}'`);
  });

  test("are dropped by every location of the public entries (ports 80 and 443) that proxies", () => {
    const publicServers = [serverWith("listen 80 default_server;"), serverWith("listen 443 ssl http2 default_server;")];
    let proxied = 0;
    for (const server of publicServers) {
      const base = role.indexOf(server);
      for (const m of server.matchAll(/\n\s*location ([^{]*)\{/g)) {
        const body = block(base + m.index!);
        if (!/proxy_pass /.test(body)) continue;
        proxied++;
        expect([m[1]!.trim(), body.includes(LOOP)]).toEqual([m[1]!.trim(), true]);
      }
    }
    expect(proxied).toBe(5); // acme-challenge, = /ws/agent, /ws/, /, @jrok_peers
  });

  test("while the key still goes between edges: the gateway adds it, the edge-to-edge entry passes it on", () => {
    const gateway = serverWith("listen 127.0.0.1:{{ jrok_peer_gateway_port }};");
    expect(gateway).toContain("include /etc/nginx/jrok-peer-key.conf;");
    expect(gateway).not.toContain("jrok_visitor_only_headers");
    const edgeToEdge = serverWith("server_name {{ forward_host }} {{ jrok_peer_name }};");
    expect(edgeToEdge).toContain("deny all;");
    expect(edgeToEdge).not.toContain("jrok_visitor_only_headers");
    expect(edgeToEdge).not.toMatch(/proxy_set_header X-Jrok-Peer-Key/i);
  });
});
