// Like a browser: offer PROTOCOLS (comma-separated, "-" for none), send a
// cookie, through one edge. OK when the app answered and echoed (P32).
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node ws-protocol-client.cjs DOMAIN EDGE_IP PROTOCOLS
const WebSocket = require(process.env.WS_MODULE || "/root/jrok/cli/node_modules/ws");
const [domain, edge, protocols] = process.argv.slice(2);
const offer = protocols && protocols !== "-" ? protocols.split(",") : [];
const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: edge, family: 4 }]) : cb(null, edge, 4));
const ws = new WebSocket(`wss://${domain}.jrok-staging.koompi.cloud/`, offer, { lookup, headers: { cookie: "session=abc" } });
const seen = [];
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
const done = (why) => { console.log(`${pad(domain, 6)} via ${pad(edge, 14)} offer ${pad(protocols || "-", 34)} ${pad(why, 40)} browser got=${ws.protocol || "-"} | ${seen.join(" | ")}`); process.exit(0); };
ws.on("open", () => ws.send("hello"));
ws.on("message", (m) => { seen.push(String(m)); if (seen.length === 2) { ws.close(); done("OK"); } });
ws.on("close", (code, reason) => done(`closed ${code} ${reason}`));
ws.on("error", (e) => done(`error: ${e.message}`));
setTimeout(() => done("timeout"), 10000);
