import { describe, expect, test } from "bun:test";
import { firstSubprotocol } from "../src/utils/wsSubprotocol";

describe("WebSocket subprotocols (P32)", () => {
  test("the visitor's first choice", () => {
    expect(firstSubprotocol("graphql-transport-ws")).toBe("graphql-transport-ws");
    expect(firstSubprotocol("graphql-transport-ws, graphql-ws")).toBe("graphql-transport-ws");
    expect(firstSubprotocol(" v12.stomp ,v11.stomp")).toBe("v12.stomp");
  });

  test("nothing when none or not a valid token", () => {
    expect(firstSubprotocol(null)).toBeUndefined();
    expect(firstSubprotocol("")).toBeUndefined();
    expect(firstSubprotocol(" , a")).toBeUndefined();
    expect(firstSubprotocol("a b")).toBeUndefined();
    expect(firstSubprotocol("a\"b")).toBeUndefined();
  });
});
