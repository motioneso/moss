import { isUuid } from "@moss/db";
import { scopedJobDatabase, sendJob, type PgBoss, type QueueDefinition } from "@moss/jobs";
import {
  RecordingImportService,
  type RecordingImportDependencies,
  type RecordingImportPayload
} from "./recording-import-service.js";
export const RECORDING_IMPORT_QUEUE = "meetings.recording-import";
export const RECORDING_IMPORT_QUEUES: readonly QueueDefinition[] = [
  {
    name: RECORDING_IMPORT_QUEUE,
    options: {
      retryLimit: 4,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 120,
      deleteAfterSeconds: 3600,

      // Accepted imports have no other trigger, so queued work must outlast a long outage.
      retentionSeconds: 1_209_600
    }
  }
];
export function createRecordingImportScheduler(
  boss: Pick<PgBoss, "send">
): RecordingImportDependencies["schedule"] {
  return async (db, payload, delaySeconds = 0) => {
    const id = await sendJob(boss, RECORDING_IMPORT_QUEUE, payload, {
      db: scopedJobDatabase(db),
      startAfter: delaySeconds
    });
    if (!id) throw new Error("Recording import scheduling unavailable");
  };
}
export async function registerRecordingImportWorker(
  boss: PgBoss,
  deps: RecordingImportDependencies
): Promise<string[]> {
  const service = new RecordingImportService(deps);
  const id = await boss.work<RecordingImportPayload>(
    RECORDING_IMPORT_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (
        !job ||
        !job.data ||
        Object.keys(job.data).length !== 3 ||
        !isUuid(job.data.actorUserId) ||
        !isUuid(job.data.resourceId) ||
        !["transcribe", "abandoned", "purge"].includes(job.data.kind)
      )
        throw new Error("Invalid recording import metadata");
      await service.process({ actorUserId: job.data.actorUserId, requestId: job.id }, job.data);
    }
  );
  return [id];
}
