/**
 * Health-checked DNS (plan Phase 3.1): which edges belong in the round-robin
 * records. Pure functions, so every rule here is tested without a network.
 *
 * Each checker probes the other edges from outside and records a verdict per
 * edge (with hysteresis, so one lost probe doesn't count). An edge leaves DNS
 * when most checkers that can see it say it is down, and comes back when most
 * say it is up. A checker never judges its own edge: a machine can't tell
 * whether the internet reaches it.
 */

export interface Edge {
  /** The edge's id (VPS_ID); also the id its own checker votes under. */
  id: string;
  /** The address visitors reach it on: an IPv4 (A record) or IPv6 (AAAA) address. */
  address: string;
}

export interface Vote {
  checker: string;
  edge: string;
  healthy: boolean;
}

export type Verdict = "up" | "down" | "unknown";

/** One checker's view of one edge, debounced. */
export interface ProbeState {
  healthy: boolean;
  /** Consecutive probes that disagreed with `healthy`. */
  streak: number;
}

export const INITIAL_PROBE_STATE: ProbeState = { healthy: true, streak: 0 };

/** The state after one more probe: it flips after `failAfter` failures, or `recoverAfter` successes, in a row. */
export function nextProbeState(
  prev: ProbeState,
  ok: boolean,
  { failAfter, recoverAfter }: { failAfter: number; recoverAfter: number }
): ProbeState {
  if (ok === prev.healthy) return { healthy: prev.healthy, streak: 0 };
  const streak = prev.streak + 1;
  if (streak >= (prev.healthy ? failAfter : recoverAfter)) return { healthy: ok, streak: 0 };
  return { healthy: prev.healthy, streak };
}

/**
 * Each edge's verdict from the checkers' current votes: "down" only when more
 * checkers say down than up, so one checker on a bad network path can't take a
 * healthy edge out. "unknown" when no other checker voted (left as it is).
 */
export function verdicts(edges: Edge[], votes: Vote[]): Map<string, Verdict> {
  const result = new Map<string, Verdict>();
  for (const edge of edges) {
    let up = 0;
    let down = 0;
    for (const vote of votes) {
      if (vote.edge !== edge.id || vote.checker === edge.id) continue;
      if (vote.healthy) up++;
      else down++;
    }
    result.set(edge.id, up + down === 0 ? "unknown" : down > up ? "down" : "up");
  }
  return result;
}

/**
 * What to change in one record, given the addresses it has now. Only the
 * edges' own addresses are ever added or removed; anything else in the record
 * is left alone. A record is never emptied of edges: if every edge looks down,
 * sending visitors to them is still better than a name that doesn't resolve
 * (and gets cached as missing).
 */
export function planRecord(
  edges: Edge[],
  verdict: Map<string, Verdict>,
  currentAddresses: string[]
): { add: string[]; remove: string[] } {
  const current = new Set(currentAddresses);
  const desired = edges
    .filter((edge) => {
      const v = verdict.get(edge.id) ?? "unknown";
      return v === "up" || (v === "unknown" && current.has(edge.address));
    })
    .map((edge) => edge.address);
  if (desired.length === 0) return { add: [], remove: [] };

  const want = new Set(desired);
  return {
    add: desired.filter((address) => !current.has(address)),
    remove: edges.map((edge) => edge.address).filter((address) => current.has(address) && !want.has(address)),
  };
}

/** "id=address,id=address" (DNS_HEALTH_EDGES) as edges; malformed entries are refused. */
export function parseEdges(raw: string | undefined): Edge[] {
  const edges: Edge[] = [];
  for (const entry of (raw || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const id = entry.slice(0, eq).trim();
    const address = entry.slice(eq + 1).trim();
    if (eq <= 0 || !/^[A-Za-z0-9._-]+$/.test(id) || !isIpAddress(address)) {
      throw new Error(`DNS_HEALTH_EDGES: "${entry}" is not id=ip-address`);
    }
    edges.push({ id, address });
  }
  return edges;
}

function isIpAddress(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || (/^[0-9a-fA-F:]+$/.test(value) && value.includes(":"));
}

/** The DNS record type for an address. */
export function recordType(address: string): "A" | "AAAA" {
  return address.includes(":") ? "AAAA" : "A";
}
