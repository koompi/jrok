/**
 * WebSocket subprotocols (P32): graphql-ws (`graphql-transport-ws`), Apollo's
 * older `graphql-ws`, STOMP, MQTT over WebSocket and others.
 *
 * jrok answers a visitor's handshake itself, before the app is reached, so it
 * can't ask the app which of the offered protocols it wants. Bun's upgrade()
 * answers with the visitor's first choice by itself (setting the header as
 * well sends it twice, which browsers refuse), so jrok passes only that one
 * on, to the peer edge and to the agent, which offers it to the app. Before,
 * the protocol was lost crossing edges and agents mishandled it, so apps that
 * need one got no connection.
 */

/** RFC 6455 subprotocols are HTTP tokens. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** The first protocol in a Sec-WebSocket-Protocol header, if it is a valid one. */
export function firstSubprotocol(header: string | null | undefined): string | undefined {
  const first = header?.split(",")[0]?.trim();
  return first && TOKEN.test(first) ? first : undefined;
}
