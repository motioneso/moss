import { isUuid, type DataContextRunner } from "@moss/db";
import { scopedJobDatabase, sendJob, type PgBoss, type QueueDefinition } from "@moss/jobs";
import { MeetingOutputService, type MeetingOutputGenerator } from "./output-service.js";
import {
  MeetingStopSummaryRepository,
  type MeetingStopSummaryPayload
} from "./stop-summary-repository.js";
export const MEETING_STOP_SUMMARY_QUEUE = "meetings.stop-summary";
export const MEETING_STOP_SUMMARY_QUEUES: readonly QueueDefinition[] = [
  {
    name: MEETING_STOP_SUMMARY_QUEUE,
    options: {
      retryLimit: 3,
      retryDelay: 60,
      expireInSeconds: 180,
      deleteAfterSeconds: 3600,
      retentionSeconds: 3600
    }
  }
];
export function createMeetingStopSummaryScheduler(boss: PgBoss) {
  const repository = new MeetingStopSummaryRepository();
  return (
    db: Parameters<MeetingStopSummaryRepository["schedule"]>[0],
    actor: Parameters<MeetingStopSummaryRepository["schedule"]>[1],
    input: Parameters<MeetingStopSummaryRepository["schedule"]>[2]
  ) =>
    repository.schedule(db, actor, input, async (transaction, payload, at, early) => {
      await sendJob(boss, MEETING_STOP_SUMMARY_QUEUE, payload, {
        db: scopedJobDatabase(transaction),
        startAfter: at,
        singletonKey: `${payload.idempotencyKey}:${early ? "finalized" : "stop"}`
      });
    });
}
export async function registerMeetingStopSummaryWorker(
  boss: PgBoss,
  dataContext: DataContextRunner,
  generator: MeetingOutputGenerator
): Promise<string[]> {
  const service = new MeetingOutputService(dataContext, generator);
  const id = await boss.work<MeetingStopSummaryPayload>(
    MEETING_STOP_SUMMARY_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (
        !job ||
        Object.keys(job.data).some(
          (key) => !["actorUserId", "resourceId", "idempotencyKey"].includes(key)
        ) ||
        ![job.data.actorUserId, job.data.resourceId, job.data.idempotencyKey].every(isUuid)
      )
        throw new Error("Invalid automatic meeting summary metadata");
      const result = await service.generateOnStop(
        { actorUserId: job.data.actorUserId, requestId: job.id },
        job.data.resourceId,
        job.data.idempotencyKey
      );
      if (result?.status === "pending")
        throw new Error("Automatic meeting summary remains pending");
    }
  );
  return [id];
}
