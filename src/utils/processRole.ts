/**
 * Several jrok processes on one edge (Ansible `jrok_processes`).
 *
 * Each process is its own jrok server (VPS_ID vps-sgp2, vps-sgp2-p1, ...) with
 * its own agents; nginx sends an app's visitors and its agent to the same
 * process by hashing the app's name. Processes of one edge share JROK_EDGE_ID
 * and reach each other over 127.0.0.1. Edge-wide chores (TCP ports, certificate
 * files, nginx vhosts, daily aggregates) run in process 0 only.
 *
 *   JROK_EDGE_ID        the edge's id (default VPS_ID: one process per edge)
 *   JROK_PROCESS_INDEX  0..n-1 (default 0)
 */
export function edgeId(): string {
  return (process.env.JROK_EDGE_ID || process.env.VPS_ID || process.env.HOSTNAME || "default").trim();
}

export function processIndex(): number {
  const n = Number((process.env.JROK_PROCESS_INDEX || "0").trim());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** True in the process that owns the edge's shared state. */
export function isPrimaryProcess(): boolean {
  return processIndex() === 0;
}

/** The header naming which process of the receiving edge a forwarded request is for. */
export const TARGET_SERVER_HEADER = "X-Jrok-Target-Server";
