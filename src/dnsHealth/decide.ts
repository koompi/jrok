/**
 * Health-checked DNS (plan Phase 3.1): which edges belong in the round-robin
 * records. Pure functions, so every rule here is tested without a network.
 *
 * Each checker probes the other edges from outside and records a verdict per
 * edge (with hysteresis, so one lost probe doesn't count). An edge leaves DNS
 * when most checkers that can see it say it is down, and comes back when most
 * say it is up. A checker never judges its own edge: a machine can't tell
 * whether the internet reaches it.
 *
 * Checkers are grouped by region (DNS_HEALTH_EDGES id=address@region; the
 * default region when none is given). Each region's checkers give one view
 * of an edge, as above, and the edge leaves when most regions say it is down.
 * With every edge in one region (today's Singapore edges) that is exactly the
 * rule above. With two regions, a cut between them is not taken for an outage:
 * the region that can't reach the other outvoted it by numbers (three
 * Singapore checkers would take both Cambodian edges out, though Cambodian
 * visitors still reach them). A split between regions leaves the edge as it
 * is. A region that is really down usually can't reach MongoDB either, so its
 * votes go stale and the other regions decide; a checker in a third place
 * tells the two apart when they can't.
 */

export interface Edge {
  /** The edge's id (VPS_ID); also the id its own checker votes under. */
  id: string;
  /** The address visitors reach it on: an IPv4 (A record) or IPv6 (AAAA) address. */
  address: string;
  /** Where it is (DNS_HEALTH_EDGES id=address@region); DEFAULT_REGION when not given. */
  region?: string;
}

export interface Vote {
  checker: string;
  edge: string;
  healthy: boolean;
  /** The address the checker probed (absent from checkers older than this field). */
  address?: string;
  /** The checker's region (absent from checkers older than this field: the default region). */
  region?: string;
}

export const DEFAULT_REGION = "default";

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
 * Each region's view of an edge: "down" when more of its checkers say down
 * than up, so one checker on a bad network path can't take a healthy edge
 * out; else "up". Only votes about the edge's own address count, and never
 * the edge's own checker's.
 */
export function regionViews(edge: Edge, votes: Vote[]): Map<string, "up" | "down"> {
  const tally = new Map<string, { up: number; down: number }>();
  for (const vote of votes) {
    if (vote.edge !== edge.id || vote.checker === edge.id) continue;
    // A checker that knows this edge by another address probed another
    // machine: an edge replaced under the same id, with the checkers'
    // settings not all updated yet.
    if (vote.address !== undefined && vote.address !== edge.address) continue;
    const region = vote.region || DEFAULT_REGION;
    const t = tally.get(region) ?? { up: 0, down: 0 };
    if (vote.healthy) t.up++;
    else t.down++;
    tally.set(region, t);
  }
  return new Map([...tally].map(([region, t]) => [region, t.down > t.up ? "down" : "up"]));
}

/**
 * Each edge's verdict from the checkers' current votes: "down" when most
 * regions see it down, "up" when most see it up. "unknown" (left as it is)
 * when no other checker voted, or the regions are split evenly.
 */
export function verdicts(edges: Edge[], votes: Vote[]): Map<string, Verdict> {
  const result = new Map<string, Verdict>();
  for (const edge of edges) {
    let up = 0;
    let down = 0;
    for (const view of regionViews(edge, votes).values()) {
      if (view === "down") down++;
      else up++;
    }
    result.set(edge.id, down > up ? "down" : up > down ? "up" : "unknown");
  }
  return result;
}

/**
 * What to change in one record, given the addresses it has now. Only the
 * edges' own addresses are added or removed, plus `leftovers`: addresses the
 * checkers once put there that belong to no edge now (see leftoverAddresses).
 * Anything else in the record is left alone. A record is never emptied of
 * edges: if every edge looks down, sending visitors to them is still better
 * than a name that doesn't resolve (and gets cached as missing).
 */
export function planRecord(
  edges: Edge[],
  verdict: Map<string, Verdict>,
  currentAddresses: string[],
  leftovers: string[] = []
): { add: string[]; remove: string[]; leftovers: string[] } {
  const current = new Set(currentAddresses);
  const desired = edges
    .filter((edge) => {
      const v = verdict.get(edge.id) ?? "unknown";
      return v === "up" || (v === "unknown" && current.has(edge.address));
    })
    .map((edge) => edge.address);
  if (desired.length === 0) return { add: [], remove: [], leftovers: [] };

  const want = new Set(desired);
  return {
    add: desired.filter((address) => !current.has(address)),
    remove: edges.map((edge) => edge.address).filter((address) => current.has(address) && !want.has(address)),
    leftovers: [...new Set(leftovers)].filter((address) => current.has(address) && !want.has(address)),
  };
}

/**
 * Addresses in a record that the checkers added (`managed`) but that no edge
 * has any more: an edge removed or replaced by a new machine. One is only a
 * leftover once no checker probes it either, so a checker whose settings are
 * newer than the writer's (an edge being added) never has its edge taken out.
 */
export function leftoverAddresses(
  edges: Edge[],
  records: Array<{ content: string; managed: boolean }>,
  probed: Set<string>
): string[] {
  const known = new Set(edges.map((edge) => edge.address));
  return [...new Set(records.filter((r) => r.managed && !known.has(r.content) && !probed.has(r.content)).map((r) => r.content))];
}

/** "id=address[@region],…" (DNS_HEALTH_EDGES) as edges; malformed entries are refused. */
export function parseEdges(raw: string | undefined): Edge[] {
  const edges: Edge[] = [];
  for (const entry of (raw || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const id = entry.slice(0, eq).trim();
    const rest = entry.slice(eq + 1).trim();
    const at = rest.lastIndexOf("@");
    const address = (at === -1 ? rest : rest.slice(0, at)).trim();
    const region = at === -1 ? undefined : rest.slice(at + 1).trim();
    if (eq <= 0 || !/^[A-Za-z0-9._-]+$/.test(id) || !isIpAddress(address) || (region !== undefined && !/^[A-Za-z0-9._-]+$/.test(region))) {
      throw new Error(`DNS_HEALTH_EDGES: "${entry}" is not id=ip-address or id=ip-address@region`);
    }
    edges.push(region === undefined ? { id, address } : { id, address, region });
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
