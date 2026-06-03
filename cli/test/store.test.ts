import { describe, it, expect } from "vitest";
import { CaptureStore, type HttpCapture } from "../src/inspector/store";

const cap = (id: string): HttpCapture => ({ id, time: 0, method: "GET", path: "/" + id, status: 200, durationMs: 1 });

describe("CaptureStore", () => {
  it("stores newest-first and enforces the ring buffer size", () => {
    const s = new CaptureStore(2);
    s.add(cap("a"));
    s.add(cap("b"));
    s.add(cap("c"));
    expect(s.list().map((c) => c.id)).toEqual(["c", "b"]);
    expect(s.get("a")).toBeUndefined();
    expect(s.get("c")?.path).toBe("/c");
  });

  it("emits a capture event on add", () => {
    const s = new CaptureStore();
    let got = "";
    s.on("capture", (c: HttpCapture) => (got = c.id));
    s.add(cap("x"));
    expect(got).toBe("x");
  });
});
