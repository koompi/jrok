/**
 * HTTP-01 challenges with several edges (plan step 2.3).
 *
 * A custom domain's certificate is requested by certbot on whichever edge took
 * the verify call, and certbot writes the challenge answer into that edge's
 * webroot. Let's Encrypt then fetches it through DNS, which may lead to any
 * edge, and from several places at once: with two edges an issuance failed
 * (404 from the other edge, staging 2026-11-01). Renewals have the same
 * problem.
 *
 * nginx therefore hands port-80 challenge requests to jrok (custom-domain
 * vhosts from template v4, the temporary challenge vhost, and the Ansible
 * default port-80 server), marked with X-Jrok-Acme-Challenge. jrok answers
 * from this edge's webroot, or asks the other edges, which answer from theirs.
 * The HTTPS server blocks clear the marker, so a visitor can't use it to
 * reach this path instead of their app.
 */
import { readFile } from "fs/promises";
import { isFromPeer, addressPeerRequest, peerOrigin } from "../utils/peerLink";

export const ACME_PATH = "/.well-known/acme-challenge/";
export const ACME_MARKER_HEADER = "X-Jrok-Acme-Challenge";
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const PEER_TIMEOUT_MS = 3_000;

export interface AcmePeer {
  serverId?: string;
  serverHost: string;
  serverPort: number;
  forwardUrl?: string;
}

/** A challenge request nginx passed on from a port-80 server block. */
export function isAcmeChallengeRequest(req: Request, path: string): boolean {
  return req.method === "GET" && path.startsWith(ACME_PATH) && req.headers.get(ACME_MARKER_HEADER) === "1";
}

function webroot(): string {
  return process.env.ACME_WEBROOT || "/var/www/certbot";
}

async function localAnswer(token: string): Promise<string | null> {
  return readFile(`${webroot()}${ACME_PATH}${token}`, "utf8").catch(() => null);
}

async function askPeer(peer: AcmePeer, token: string, host: string | null, serverId: string): Promise<string | null> {
  const headers = new Headers({ [ACME_MARKER_HEADER]: "1", "X-Forwarded-From": serverId });
  addressPeerRequest(peer, host, (n, v) => headers.set(n, v), (n) => headers.delete(n));
  try {
    const res = await fetch(`${peerOrigin(peer)}${ACME_PATH}${token}`, {
      headers,
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    const body = await res.text();
    return res.status === 200 ? body : null;
  } catch {
    return null;
  }
}

/** The first peer's answer, or null when none has it. */
async function firstPeerAnswer(asks: Promise<string | null>[]): Promise<string | null> {
  if (asks.length === 0) return null;
  return new Promise((resolve) => {
    let pending = asks.length;
    for (const ask of asks) {
      ask.then((answer) => {
        if (answer !== null) resolve(answer);
        else if (--pending === 0) resolve(null);
      });
    }
  });
}

/**
 * Answer a challenge: from this edge's webroot, else from another edge's. A
 * request another edge sent is answered from here only (one hop).
 */
export async function answerAcmeChallenge(
  req: Request,
  path: string,
  peers: () => Promise<AcmePeer[]>,
  serverId: string
): Promise<Response> {
  const notFound = () => new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
  const token = path.slice(ACME_PATH.length);
  if (!TOKEN.test(token)) return notFound();

  const answer = await localAnswer(token);
  if (answer !== null) return new Response(answer, { headers: { "Content-Type": "text/plain" } });
  if (isFromPeer(req.headers) || req.headers.has("X-Forwarded-From")) return notFound();

  const others = (await peers().catch(() => [] as AcmePeer[])).filter((p) => p.serverId !== serverId);
  const fromPeer = await firstPeerAnswer(others.map((p) => askPeer(p, token, req.headers.get("host"), serverId)));
  if (fromPeer === null) return notFound();
  return new Response(fromPeer, { headers: { "Content-Type": "text/plain" } });
}
