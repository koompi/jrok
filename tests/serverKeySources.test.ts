/**
 * Where the server key is accepted from (plan 3.4, utils/serverKeySources.ts).
 */
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { serverKeyAllowedFrom } from "../src/utils/serverKeySources";

test("unset: from anywhere, as before", () => {
  expect(serverKeyAllowedFrom("203.0.113.9", [])).toBe(true);
});

test("set: only the listed addresses and ranges, and this machine", () => {
  const sources = ["198.51.100.7", "10.130.0.0/16"];
  expect(serverKeyAllowedFrom("198.51.100.7", sources)).toBe(true);
  expect(serverKeyAllowedFrom("10.130.4.2", sources)).toBe(true);
  expect(serverKeyAllowedFrom("127.0.0.1", sources)).toBe(true);
  expect(serverKeyAllowedFrom("::1", sources)).toBe(true);
  expect(serverKeyAllowedFrom("203.0.113.9", sources)).toBe(false);
  expect(serverKeyAllowedFrom("unknown", sources)).toBe(false);
});

test("Ansible: a hand-built edge (jrok_manual) is a peer in nginx, never a trusted proxy or a server-key source", () => {
  // kh1's address is the office's, shared with machines that run customers' code.
  const read = (p: string) => readFileSync(join(import.meta.dir, "../ansible", p), "utf8");
  const playbook = read("playbook.yml");
  const app = read("roles/app/tasks/main.yml");
  const nginx = read("roles/nginx/tasks/main.yml");
  expect(playbook).toContain(
    "jrok_manual_hosts: \"{{ groups['jrok_manual'] | default([]) | map('extract', hostvars, 'ansible_host') | list }}\""
  );
  const unitLine = (key: string) => {
    const lines = app.split("\n").filter((l) => l.trim().startsWith(`Environment=${key}=`));
    expect(lines).toHaveLength(1);
    return lines[0]!;
  };
  expect(unitLine("TRUSTED_PROXY_IPS")).toContain("jrok_peer_sources | reject('in', jrok_manual_hosts)");
  expect(unitLine("SERVER_KEY_SOURCES")).toContain(
    "groups['jrok_servers'] | map('extract', hostvars, 'ansible_host') | reject('in', jrok_manual_hosts)"
  );
  // nginx's edge-to-edge entry still lets it in: it forwards there, with the peer key.
  expect(nginx.match(/\{% for source in jrok_peer_sources %\}\n\s*allow \{\{ source \}\};/g)).toHaveLength(1);
});
