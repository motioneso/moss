import type { PgBoss } from "pg-boss";
import type { DataContextRunner } from "@moss/db";
import { toAccessContext, type DataContextJob } from "@moss/jobs";
import {
  PUSH_DELIVER_QUEUE,
  PUSH_SUMMARY_QUEUE,
  PUSH_WORK_OPTIONS,
  runPushDeliverJob,
  runPushSummaryJob,
  throwIfPushRetryNeeded,
  type PushDeliverJobPayload,
  type PushDeliveryOutcome,
  type PushSummaryJobPayload,
  type PushWorkerDependencies
} from "@moss/notifications";

/** Push owns its short transactions; wrapping the entire job would retain lifecycle locks. */
export async function registerPushWorkers(
  boss: PgBoss,
  dataContext: DataContextRunner,
  deps: PushWorkerDependencies
): Promise<string[]> {
  return [
    await boss.work<PushDeliverJobPayload, PushDeliveryOutcome>(
      PUSH_DELIVER_QUEUE,
      PUSH_WORK_OPTIONS,
      async ([job]) => {
        if (!job) throw new Error("Missing push delivery job");
        toAccessContext(job);
        const outcome = await runPushDeliverJob(
          job as DataContextJob<PushDeliverJobPayload>,
          dataContext,
          deps
        );
        throwIfPushRetryNeeded(outcome);
        return outcome;
      }
    ),
    await boss.work<PushSummaryJobPayload, PushDeliveryOutcome>(
      PUSH_SUMMARY_QUEUE,
      PUSH_WORK_OPTIONS,
      async ([job]) => {
        if (!job) throw new Error("Missing push summary job");
        toAccessContext(job);
        const outcome = await runPushSummaryJob(
          job as DataContextJob<PushSummaryJobPayload>,
          dataContext,
          deps
        );
        throwIfPushRetryNeeded(outcome);
        return outcome;
      }
    )
  ];
}
