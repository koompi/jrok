# Agent tunnel: binary frames and compression

Plan steps 0.5.2 and 0.5.3 ([scale-out plan](../plans/jrok-scale-out-plan.md)). The Phase 5 connector implements the same rules.

## Negotiation

The agent lists what it supports in the `caps` query parameter of its WebSocket URL. The server lists what it supports in `features` in its `welcome` message. An agent uses a feature only when the server's welcome lists it, and checks again after every reconnect, because a reconnect can land on an older server. Old agents never see a new feature, and old servers never advertise one, so either side can be upgraded first.

| Feature | Meaning |
|---|---|
| `stream` | Responses go as `http_response_start`, then body chunks, then `http_response_end` (JSON text frames). |
| `b64body` | Request bodies are base64 (`bodyIsBase64`). |
| `binchunk` | Body chunks may be binary frames (below) instead of `http_response_chunk` JSON with base64 `data`. |
| — | `"streamed": true` in `http_response_start` means the app sent no `Content-Length` (it produces the body as it goes). The server then adds `X-Accel-Buffering: no`, so nginx passes chunks on as they arrive. Servers that don't know the flag ignore it. |
| `gzip` | The agent may gzip a response itself. It says so with `"encoding": "gzip"` in `http_response_start`; the server then keeps `Content-Encoding: gzip` and passes the bytes through. Without the flag the server drops `Content-Encoding`, because the agent's `fetch` already decoded whatever the app sent. |
| `tcp_pushback` | The server pauses a TCP customer's socket while the agent's link is backed up (more than 8 MB waiting). An agent may then stop reading its link to slow a customer down, as the connector does while a local service isn't reading. Without the feature, an agent must keep reading: the server goes on sending, and Bun drops what it can't buffer (past 16 MB), leaving a hole in the customer's stream. |

## Binary frame, version 1

One WebSocket binary message:

| Bytes | Content |
|---|---|
| 0 | Frame kind. `0x01` = HTTP response body chunk. Other values are reserved; a receiver ignores kinds it doesn't know. |
| 1 | Length `N` of the request id, 1–255. |
| 2 … 2+N−1 | The request id, UTF-8. |
| 2+N … end | The chunk's bytes, unencoded. May be empty. |

Text frames (JSON) and binary frames share one WebSocket, so their order is preserved: `http_response_start`, any number of chunks of either kind, then `http_response_end`.

Cost removed (measured 2026-10-30): base64 + JSON added 33–42% to the bytes on the worker→edge link and cost the Node agent about 400–670 MB/s per core.

## Compression in the tunnel

The agent gzips a response when all of these hold:

- the server advertises `gzip`, and the agent's `JROK_TUNNEL_GZIP` isn't `false`;
- the visitor's `Accept-Encoding` includes `gzip`;
- the method isn't `HEAD`, and the status isn't 204 or 304;
- the content type is text that compresses: `text/*` except `text/event-stream`, JSON, JavaScript, XML, SVG and similar;
- the response doesn't say `Cache-Control: no-transform`;
- the body isn't known to be under 1 KB.

It flushes after every chunk, so streamed HTML still arrives as it is produced. It sets `Content-Encoding: gzip`, adds `Accept-Encoding` to `Vary` and drops `Content-Length`. nginx doesn't compress a response that already has `Content-Encoding`, and the edge cache stores one copy per `Accept-Encoding` (because of `Vary`).

Bandwidth jrok counts for a compressed response is the compressed size, which is what crossed the tunnel.
