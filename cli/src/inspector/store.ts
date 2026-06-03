import { EventEmitter } from "events";

/** A captured tunneled HTTP request/response pair, for the local inspector. */
export interface HttpCapture {
  id: string;
  time: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  reqHeaders?: Record<string, string>;
  reqBodyB64?: string;
  resHeaders?: Record<string, string>;
  resBodyB64?: string;
}

/** In-memory ring buffer of recent captures with a live event stream. */
export class CaptureStore extends EventEmitter {
  private readonly items: HttpCapture[] = [];
  constructor(private readonly max = 200) {
    super();
  }

  add(capture: HttpCapture): void {
    this.items.push(capture);
    while (this.items.length > this.max) this.items.shift();
    this.emit("capture", capture);
  }

  list(): HttpCapture[] {
    return [...this.items].reverse();
  }

  get(id: string): HttpCapture | undefined {
    return this.items.find((c) => c.id === id);
  }
}
