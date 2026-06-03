import pc from "picocolors";

interface OutputState {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  colors: ReturnType<typeof pc.createColors>;
}

const state: OutputState = {
  json: false,
  quiet: false,
  verbose: false,
  colors: pc.createColors(pc.isColorSupported),
};

export function configureOutput(opts: { json?: boolean; quiet?: boolean; verbose?: boolean; color?: boolean }): void {
  if (opts.json !== undefined) state.json = opts.json;
  if (opts.quiet !== undefined) state.quiet = opts.quiet;
  if (opts.verbose !== undefined) state.verbose = opts.verbose;
  if (opts.color !== undefined) state.colors = pc.createColors(opts.color && pc.isColorSupported);
}

export function isJson(): boolean {
  return state.json;
}

/** Human-facing output helpers. All are suppressed in --json or --quiet mode where noted. */
export const out = {
  /** Plain informational line (suppressed in --quiet and --json). */
  info(msg: string): void {
    if (state.quiet || state.json) return;
    process.stdout.write(msg + "\n");
  },
  /** A highlighted step/progress line. */
  step(msg: string): void {
    if (state.quiet || state.json) return;
    process.stdout.write(state.colors.cyan("→ ") + msg + "\n");
  },
  success(msg: string): void {
    if (state.quiet || state.json) return;
    process.stdout.write(state.colors.green("✓ ") + msg + "\n");
  },
  warn(msg: string): void {
    if (state.json) return;
    process.stderr.write(state.colors.yellow("⚠ ") + msg + "\n");
  },
  /** Error line — always shown (also in --quiet), but not in --json (use fail()). */
  error(msg: string): void {
    if (state.json) return;
    process.stderr.write(state.colors.red("✗ ") + msg + "\n");
  },
  /** Verbose-only detail line. */
  detail(msg: string): void {
    if (!state.verbose || state.json) return;
    process.stderr.write(state.colors.dim(msg) + "\n");
  },
  /** Raw stdout (no decoration), suppressed in --quiet/--json. */
  raw(msg: string): void {
    if (state.quiet || state.json) return;
    process.stdout.write(msg + "\n");
  },
  /** Emit a structured JSON document to stdout (always, regardless of quiet). */
  json(obj: unknown): void {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  },
  /**
   * Print `human` text in normal mode, or `data` as JSON in --json mode.
   * The single entry point most command output should go through.
   */
  result(data: unknown, human: () => void): void {
    if (state.json) {
      out.json(data);
    } else {
      human();
    }
  },
  /** Current colorizer set (reflects --no-color, evaluated dynamically). */
  get colors() {
    return state.colors;
  },
};

/** Render a simple fixed-width table (no-op in --json). */
export function table(headers: string[], rows: string[][], widths: number[]): void {
  if (state.quiet || state.json) return;
  const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s).padEnd(w);
  out.raw(state.colors.bold(headers.map((h, i) => pad(h, widths[i] ?? 20)).join("  ")));
  out.raw(state.colors.dim("─".repeat(widths.reduce((a, b) => a + b + 2, 0))));
  for (const row of rows) {
    out.raw(row.map((cell, i) => pad(cell ?? "", widths[i] ?? 20)).join("  "));
  }
}
