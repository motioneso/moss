/**
 * Hard ceiling on one briefing run. The run holds its database transaction (and any row locks)
 * open while it composes, so a step that waits forever on a model runner would otherwise hold
 * them until pg-boss fails the job. Throwing here makes the surrounding transaction roll back.
 */
export const BRIEFING_RUN_DEADLINE_MS = 6 * 60_000;

/** The only text recorded for a timeout. It carries no prompt or briefing content. */
export const BRIEFING_RUN_DEADLINE_LABEL = "briefing_run_timeout";

export class BriefingRunDeadlineError extends Error {
  constructor() {
    super(BRIEFING_RUN_DEADLINE_LABEL);
    this.name = "BriefingRunDeadlineError";
  }
}

export async function withRunDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number = BRIEFING_RUN_DEADLINE_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const pending = work();
  // After the deadline the work may still settle; its late failure must not go unhandled.
  pending.catch(() => undefined);
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BriefingRunDeadlineError()), deadlineMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
