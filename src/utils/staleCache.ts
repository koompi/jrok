/**
 * A cache for lookups on the request path that must not wait on MongoDB once
 * they have an answer (P8 in docs/plans/jrok-scale-out-plan.md).
 *
 * - A fresh entry is returned as is.
 * - An expired entry is still returned at once, and one background reload
 *   replaces it. If the reload fails the old answer stays: a MongoDB outage
 *   freezes what this server last knew instead of failing every request once
 *   a TTL runs out (on staging, every request waited 10 s and got a 500).
 * - With no entry, get() waits for the first load, which can fail; getNow()
 *   never waits and starts the load in the background.
 *
 * Concurrent loads of one key share a single query. Entries are bounded by
 * maxEntries (oldest dropped first) because a stale answer is kept forever.
 */
export class StaleCache<K, V> {
  private readonly entries = new Map<K, { value: V; expires: number }>();
  private readonly inflight = new Map<K, Promise<V>>();
  private lastErrorLog = 0;

  constructor(
    private readonly name: string,
    private readonly load: (key: K) => Promise<V>,
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  /** The cached answer, loading it first if there is none. */
  async get(key: K): Promise<V> {
    const entry = this.entries.get(key);
    if (entry) {
      if (Date.now() >= entry.expires) this.refresh(key);
      return entry.value;
    }
    return this.loadNow(key);
  }

  /** The cached answer, or undefined. Never waits; loads in the background. */
  getNow(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || Date.now() >= entry.expires) this.refresh(key);
    return entry?.value;
  }

  /** Store an answer this process already knows (e.g. returned by its own write). */
  set(key: K, value: V): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value; // Map keeps insertion order
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    this.inflight.delete(key); // a load already running must not overwrite this
  }

  /** Forget a key; the next get() loads it again. */
  delete(key: K): void {
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  private loadNow(key: K): Promise<V> {
    const running = this.inflight.get(key);
    if (running) return running;

    const promise: Promise<V> = this.load(key).then((value) => {
      // Superseded by set() or delete() while loading: theirs is newer.
      if (this.inflight.get(key) === promise) this.set(key, value);
      return value;
    }).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private refresh(key: K): void {
    if (this.inflight.has(key)) return;
    this.loadNow(key).catch((err) => {
      // Keep the old answer and try again after another TTL, not on every request.
      const entry = this.entries.get(key);
      if (entry) entry.expires = Date.now() + this.ttlMs;
      const now = Date.now();
      if (now - this.lastErrorLog > 30_000) {
        this.lastErrorLog = now;
        console.warn(`⚠️ ${this.name}: reload failed, using the last known answer (${err?.message || err})`);
      }
    });
  }
}
