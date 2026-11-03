/**
 * Stopping jrok.
 *
 * systemd stops it with SIGTERM: every rolling deploy and restart. jrok used to
 * handle only SIGINT (Ctrl-C), so SIGTERM killed it at once and the usage
 * counted since the last flush (up to 30 s of every tenant's traffic) was
 * lost. Both signals now write it first, for at most `flushTimeoutMs`, so a
 * hung MongoDB can't hold up a deploy.
 *
 * Only SIGINT also tells the other edges this one is gone and frees its TCP
 * ports. An edge that restarts keeps them: marked gone (lastHeartbeat 0), every
 * TCP tunnel whose agent reconnected to another edge meanwhile would move there
 * at once, with a new address (tcpService.serverGoneFor).
 */
export interface ShutdownSteps {
  /** Write what is counted in memory (usage). */
  flush: () => Promise<void>;
  /** Stop timers and services; nothing that waits on MongoDB for long. */
  stop: () => void;
  /** Tell the other edges this one is gone, free its TCP ports (SIGINT only). */
  leave: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  exit: (code: number) => void;
  flushTimeoutMs?: number;
  log?: (message: string) => void;
}

export type StopSignal = "SIGINT" | "SIGTERM";

/** The handler for both signals; a second signal while stopping is ignored. */
export function shutdownHandler(steps: ShutdownSteps): (signal: StopSignal) => Promise<void> {
  let stopping = false;
  const log = steps.log ?? console.log;
  return async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`🛑 Shutting down (${signal})...`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const written = await Promise.race([
      steps.flush().then(() => true, (error: any) => {
        log(`⚠️ Usage not written before stopping: ${error?.message || error}`);
        return false;
      }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          log(`⚠️ Usage not written within ${(steps.flushTimeoutMs ?? 5_000) / 1000} s; stopping anyway`);
          resolve(false);
        }, steps.flushTimeoutMs ?? 5_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (written) log("✅ Usage written");

    try {
      steps.stop();
      if (signal === "SIGINT") await steps.leave();
    } catch (error: any) {
      log(`⚠️ ${error?.message || error}`);
    }
    await steps.closeDatabase().catch(() => {});
    steps.exit(0);
  };
}
