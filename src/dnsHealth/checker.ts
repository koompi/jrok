/**
 * One health-checked DNS checker (plan Phase 3.1). Every cycle it probes the
 * other edges, records its debounced verdicts in MongoDB, and, if it holds the
 * writer lease, brings the DNS records in line with what all checkers say
 * (decide.ts). Times come from MongoDB's clock, so checkers' clocks need not
 * agree. If MongoDB or Cloudflare can't be reached, nothing changes.
 */
import type { Db } from "mongodb";
import {
  type Edge,
  type ProbeState,
  INITIAL_PROBE_STATE,
  nextProbeState,
  planRecord,
  verdicts,
} from "./decide";
import type { AddressRecord } from "./cloudflare";

export interface DnsHealthConfig {
  /** This checker's id: the edge's VPS_ID when it runs on an edge, so it never judges itself. */
  checkerId: string;
  edges: Edge[];
  /** The round-robin record names to keep healthy, e.g. "public.koompi.cloud", "*.public.koompi.cloud". */
  records: string[];
  failAfter: number;
  recoverAfter: number;
  /** Votes older than this are ignored: their checker has stopped. */
  maxVoteAgeMs: number;
  leaseMs: number;
  dryRun: boolean;
}

/** Changes worth telling a person about (Telegram in main.ts). */
export type DnsHealthNotice =
  | { change: "removed" | "added"; edge: Edge; records: string[] }
  | { change: "all-down"; records: string[] };

export interface DnsClient {
  addressRecords(name: string): Promise<AddressRecord[]>;
  addAddress(name: string, address: string): Promise<void>;
  removeRecord(name: string, recordId: string): Promise<void>;
}

const LEASE_ID = "dns-writer";

export class DnsHealthChecker {
  private states = new Map<string, ProbeState>();
  private leader = false;
  private allDown = false;

  constructor(
    private config: DnsHealthConfig,
    private db: Db,
    private dns: DnsClient,
    private probe: (edge: Edge) => Promise<boolean>,
    private log: (message: string) => void = (m) => console.log(`[dns-health] ${m}`),
    private notify: (notice: DnsHealthNotice) => void = () => {}
  ) {}

  async cycle(): Promise<void> {
    await this.vote();
    if (await this.holdLease()) await this.applyDns();
  }

  /** Probe every other edge and record what this checker sees. */
  private async vote(): Promise<void> {
    const { checkerId, edges, failAfter, recoverAfter } = this.config;
    const others = edges.filter((edge) => edge.id !== checkerId);
    const results = await Promise.all(others.map((edge) => this.probe(edge).catch(() => false)));

    const writes = others.map((edge, i) => {
      const prev = this.states.get(edge.id) ?? INITIAL_PROBE_STATE;
      const next = nextProbeState(prev, results[i]!, { failAfter, recoverAfter });
      if (next.healthy !== prev.healthy) this.log(`${edge.id} (${edge.address}) looks ${next.healthy ? "up" : "down"} from here`);
      this.states.set(edge.id, next);
      return {
        updateOne: {
          filter: { _id: `${checkerId}:${edge.id}` as any },
          update: [{ $set: { checker: checkerId, edge: edge.id, healthy: next.healthy, at: "$$NOW" } }],
          upsert: true,
        },
      };
    });
    if (writes.length > 0) await this.db.collection("dnsHealthVotes").bulkWrite(writes);
  }

  /** Take or renew the writer lease: one checker at a time changes DNS. */
  private async holdLease(): Promise<boolean> {
    const me = this.config.checkerId;
    const leases = this.db.collection("dnsHealthLease");
    // Two steps: MongoDB allows no $expr (for its own clock) in an upsert.
    await leases.updateOne(
      { _id: LEASE_ID as any },
      { $setOnInsert: { holder: null, expiresAt: new Date(0) } },
      { upsert: true }
    );
    const lease = await leases.findOneAndUpdate(
      { _id: LEASE_ID as any, $expr: { $or: [{ $eq: ["$holder", me] }, { $lt: ["$expiresAt", "$$NOW"] }] } },
      [{ $set: { holder: me, expiresAt: { $add: ["$$NOW", this.config.leaseMs] } } }],
      { returnDocument: "after" }
    );
    const held = lease?.holder === me;
    if (held !== this.leader) this.log(held ? "writing DNS (holds the lease)" : "no longer writing DNS");
    this.leader = held;
    return held;
  }

  /** On shutdown: release the lease and withdraw this checker's votes, so the others decide without it at once. */
  async release(): Promise<void> {
    await this.db.collection("dnsHealthLease").updateOne(
      { _id: LEASE_ID as any, holder: this.config.checkerId },
      { $set: { expiresAt: new Date(0) } }
    );
    await this.db.collection("dnsHealthVotes").deleteMany({ checker: this.config.checkerId });
    this.leader = false;
  }

  private async applyDns(): Promise<void> {
    const { edges, records, maxVoteAgeMs, dryRun } = this.config;
    const votes = await this.db
      .collection("dnsHealthVotes")
      .find({ $expr: { $gte: ["$at", { $subtract: ["$$NOW", maxVoteAgeMs] }] } })
      .toArray();
    const verdict = verdicts(edges, votes.map((v) => ({ checker: v.checker, edge: v.edge, healthy: v.healthy })));

    // Every edge down at once is more likely the checkers' own trouble than
    // the edges'; the records are left alone (planRecord), and a person told.
    const allDown = edges.length > 0 && edges.every((e) => verdict.get(e.id) === "down");
    if (allDown && !this.allDown) this.notify({ change: "all-down", records });
    this.allDown = allDown;

    const changed = new Map<string, { change: "removed" | "added"; edge: Edge; records: string[] }>();
    const note = (change: "removed" | "added", edge: Edge, name: string) => {
      const entry = changed.get(edge.id) ?? { change, edge, records: [] };
      entry.records.push(name);
      changed.set(edge.id, entry);
    };

    for (const name of records) {
      const current = await this.dns.addressRecords(name);
      const plan = planRecord(edges, verdict, current.map((r) => r.content));
      for (const address of plan.remove) {
        const edge = edges.find((e) => e.address === address)!;
        this.log(`${dryRun ? "would remove" : "removing"} ${edge.id} (${address}) from ${name}: down`);
        if (dryRun) continue;
        for (const record of current.filter((r) => r.content === address)) await this.dns.removeRecord(name, record.id);
        note("removed", edge, name);
      }
      for (const address of plan.add) {
        const edge = edges.find((e) => e.address === address)!;
        this.log(`${dryRun ? "would add" : "adding"} ${edge.id} (${address}) to ${name}: up`);
        if (!dryRun) {
          await this.dns.addAddress(name, address);
          note("added", edge, name);
        }
      }
    }
    for (const notice of changed.values()) this.notify(notice);
  }
}
