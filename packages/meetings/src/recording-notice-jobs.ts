import { isUuid, type AccessContext, type DataContextDb } from "@moss/db";
import {
  notifyJobQueue,
  scopedJobDatabase,
  sendJob,
  type PgBoss,
  type QueueDefinition
} from "@moss/jobs";

export const RECORDING_NOTICE_QUEUE = "meetings.recording-notice";
export const RECORDING_NOTICE_QUEUES: readonly QueueDefinition[] = [
  {
    name: RECORDING_NOTICE_QUEUE,
    options: {
      retryLimit: 8,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 120,
      deleteAfterSeconds: 3600,
      retentionSeconds: 1_209_600
    }
  }
];
export interface RecordingNoticePayload {
  readonly actorUserId: string;
  readonly resourceId: string;
  readonly sourceVersion: string;
  readonly idempotencyKey: string;
}
export type RecordingNoticeEnqueue = (
  db: DataContextDb,
  payload: RecordingNoticePayload
) => Promise<void>;

/** Called inside output publication: output and its notice intent commit together. */
export function createRecordingNoticeEnqueue(boss: Pick<PgBoss, "send">): RecordingNoticeEnqueue {
  return async (db, payload) => {
    const id = await sendJob(boss, RECORDING_NOTICE_QUEUE, payload, {
      db: scopedJobDatabase(db),
      singletonKey: `${payload.resourceId}:${payload.sourceVersion}`
    });
    if (!id) throw new Error("Recording notice scheduling unavailable");
    await notifyJobQueue(db, RECORDING_NOTICE_QUEUE);
  };
}

export async function registerRecordingNoticeWorker(
  boss: PgBoss,
  publish: (
    access: AccessContext,
    meetingId: string,
    sourceVersion: string
  ) => Promise<{ readonly state: string }>
): Promise<string[]> {
  const id = await boss.work<RecordingNoticePayload>(
    RECORDING_NOTICE_QUEUE,
    { pollingIntervalSeconds: 0.5 },
    async ([job]) => {
      if (
        !job?.data ||
        Object.keys(job.data).some(
          (key) => !["actorUserId", "resourceId", "sourceVersion", "idempotencyKey"].includes(key)
        ) ||
        ![job.data.actorUserId, job.data.resourceId, job.data.idempotencyKey].every(isUuid) ||
        typeof job.data.sourceVersion !== "string" ||
        !/^[1-9]\d{0,9}:[a-f0-9]{64}$/.test(job.data.sourceVersion)
      )
        throw new Error("Invalid recording notice metadata");
      const result = await publish(
        { actorUserId: job.data.actorUserId, requestId: job.id },
        job.data.resourceId,
        job.data.sourceVersion
      );
      if (result.state === "no_main") throw new Error("Recording notice awaits Main");
    }
  );
  return [id];
}
