// Two WebSocket apps for the subprotocol checks (P32), on the test droplet:
//   systemd-run --unit wsp-app node ws-protocol-app.cjs
// then an agent each (connector and Node CLI) for 18083 and 18084, and
// ws-protocol-client.cjs through each edge. Needs the CLI's node_modules (ws).
//  18083 insists on one, like graphql-ws: selects graphql-transport-ws when
//        offered, closes 4406 otherwise;
//  18084 ignores subprotocols (answers with none), like many servers.
// Each first says what it got, then echoes.
const { WebSocketServer } = require(process.env.WS_MODULE || "/root/jrok/cli/node_modules/ws");
const serve = (port, handleProtocols, strict) => {
  const wss = new WebSocketServer({ port, host: "127.0.0.1", handleProtocols });
  wss.on("connection", (ws, req) => {
    if (strict && ws.protocol !== "graphql-transport-ws") return ws.close(4406, "Subprotocol not acceptable");
    ws.send(`app${port} got protocol=${ws.protocol || "-"} offered=${req.headers["sec-websocket-protocol"] || "-"} cookie=${req.headers.cookie || "-"}`);
    ws.on("message", (m, bin) => ws.send(bin ? m : `echo ${m}`));
  });
};
serve(18083, (p) => (p.has("graphql-transport-ws") ? "graphql-transport-ws" : false), true);
serve(18084, () => false, false);
console.log("ws-proto apps on 18083 (requires) and 18084 (ignores)");
