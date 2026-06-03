import * as http from "http";
import type { CaptureStore, HttpCapture } from "./store";
import { INSPECTOR_HTML } from "./ui";

/** Local web UI (ngrok-style) that streams captured tunnel requests and can replay them. */
export class InspectorServer {
  private server: http.Server | null = null;
  private readonly clients = new Set<http.ServerResponse>();

  constructor(
    private readonly store: CaptureStore,
    private readonly local: { host: string; port: number },
  ) {
    this.store.on("capture", (c: HttpCapture) => {
      const data = `data: ${JSON.stringify(c)}\n\n`;
      for (const res of this.clients) {
        try { res.write(data); } catch { /* client gone */ }
      }
    });
  }

  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch(() => {
          try { res.writeHead(500); res.end(); } catch { /* ignore */ }
        });
      });
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  stop(): void {
    for (const c of this.clients) { try { c.end(); } catch { /* ignore */ } }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(INSPECTOR_HTML);
      return;
    }
    if (url.pathname === "/captures") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.store.list()));
      return;
    }
    if (url.pathname === "/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("\n");
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      return;
    }
    if (url.pathname.startsWith("/replay/") && req.method === "POST") {
      const id = url.pathname.slice("/replay/".length);
      const cap = this.store.get(id);
      if (!cap) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const result = await this.replay(cap);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  }

  private async replay(cap: HttpCapture): Promise<{ status: number; statusText: string }> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(cap.reqHeaders ?? {})) {
      if (!["host", "content-length", "connection"].includes(k.toLowerCase())) headers[k] = v;
    }
    const body = cap.reqBodyB64 ? Buffer.from(cap.reqBodyB64, "base64") : undefined;
    const resp = await fetch(`http://${this.local.host}:${this.local.port}${cap.path}`, {
      method: cap.method,
      headers,
      body: cap.method !== "GET" && cap.method !== "HEAD" ? body : undefined,
      redirect: "manual",
    });
    return { status: resp.status, statusText: resp.statusText };
  }
}
