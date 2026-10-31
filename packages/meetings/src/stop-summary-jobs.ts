import type { RecordingNoticeEnqueue } from "./recording-notice-jobs.js";
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
      expireInSeconds: 660,
      deleteAfterSeconds: 3600,
      retentionSeconds: 1_209_600
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
/** Imported completion reuses automatic output receipts, with distinct import provenance. */
export function createImportedMeetingSummaryScheduler(boss: Pick<PgBoss, "send">) {
  const repository = new MeetingStopSummaryRepository();
  return (
    db: Parameters<MeetingStopSummaryRepository["scheduleImport"]>[0],
    actor: Parameters<MeetingStopSummaryRepository["scheduleImport"]>[1],
    input: Parameters<MeetingStopSummaryRepository["scheduleImport"]>[2]
  ) =>
    repository.scheduleImport(db, actor, input, async (transaction, payload, at) => {
      const id = await sendJob(boss, MEETING_STOP_SUMMARY_QUEUE, payload, {
        db: scopedJobDatabase(transaction),
        startAfter: at,
        singletonKey: payload.idempotencyKey
      });
      if (!id) throw new Error("Imported meeting analysis scheduling unavailable");
    });
}
export function createManualMeetingSummaryEnqueue(boss: Pick<PgBoss, "send">) {
  return async (
    db: Parameters<MeetingStopSummaryRepository["schedule"]>[0],
    payload: MeetingStopSummaryPayload,
    at: Date
  ) => {
    const id = await sendJob(boss, MEETING_STOP_SUMMARY_QUEUE, payload, {
      db: scopedJobDatabase(db),
      startAfter: at,
      singletonKey: payload.idempotencyKey
    });
    if (!id) throw new Error("Manual recording analysis scheduling unavailable");
  };
}
export async function registerMeetingStopSummaryWorker(
  boss: PgBoss,
  dataContext: DataContextRunner,
  generator: MeetingOutputGenerator,
  enqueueRecordingNotice?: RecordingNoticeEnqueue
): Promise<string[]> {
  const service = new MeetingOutputService(
    dataContext,
    generator,
    undefined,
    undefined,
    enqueueRecordingNotice
  );
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
      const result = await service.generateAutomatic(
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
