/**
 * A started model call (#2984 R2.5b, spec 8.4).
 *
 * Before a sorting or preparation call goes out, each tool it covers is stored as failed with
 * reason `interrupted`, in its own committed transaction under the connection's row lock. The
 * call's result replaces that mark. A call that is cut off, or whose result cannot be saved,
 * leaves the mark, so only the owner's Try again sends the tool again.
 *
 * While the mark is younger than the job's expiry the call may still be running: no other run
 * sends the tool, and the page shows it as waiting. After that it reads as an ordinary failure.
 */

/** How long a job may run. A started call older than this has stopped. */
export const CLASSIFIER_ATTEMPT_LIVE_MS = 30 * 60_000;

/** True while a call marked at `startedAt` may still be running. */
export function attemptLive(startedAt: string, now: Date): boolean {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && now.getTime() - started < CLASSIFIER_ATTEMPT_LIVE_MS;
}
