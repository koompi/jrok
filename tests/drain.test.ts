import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isDraining } from "../src/utils/drain";

const dir = mkdtempSync(join(tmpdir(), "jrok-drain-"));
afterEach(() => rmSync(join(dir, "drain"), { force: true }));

test("an edge drains while the file exists, and comes back when it is removed", () => {
  const file = join(dir, "drain");
  expect(isDraining(file)).toBe(false);
  writeFileSync(file, "");
  expect(isDraining(file)).toBe(true);
  rmSync(file);
  expect(isDraining(file)).toBe(false);
});
