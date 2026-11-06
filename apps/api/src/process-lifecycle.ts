// Process lifecycle for the api entrypoint: graceful shutdown on signal and the crash handler.

import {
  LOG_DROP_COUNTER,
  sanitizeLogValue,
  writeSanitizedFatal
} from "@moss/shared/log-sanitizer";

import { createFatalLineWriter, type DiagnosticLogSink } from "@moss/settings";

import { currentApiLogSink } from "./recording-logger-options.js";

type LineWriter = (line: string) => void;

type SinkSource = () => DiagnosticLogSink | null;

/** Fatal lines go to stderr and, when a sink exists, to the log table before the process exits. */
async function reportFatal(
  eventCode: "startup-failed" | "shutdown-failed",
  label: string,
  err: unknown,
  msg: string,
  opts: { log?: LineWriter; sink?: SinkSource }
): Promise<void> {
  const sink = (opts.sink ?? currentApiLogSink)();
  writeSanitizedFatal(
    label,
    err,
    createFatalLineWriter({ process: "api", eventCode, sink, stderr: opts.log }),
    msg
  );
  try {
    await sink?.close();
  } catch {
    // Draining is best effort and bounded.
  }
}

/**
 * Run the startup work and report a failure as one sanitized line, then exit 1. A rejected
 * startup would otherwise reach Node's default handler, which prints the raw error.
 */
export async function runApiStartup(
  start: () => Promise<unknown>,
  opts: { log?: LineWriter; exit?: (code: number) => never; sink?: SinkSource } = {}
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  try {
    await start();
  } catch (err) {
    await reportFatal("startup-failed", "startup", err, "API startup failed", opts);
    exit(1);
  }
}

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
  opts: {
    timeoutMs?: number;
    exit?: (code: number) => never;
    log?: LineWriter;
    sink?: SinkSource;
  } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  await Promise.race([
    new Promise<void>((resolve) => {
      server.close((err) => {
        if (!err) return resolve();
        void reportFatal("shutdown-failed", "shutdown", err, "Shutdown failed", opts).then(resolve);
      });
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
  opts: {
    timeoutMs?: number;
    exit?: (code: number) => never;
    log?: LineWriter;
    sink?: SinkSource;
  } = {}
): (label: string, err: unknown) => void {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let crashing = false;
  return (label: string, err: unknown): void => {
    if (crashing) return;
    crashing = true;
    try {
      server.log.error(
        { err: sanitizeLogValue(err), label, eventCode: "crash" },
        "Process crash — exiting"
      );
    } catch {
      // A hostile error (a throwing getter) or a failing logger drops the record. Shutdown and
      // the exit below still run, and nothing raw is written.
      LOG_DROP_COUNTER.count += 1;
    }
    // stderr gets its own copy. The logger call above already queued the table row.
    try {
      writeSanitizedFatal(
        label,
        err instanceof Error ? err : "unknown",
        // log-safe: writeSanitizedFatal masks the line before it reaches this writer
        opts.log ?? ((line: string) => void process.stderr.write(line)),
        "Process crash — exiting"
      );
    } catch {
      LOG_DROP_COUNTER.count += 1;
    }
    // The sink drains alongside server close, so stalled runtime cleanup cannot hold it back.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const work = Promise.allSettled([
      Promise.resolve().then(() => (opts.sink ?? currentApiLogSink)()?.close()),
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
    ]);
    void Promise.race([work, bound]).then(() => {
      clearTimeout(timer);
      exit(1);
    });
  };
}
