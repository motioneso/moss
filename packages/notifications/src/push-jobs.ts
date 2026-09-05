export const PUSH_DELIVER_QUEUE = "notifications.push.deliver";
export const PUSH_SUMMARY_QUEUE = "notifications.push.summary";

/**
 * Metadata-only job payloads for push delivery. `actorUserId` mirrors `@moss/jobs`'s
 * `ActorScopedJobPayload` structurally rather than extending it: `@moss/jobs` already depends
 * on this package (upgrade-notify), so importing it here would form a package cycle
 * (check:package-deps, #802/#834). The recipient's id doubles as `actorUserId` so the
 * worker's data context scopes to the recipient, not whichever actor's write triggered the
 * notification.
 *
 * The real `PushQueuePort` implementation (`createPushQueuePort`) lives in `@moss/jobs`.
 */
export interface PushDeliverJobPayload {
  readonly actorUserId: string;
  readonly notificationId: string;
  readonly recipientUserId: string;
}

export interface PushSummaryJobPayload {
  readonly actorUserId: string;
  readonly recipientUserId: string;
  readonly releaseAt: string;
}
