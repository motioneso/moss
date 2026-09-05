import {
  PUSH_DELIVER_QUEUE,
  PUSH_SUMMARY_QUEUE,
  type PushDeliverJobPayload,
  type PushQueuePort,
  type PushSummaryJobPayload
} from "@moss/notifications";

import { sendJob, type PgBoss } from "./pg-boss.js";

/**
 * Real `PushQueuePort` implementation, enqueuing metadata-only jobs. Lives here rather than
 * in `@moss/notifications` because this package already depends on notifications
 * (upgrade-notify); the reverse import would form a package cycle. The recipient's id doubles
 * as `actorUserId` so the worker's data context (`toAccessContext`) scopes to the recipient,
 * not whichever actor's write triggered the notification.
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
