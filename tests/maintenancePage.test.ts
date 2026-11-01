import { expect, test } from "bun:test";
import { join } from "path";
import { maintenancePage } from "../src/utils/maintenancePage";

test("the maintenance page names the app, the edge and the time, escaped", () => {
  const page = maintenancePage(join(import.meta.dir, "..", "index.html"), 'shop.example.com"><script>x</script>', "vps-sgp1", new Date("2026-11-01T02:31:45Z"))!;
  expect(page).toContain("shop.example.com&quot;&gt;&lt;script&gt;x&lt;/script&gt;");
  expect(page).not.toContain("<script>x</script>");
  expect(page).toContain("Error 503 · vps-sgp1 · 2026-11-01 02:31 UTC");
  expect(page).not.toContain("{{");
});
