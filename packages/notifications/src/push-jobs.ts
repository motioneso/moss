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

/**
 * Retry policy for both push queues (#743 security finding 8): four attempts in all, thirty
 * seconds apart with exponential backoff, so a brief push-service outage or throttling does
 * not lose the notification. Mirrors the AI job queues. Structural (no pg-boss import) for
 * the same package-cycle reason as the payloads above.
 */
export const PUSH_QUEUE_RETRY_OPTIONS = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true
} as const;

/**
 * Work options for both push workers. `includeMetadata` gives the handler the job's
 * `retryCount` and `retryLimit`, which is how it knows whether an attempt is the last one.
 */
export const PUSH_WORK_OPTIONS = {
  pollingIntervalSeconds: 2,
  includeMetadata: true
} as const;
