import { sql } from "kysely";
import webpush from "web-push";

import type { DataContextDb } from "@moss/db";
import { assertDataContextDb } from "@moss/db";
import type { Job } from "@moss/jobs";

import { buildPushPayload } from "./push-payload.js";
import { createPushSigningCipher, getOrGeneratePushSigningKey } from "./push-crypto.js";
import type { PushDeliverJobPayload, PushSummaryJobPayload } from "./push-jobs.js";
import {
  PushSubscriptionsRepository,
  type PushSubscription as PushSubscriptionRow
} from "./push-subscriptions-repository.js";
import { NotificationsRepository } from "./repository.js";

export interface PushWorkerDependencies {
  readonly notificationsRepository?: NotificationsRepository;
  readonly subscriptionsRepository?: PushSubscriptionsRepository;
  readonly cipher?: ReturnType<typeof createPushSigningCipher>;
  /** Test seam: real code always goes through the `web-push` library. */
  readonly sendWebPush?: typeof webpush.sendNotification;
}

interface WebPushPayload {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
}

/**
 * There is no instance public URL setting (spec 5.2). The VAPID subject only needs to be a
 * stable contact identity, not a reachable one, and it is set once on first key generation
 * and then reused from storage — this default only matters the very first time.
 */
function resolveVapidSubject(): string {
  return "mailto:push@jarv1s.local";
}

/**
 * Sends one payload to every given subscription, independently: a send failure for one
 * subscription never blocks another. 404/410 (the push service says the subscription is
 * gone) deletes that row outright; any other failure increments `failure_count`, and a
 * fifth consecutive failure disables the row instead of deleting it, so the settings page
 * can still show it (spec 5.4). A success resets the count.
 */
async function deliverToSubscriptions(
  scopedDb: DataContextDb,
  subscriptionsRepository: PushSubscriptionsRepository,
  sendWebPush: typeof webpush.sendNotification,
  subscriptions: readonly PushSubscriptionRow[],
  signingKey: { readonly subject: string; readonly publicKey: string; readonly privateKey: string },
  payload: WebPushPayload
): Promise<void> {
  const serialized = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await sendWebPush(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth }
          },
          serialized,
          { vapidDetails: signingKey }
        );
        await subscriptionsRepository.recordDeliverySuccess(scopedDb, subscription.id);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await subscriptionsRepository.delete(scopedDb, subscription.id);
        } else {
          await subscriptionsRepository.recordDeliveryFailure(scopedDb, subscription.id);
        }
      }
    })
  );
}

/**
 * Delivers one notification to every non-disabled subscription of its recipient.
 */
export async function runPushDeliverJob(
  job: Job<PushDeliverJobPayload>,
  scopedDb: DataContextDb,
  deps: PushWorkerDependencies = {}
): Promise<void> {
  assertDataContextDb(scopedDb);

  const notificationsRepository = deps.notificationsRepository ?? new NotificationsRepository();
  const subscriptionsRepository = deps.subscriptionsRepository ?? new PushSubscriptionsRepository();
  const cipher = deps.cipher ?? createPushSigningCipher();
  const sendWebPush = deps.sendWebPush ?? webpush.sendNotification;

  const notification = await notificationsRepository.getById(scopedDb, job.data.notificationId);
  if (!notification) {
    // Deleted, or not visible under the recipient's RLS context — nothing to deliver.
    return;
  }

  const subscriptions = await subscriptionsRepository.listActiveForActor(scopedDb);
  if (subscriptions.length === 0) {
    return;
  }

  const signingKey = await getOrGeneratePushSigningKey(scopedDb, cipher, resolveVapidSubject());

  await deliverToSubscriptions(
    scopedDb,
    subscriptionsRepository,
    sendWebPush,
    subscriptions,
    signingKey,
    buildPushPayload({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      href: notification.href
    })
  );
}

/**
 * Sends one summary push, "N notifications while you were away", for every unread
 * notification whose deferred_until matches this job's release time exactly. All
 * notifications deferred within the same quiet-hours window resolve to the identical
 * deferredUntil instant (computeDeferredUntil is deterministic per window), which is why
 * an exact match — not a range — is the right cohort for one release. Zero sends nothing.
 */
export async function runPushSummaryJob(
  job: Job<PushSummaryJobPayload>,
  scopedDb: DataContextDb,
  deps: PushWorkerDependencies = {}
): Promise<void> {
  assertDataContextDb(scopedDb);

  const subscriptionsRepository = deps.subscriptionsRepository ?? new PushSubscriptionsRepository();
  const cipher = deps.cipher ?? createPushSigningCipher();
  const sendWebPush = deps.sendWebPush ?? webpush.sendNotification;

  const countRow = await sql<{ count: string }>`
    SELECT count(*)::text AS count
    FROM app.notifications n
    LEFT JOIN app.notification_reads r ON r.notification_id = n.id
    WHERE n.deferred_until = ${job.data.releaseAt}::timestamptz
      AND r.notification_id IS NULL
  `.execute(scopedDb.db);

  const count = Number(countRow.rows[0]?.count ?? "0");
  if (count === 0) {
    return;
  }

  const subscriptions = await subscriptionsRepository.listActiveForActor(scopedDb);
  if (subscriptions.length === 0) {
    return;
  }

  const signingKey = await getOrGeneratePushSigningKey(scopedDb, cipher, resolveVapidSubject());

  await deliverToSubscriptions(
    scopedDb,
    subscriptionsRepository,
    sendWebPush,
    subscriptions,
    signingKey,
    {
      id: `summary:${job.data.releaseAt}`,
      title: "Moss",
      body: `${count} notification${count === 1 ? "" : "s"} while you were away`,
      href: "/notifications"
    }
  );
}
