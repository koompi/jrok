/**
 * Draining an edge before taking it away (plan: worker edge discovery).
 *
 *   touch /etc/jrok/drain      (JROK_DRAIN_FILE)   take this edge out
 *   rm /etc/jrok/drain                             put it back
 *
 * The other edges' health-checked DNS then treats this edge as down, and
 * takes it out of every record it keeps. That includes the edge list workers
 * read (jrok-edges.<domain>), so visitors stop arriving and workers move
 * their agents away, while jrok here keeps serving whoever still comes. Only
 * the DNS checkers act on it: /health stays 200, with DRAIN_HEADER, so deploys
 * and nginx are unaffected. The last healthy edge is never taken out (DNS
 * records are never emptied).
 */
import { existsSync } from "fs";

export const DRAIN_HEADER = "X-Jrok-Draining";

export function drainFile(): string {
  return process.env.JROK_DRAIN_FILE || "/etc/jrok/drain";
}

export function isDraining(file = drainFile()): boolean {
  return existsSync(file);
}
