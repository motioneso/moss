import type { PgBoss } from "pg-boss";
import type { Kysely } from "kysely";

import type { MossDatabase } from "@moss/db";
import { FOCUS_JUDGMENT_PURGE_QUEUE, assertMetadataOnlyPayload } from "@moss/jobs";

import { FocusJudgmentRepository } from "./repository.js";

const FOCUS_JUDGMENT_PURGE_CRON = "15 3 * * *";

/** Payload carries the job kind only: the purge is the same for every person. */
export const FOCUS_JUDGMENT_PURGE_PAYLOAD = { kind: "focus-judgment-purge" } as const;

/**
 * Schedules and works the nightly 30-day purge (#2637). `workerDb` is the worker-role
 * connection; its only access to the table is EXECUTE on the no-argument purge function.
 */
export async function registerFocusJudgmentPurgeWorker(
  boss: Pick<PgBoss, "schedule" | "work">,
  workerDb: Kysely<MossDatabase>,
  repository: Pick<FocusJudgmentRepository, "purgeExpired"> = new FocusJudgmentRepository()
): Promise<string> {
  assertMetadataOnlyPayload(FOCUS_JUDGMENT_PURGE_PAYLOAD);
  await boss.schedule(
    FOCUS_JUDGMENT_PURGE_QUEUE,
    FOCUS_JUDGMENT_PURGE_CRON,
    FOCUS_JUDGMENT_PURGE_PAYLOAD,
    { tz: "UTC", key: FOCUS_JUDGMENT_PURGE_QUEUE }
  );

  return boss.work(FOCUS_JUDGMENT_PURGE_QUEUE, async () => {
    const purgedRows = await repository.purgeExpired(workerDb);
    return { purgedRows };
  });
}
