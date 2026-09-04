import { sendJob, type ActorScopedJobPayload, type PgBoss } from "@moss/jobs";

import type { PushQueuePort } from "./repository.js";

export const PUSH_DELIVER_QUEUE = "notifications.push.deliver";
export const PUSH_SUMMARY_QUEUE = "notifications.push.summary";

export interface PushDeliverJobPayload extends ActorScopedJobPayload {
  readonly notificationId: string;
  readonly recipientUserId: string;
}

export interface PushSummaryJobPayload extends ActorScopedJobPayload {
  readonly recipientUserId: string;
  readonly releaseAt: string;
}

/**
 * Real `PushQueuePort` implementation, enqueuing metadata-only jobs. The recipient's id
 * doubles as `actorUserId` so the worker's data context (`toAccessContext`) scopes to the
 * recipient, not whichever actor's write triggered the notification.
 */
export function createPushQueuePort(boss: PgBoss): PushQueuePort {
  return {
    async enqueueDeliver(notificationId: string, recipientUserId: string): Promise<void> {
      await sendJob<PushDeliverJobPayload>(boss, PUSH_DELIVER_QUEUE, {
        actorUserId: recipientUserId,
        notificationId,
        recipientUserId
      });
    },

    async enqueueSummary(recipientUserId: string, releaseAt: Date): Promise<void> {
      const releaseAtIso = releaseAt.toISOString();
      await sendJob<PushSummaryJobPayload>(
        boss,
        PUSH_SUMMARY_QUEUE,
        {
          actorUserId: recipientUserId,
          recipientUserId,
          releaseAt: releaseAtIso
        },
        {
          singletonKey: `${recipientUserId}:${releaseAtIso}`,
          startAfter: releaseAt
        }
      );
    }
  };
}
