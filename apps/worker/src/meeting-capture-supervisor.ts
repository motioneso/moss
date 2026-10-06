import type { PgBoss } from "@moss/jobs";
import { MEETING_CAPTURE_MAINTENANCE_QUEUE } from "@moss/meetings";

export const CAPTURE_SUPERVISE_INTERVAL_MS = 1000;

/** Only the worker calls this; the same boss keeps its ordinary global supervision cadence. */
export function startMeetingCaptureSupervision(
  boss: Pick<PgBoss, "supervise">,
  onError: (error: Error) => void
): { close(): Promise<void> } {
  let pending: Promise<void> | undefined;
  let stopped = false;
  const check = () => {
    if (stopped || pending) return;
    // The public name filter reaches getQueues(name) and timeout SQL's name=ANY(names).
    pending = boss
      .supervise(MEETING_CAPTURE_MAINTENANCE_QUEUE)
      .catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error))))
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(check, CAPTURE_SUPERVISE_INTERVAL_MS);
  timer.unref();
  check();
  return {
    async close() {
      stopped = true;
      clearInterval(timer);
      await pending;
    }
  };
}
