/**
 * Where the server key is accepted from (plan 3.4, utils/serverKeySources.ts).
 */
import { test, expect } from "bun:test";
import { serverKeyAllowedFrom } from "../src/utils/serverKeySources";

test("unset: from anywhere, as before", () => {
  expect(serverKeyAllowedFrom("203.0.113.9", [])).toBe(true);
});

test("set: only the listed addresses and ranges, and this machine", () => {
  const sources = ["198.51.100.7", "10.130.0.0/16"];
  expect(serverKeyAllowedFrom("198.51.100.7", sources)).toBe(true);
  expect(serverKeyAllowedFrom("10.130.4.2", sources)).toBe(true);
  expect(serverKeyAllowedFrom("127.0.0.1", sources)).toBe(true);
  expect(serverKeyAllowedFrom("::1", sources)).toBe(true);
  expect(serverKeyAllowedFrom("203.0.113.9", sources)).toBe(false);
  expect(serverKeyAllowedFrom("unknown", sources)).toBe(false);
});
