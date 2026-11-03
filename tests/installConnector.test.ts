/**
 * install.sh installs jrok-connector only if the built binary runs on this
 * machine. Deploy workers use the connector whenever they find one, so a
 * binary for another architecture, or one needing a newer glibc, took every
 * app on the worker down; the installer printed "✓  in /usr/bin" and went on.
 *
 * Runs install.sh's own install_connector (taken out of the script) in bash,
 * with fake binaries and a temporary bin directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const script = readFileSync(join(import.meta.dir, "../install.sh"), "utf8");
const functions = ["install_connector", "runs_connector"].map((name) => {
  const start = script.indexOf(`\n${name}() {`);
  const end = script.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`install.sh has no ${name}()`);
  return script.slice(start + 1, end + 2);
});

const dir = mkdtempSync(join(tmpdir(), "jrok-install-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

const works = fake("works", '#!/bin/sh\necho "jrok-connector 0.2.0"\n');
// Its open-file warning goes to stderr; the version is what counts.
const warns = fake("warns", '#!/bin/sh\necho "jrok-connector: only 4096 open files allowed" >&2\necho "jrok-connector 0.2.0"\n');
const oldGlibc = fake("old-glibc", "#!/bin/sh\necho \"jrok-connector: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.34' not found\" >&2\nexit 1\n");
// An ELF header for a CPU this machine isn't: exec fails (Exec format error).
const elf = new Uint8Array(64);
elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
elf[16] = 2; // ET_EXEC
elf[18] = process.arch === "arm64" ? 0x3e : 0xb7; // x86-64 on Arm, else AArch64
elf[20] = 1;
const otherArch = fake("other-arch", elf);

/** install_connector built bin_dir, with bin_dir holding `installed` first. */
function install(built: string, installed?: string) {
  const bin = mkdtempSync(join(dir, "bin-"));
  if (installed) writeFileSync(join(bin, "jrok-connector"), readFileSync(installed), { mode: 0o755 });
  const run = Bun.spawnSync(["bash", "-c", `set -e; GREEN=; YELLOW=; NC=\n${functions.join("\n")}\ninstall_connector "$1" "$2"`, "_", built, bin]);
  const target = join(bin, "jrok-connector");
  return {
    ok: run.exitCode === 0,
    said: run.stdout.toString() + run.stderr.toString(),
    installed: existsSync(target) ? readFileSync(target) : null,
    executable: existsSync(target) && (statSync(target).mode & 0o111) !== 0,
  };
}

describe("install.sh: jrok-connector only if it runs here", () => {
  test("a binary that runs is installed", () => {
    for (const built of [works, warns]) {
      const r = install(built);
      expect(r.ok).toBe(true);
      expect(r.installed?.equals(readFileSync(built))).toBe(true);
      expect(r.executable).toBe(true);
      expect(r.said).toContain("✓ jrok-connector 0.2.0 in ");
    }
  });

  test("a binary that doesn't run here is left out, and says why", () => {
    const glibc = install(oldGlibc);
    expect(glibc.ok).toBe(true);
    expect(glibc.installed).toBeNull();
    expect(glibc.said).toContain("doesn't run on this machine");
    expect(glibc.said).toContain("GLIBC_2.34");
    expect(glibc.said).toContain("deploy workers use a jrok process per tunnel");

    const arch = install(otherArch);
    expect(arch.ok).toBe(true);
    expect(arch.installed).toBeNull();
  });

  test("an installed one that doesn't run either is removed, one that runs is kept", () => {
    const broken = install(otherArch, oldGlibc);
    expect(broken.installed).toBeNull();
    expect(broken.said).toContain("which doesn't run either");

    const working = install(otherArch, works);
    expect(working.installed?.equals(readFileSync(works))).toBe(true);
  });
});
