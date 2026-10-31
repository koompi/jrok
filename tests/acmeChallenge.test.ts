/**
 * Certificate challenges with several edges (plan step 2.3,
 * services/acmeChallenge.ts): answered from this edge's certbot webroot, or
 * from another edge's, one hop at most. On staging, before this, an issuance
 * failed with 404 from the edge that hadn't run certbot.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ACME_MARKER_HEADER,
  ACME_PATH,
  answerAcmeChallenge,
  isAcmeChallengeRequest,
  type AcmePeer,
} from "../src/services/acmeChallenge";

const webroot = mkdtempSync(join(tmpdir(), "acme-"));
const saved = process.env.ACME_WEBROOT;
beforeAll(() => {
  mkdirSync(join(webroot, ACME_PATH), { recursive: true });
  writeFileSync(join(webroot, ACME_PATH, "local-token"), "local-token.thumbprint");
  process.env.ACME_WEBROOT = webroot;
});
afterAll(() => {
  if (saved === undefined) delete process.env.ACME_WEBROOT;
  else process.env.ACME_WEBROOT = saved;
});

const challenge = (token: string, headers: Record<string, string> = {}) =>
  new Request(`http://shop.customer.com${ACME_PATH}${token}`, {
    headers: { host: "shop.customer.com", [ACME_MARKER_HEADER]: "1", ...headers },
  });

/** A stub edge holding `tokens`; records what it was asked. */
function stubEdge(tokens: Record<string, string>) {
  const asked: Headers[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      asked.push(req.headers);
      const token = new URL(req.url).pathname.slice(ACME_PATH.length);
      return token in tokens ? new Response(tokens[token]) : new Response("no", { status: 404 });
    },
  });
  const peer: AcmePeer = { serverId: `peer-${server.port}`, serverHost: "127.0.0.1", serverPort: server.port as number };
  return { peer, asked, stop: () => server.stop(true) };
}

test("only GETs nginx marked as challenges are handled", () => {
  expect(isAcmeChallengeRequest(challenge("t"), `${ACME_PATH}t`)).toBe(true);
  expect(isAcmeChallengeRequest(new Request(`http://x${ACME_PATH}t`), `${ACME_PATH}t`)).toBe(false);
  expect(isAcmeChallengeRequest(challenge("t"), "/other")).toBe(false);
});

describe("answering", () => {
  test("from this edge's webroot, without asking anyone", async () => {
    let asked = false;
    const res = await answerAcmeChallenge(challenge("local-token"), `${ACME_PATH}local-token`, async () => { asked = true; return []; }, "me");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("local-token.thumbprint");
    expect(asked).toBe(false);
  });

  test("from the edge whose certbot wrote it", async () => {
    const without = stubEdge({});
    const holder = stubEdge({ "their-token": "their-token.thumbprint" });
    try {
      const res = await answerAcmeChallenge(challenge("their-token"), `${ACME_PATH}their-token`, async () => [without.peer, holder.peer], "me");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("their-token.thumbprint");
      // Asked as a challenge, for the visitor's host, saying who asked (so it doesn't ask on).
      const sent = holder.asked[0]!;
      expect(sent.get(ACME_MARKER_HEADER)).toBe("1");
      expect(sent.get("host")).toBe("shop.customer.com");
      expect(sent.get("x-forwarded-from")).toBe("me");
    } finally {
      without.stop();
      holder.stop();
    }
  });

  test("404 when no edge has it", async () => {
    const empty = stubEdge({});
    try {
      const res = await answerAcmeChallenge(challenge("nobody"), `${ACME_PATH}nobody`, async () => [empty.peer], "me");
      expect(res.status).toBe(404);
    } finally {
      empty.stop();
    }
  });

  test("another edge's question is answered from here only: one hop", async () => {
    let asked = false;
    const res = await answerAcmeChallenge(
      challenge("elsewhere", { "x-forwarded-from": "edge-b" }), `${ACME_PATH}elsewhere`, async () => { asked = true; return []; }, "me");
    expect(res.status).toBe(404);
    expect(asked).toBe(false);
  });

  test("this edge is never asked about itself, and a token that isn't one is refused", async () => {
    let asked = false;
    const self: AcmePeer = { serverId: "me", serverHost: "127.0.0.1", serverPort: 1 };
    expect((await answerAcmeChallenge(challenge("x"), `${ACME_PATH}x`, async () => [self], "me")).status).toBe(404);
    const res = await answerAcmeChallenge(challenge("../../etc/passwd"), `${ACME_PATH}../../etc/passwd`, async () => { asked = true; return []; }, "me");
    expect(res.status).toBe(404);
    expect(asked).toBe(false);
  });
});
