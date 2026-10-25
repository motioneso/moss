import { isUuid } from "@moss/db";
import {
  notifyJobQueue,
  scopedJobDatabase,
  sendJob,
  type PgBoss,
  type QueueDefinition
} from "@moss/jobs";
import type { VoiceRequestDependencies, VoiceRequestService } from "./voice-request-service.js";

export const CHAT_VOICE_REQUEST_QUEUE = "chat.voice-request";
export const CHAT_VOICE_REQUEST_QUEUE_DEFINITION: QueueDefinition = {
  name: CHAT_VOICE_REQUEST_QUEUE,
  options: {
    retryLimit: 20_160,
    retryDelay: 60,
    retryBackoff: false,
    expireInSeconds: 900,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 3600
  }
};

interface VoiceRequestPayload {
  readonly actorUserId: string;
  readonly resourceId: string;
}

export function createVoiceRequestScheduler(
  boss: Pick<PgBoss, "send">
): VoiceRequestDependencies["schedule"] {
  return async (db, actor, id, delaySeconds = 0) => {
    const jobId = await sendJob(
      boss,
      CHAT_VOICE_REQUEST_QUEUE,
      { actorUserId: actor.actorUserId, resourceId: id } satisfies VoiceRequestPayload,
      { db: scopedJobDatabase(db), startAfter: delaySeconds }
    );
    if (!jobId) throw new Error("Voice request scheduling unavailable");
    if (delaySeconds === 0) await notifyJobQueue(db, CHAT_VOICE_REQUEST_QUEUE);
  };
}

/** Must run in the API process that owns the ordinary drawer manager. */
export async function registerVoiceRequestWorker(
  boss: PgBoss,
  service: Pick<VoiceRequestService, "process">
) {
  return boss.work<VoiceRequestPayload>(
    CHAT_VOICE_REQUEST_QUEUE,
    { pollingIntervalSeconds: 0.5 },
    async ([job]) => {
      if (
        !job?.data ||
        Object.keys(job.data).length !== 2 ||
        !isUuid(job.data.actorUserId) ||
        !isUuid(job.data.resourceId)
      )
        throw new Error("Invalid voice request metadata");
      await service.process(
        { actorUserId: job.data.actorUserId, requestId: job.id },
        job.data.resourceId
      );
    }
  );
}
