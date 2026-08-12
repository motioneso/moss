/**
 * #1554 Decision 3 — idle-reap timer ownership.
 *
 * `PersistentRuntimePool` does not own its own `setInterval` (`persistent-runtime-pool.ts`);
 * `sweepIdle(idleThresholdMs)` is a public method, and the process composition root that
 * constructs the pool owns exactly ONE timer that drives it — `engine-host.ts` for the RPC/
 * cli-runner topology, `runtime.ts` for the in-process topology (plan
 * `docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`, Decision 3, lines 210-228).
 *
 * The idle THRESHOLD is read fresh via `readIdleReapMinutes` on EVERY tick — never snapshotted at
 * timer construction — mirroring `chat-multiplexer.ts`'s `createPersistentRuntimeEnabledLiveReader`
 * live-config pattern (re-read every call, not a boot-time close-over). The tick INTERVAL is a
 * coarser, fixed-for-the-timer's-lifetime cadence (recommended `min(idleThresholdMs / 6, 5 min)`,
 * plan line 215) derived once from `defaultIdleReapMinutes` (the settings registry default, 30) —
 * this only affects how promptly a *changed* threshold is noticed, never correctness, since the
 * threshold actually swept on each tick is always whatever the live read returns THAT tick.
 *
 * Mechanics mirror `CliRunnerServer`'s login-reaper (`packages/cli-runner/src/server.ts`): a
 * nullable timer handle, `unref()` so it never keeps the process alive, an in-flight guard so a
 * slow tick can never stack a second sweep on top of one still running, and a swallow-and-report
 * (`onError`) around each tick so one bad read/sweep never kills the timer — the next tick is the
 * backstop.
 */

export interface SweepIdlePool {
  sweepIdle(idleThresholdMs: number): Promise<void>;
}

export interface IdleReapTimerDeps {
  /** The pool to sweep (or a fake in tests) — only `sweepIdle` is used. */
  readonly pool: SweepIdlePool;
  /** Live read of `chat.persistent_idle_reap_minutes` — called fresh on EVERY tick, never cached. */
  readonly readIdleReapMinutes: () => Promise<number>;
  /** Override the tick cadence (tests / explicit tuning). Defaults to
   *  `min(defaultIdleReapMinutes * 60_000 / 6, 5 * 60_000)`. */
  readonly intervalMs?: number;
  /** Fallback used only to derive the default tick cadence above (registry default is 30). */
  readonly defaultIdleReapMinutes?: number;
  /** Reports a rejected `readIdleReapMinutes`/`sweepIdle` on some tick; the timer keeps running. */
  readonly onError?: (err: unknown) => void;
}

const FIVE_MINUTES_MS = 5 * 60_000;
const DEFAULT_IDLE_REAP_MINUTES = 30;

/** `min(defaultIdleReapMinutes / 6, 5 min)`, in ms — plan line 215's recommended tick cadence. */
export function computeIdleReapIntervalMs(defaultIdleReapMinutes: number): number {
  return Math.min((defaultIdleReapMinutes * 60_000) / 6, FIVE_MINUTES_MS);
}

/**
 * Starts the idle-reap timer. Returns a stop function (idempotent, safe to call more than once).
 * Never throws synchronously — a rejecting `readIdleReapMinutes`/`sweepIdle` on some tick is caught
 * and reported via `onError`, not propagated.
 */
export function startIdleReapTimer(deps: IdleReapTimerDeps): () => void {
  const intervalMs =
    deps.intervalMs ??
    computeIdleReapIntervalMs(deps.defaultIdleReapMinutes ?? DEFAULT_IDLE_REAP_MINUTES);

  let inFlight = false;
  const handle: ReturnType<typeof setInterval> = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      const minutes = await deps.readIdleReapMinutes();
      const idleThresholdMs = Math.max(0, minutes) * 60_000;
      await deps.pool.sweepIdle(idleThresholdMs);
    })()
      .catch((err: unknown) => deps.onError?.(err))
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  };
}
