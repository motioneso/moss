// Process lifecycle for the api entrypoint: graceful shutdown on signal and the crash handler.

/**
 * Graceful-shutdown helper for the api entrypoint (deployable-stack §9). On
 * SIGTERM/SIGINT we call server.close() — which runs the onClose hook tearing
 * down boss/auth/db — then exit 0, racing a bounded timeout so a hung close
 * still exits cleanly. Mirrors the worker's signal path (worker.ts:151-157).
 *
 * Exported (and parameterized with exit/timeout) so it is unit-testable without
 * spawning the real binary or sending a real signal.
 */
export async function shutdownOnSignal(
  server: { close(cb: (err?: Error) => void): void },
  opts: { timeoutMs?: number; exit?: (code: number) => never } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  await Promise.race([
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    })
  ]);
  exit(0);
}

/**
 * Crash-handler factory for the api entrypoint (spec §1140-E, #1527). Both
 * `unhandledRejection` and `uncaughtException` share the closure-local
 * `crashing` latch below: the first crash notification logs, races a bounded
 * shutdown, and exits; any later notification in the same window is a no-op,
 * so a second error can never re-log, re-close, or re-exit.
 *
 * Exported (and parameterized with timeout/exit) so it is unit-testable
 * without spawning the real binary or racing a second real crash.
 */
export function createCrashHandler(
  server: {
    log: { error(obj: Record<string, unknown>, msg: string): void };
    close(cb: (err?: Error) => void): void;
  },
  opts: { timeoutMs?: number; exit?: (code: number) => never } = {}
): (label: string, err: unknown) => void {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let crashing = false;
  return (label: string, err: unknown): void => {
    if (crashing) return;
    crashing = true;
    server.log.error({ err, label }, "Process crash — exiting");
    const drain = Promise.race([
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      })
    ]);
    void drain.then(() => {
      exit(1);
    });
  };
}
