/**
 * The agent <-> server capability handshake.
 *
 * Streaming is negotiated: the CLI only streams if the server advertises
 * `stream`, and the server only base64-encodes request bodies if the CLI
 * advertises `b64body`. Both sides silently fall back to the legacy buffered,
 * lossy-text path when negotiation fails — no error, no warning.
 *
 * That is exactly how this regressed before: the server side shipped while the
 * built CLI lagged four months behind, so no agent ever asked for streaming and
 * Next.js SSR stayed broken in production while the code to fix it was present.
 *
 * These tests read the literals out of both sides and assert they still agree.
 * Source-reading is unusual for a unit test, but the failure mode here is
 * silence, and the two halves live in separately-built packages that no shared
 * type binds together.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const cliSrc = readFileSync(join(root, "cli/src/index.ts"), "utf8");
const serverIndex = readFileSync(join(root, "src/index.ts"), "utf8");
const agentHandler = readFileSync(join(root, "src/handlers/agentHandler.ts"), "utf8");

/** What the CLI puts in the `caps` query param on the /ws/agent upgrade. */
function cliAdvertisedCaps(): string[] {
  const m = cliSrc.match(/searchParams\.set\(\s*["']caps["']\s*,\s*["']([^"']+)["']\s*\)/);
  if (!m) throw new Error("CLI no longer sets a `caps` query param");
  // Parsed exactly the way agentHandler does it.
  return m[1].split(",").map((c) => c.trim()).filter(Boolean);
}

/** What the server advertises in its welcome message. */
function serverAdvertisedFeatures(): string[] {
  const m = serverIndex.match(/features:\s*\[([^\]]+)\]/);
  if (!m) throw new Error("Server no longer advertises a `features` array");
  return m[1]
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

describe("capability handshake", () => {
  test("server still parses the caps param the CLI sends", () => {
    expect(agentHandler).toContain('searchParams.get("caps")');
    expect(cliSrc).toMatch(/searchParams\.set\(\s*["']caps["']/);
  });

  test("CLI advertises every capability the server gates behaviour on", () => {
    const advertised = cliAdvertisedCaps();

    // Server: `agent.caps?.includes("b64body")` decides whether request bodies
    // are sent base64. Without it, binary uploads go through a lossy UTF-8
    // decode and arrive corrupted.
    const gated = [...serverIndex.matchAll(/caps\?\.includes\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1]
    );

    expect(gated.length).toBeGreaterThan(0);
    for (const cap of gated) {
      expect(advertised).toContain(cap);
    }
  });

  test("server advertises every feature the CLI gates behaviour on", () => {
    const advertised = serverAdvertisedFeatures();

    // CLI: `serverFeatures.has('stream')` decides whether responses stream.
    // Without it, SSE and streaming SSR silently buffer — the Next.js bug.
    const gated = [...cliSrc.matchAll(/serverFeatures\.has\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1]
    );

    expect(gated.length).toBeGreaterThan(0);
    for (const feature of gated) {
      expect(advertised).toContain(feature);
    }
  });

  test("streaming and binary bodies are both negotiated", () => {
    // Guards against someone quietly dropping one half of the pair.
    expect(cliAdvertisedCaps()).toEqual(expect.arrayContaining(["stream", "b64body"]));
    expect(serverAdvertisedFeatures()).toEqual(expect.arrayContaining(["stream", "b64body"]));
  });

  test("the built CLI bundle is not stale relative to its source", () => {
    // The regression that hid this for four months: dist/index.js predated the
    // streaming work, so the shipped agent never negotiated it. A source change
    // without a rebuild must fail loudly here rather than in production.
    const dist = readFileSync(join(root, "cli/dist/index.js"), "utf8");
    for (const cap of cliAdvertisedCaps()) {
      expect(dist).toContain(cap);
    }
    expect(dist).toContain("http_response_start");
  });
});
