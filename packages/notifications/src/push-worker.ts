import type https from "node:https";

import { sql } from "kysely";
import webpush from "web-push";

import type { DataContextDb } from "@moss/db";
import { assertDataContextDb } from "@moss/db";

import { buildPushPayload } from "./push-payload.js";
import {
  createPushSigningCipher,
  getOrGeneratePushSigningKey,
  resolveVapidSubject
} from "./push-crypto.js";
import {
  PUSH_SEND_TIMEOUT_MS,
  PushSubscriptionInvalidError,
  createPushHttpsAgent,
  validatePushEndpoint
} from "./push-endpoint-policy.js";
import type { PushDeliverJobPayload, PushSummaryJobPayload } from "./push-jobs.js";
import {
  PushSubscriptionsRepository,
  type PushDeliveryTarget
} from "./push-subscriptions-repository.js";
import { NotificationsRepository } from "./repository.js";

export interface PushWorkerDependencies {
  readonly notificationsRepository?: NotificationsRepository;
  readonly subscriptionsRepository?: PushSubscriptionsRepository;
  readonly cipher?: ReturnType<typeof createPushSigningCipher>;
  /** Test seam: real code always goes through the `web-push` library. */
  readonly sendWebPush?: typeof webpush.sendNotification;
  /**
   * The https agent every send goes through. Defaults to one whose DNS lookup refuses
   * private, loopback and link-local answers (#743 security finding 1, DNS rebinding).
   */
  readonly httpsAgent?: https.Agent;
}

let defaultHttpsAgent: https.Agent | undefined;

function resolveHttpsAgent(deps: PushWorkerDependencies): https.Agent {
  if (deps.httpsAgent) {
    return deps.httpsAgent;
  }
  defaultHttpsAgent ??= createPushHttpsAgent();
  return defaultHttpsAgent;
}

/**
 * The slice of a pg-boss job the push workers read. Structural on purpose: `@moss/jobs`
 * depends on this package, so importing its `Job` type here would form a package cycle.
 */
export interface PushJob<T> {
  readonly data: T;
  /**
   * pg-boss retry metadata, present only when the worker was registered with
   * `includeMetadata: true`. Absent means: treat this attempt as the final one.
   */
  readonly retryCount?: number;
  readonly retryLimit?: number;
}

/**
 * Worker-side ceiling on one send, in milliseconds. The socket timeout in the send options
 * covers a silent connection; this covers a service that keeps the connection alive but
 * never finishes its answer. Either way the send counts as a temporary failure.
 */
export const PUSH_SEND_DEADLINE_MS = 15_000;

export class PushSendTimeoutError extends Error {
  constructor() {
    super(`push send did not finish within ${PUSH_SEND_DEADLINE_MS} ms`);
    this.name = "PushSendTimeoutError";
  }
}

/**
 * What one delivery attempt did, returned to the registrar's after-commit hook. Counts and
 * status codes only: nothing here may name a device, an endpoint or a response body,
 * because pg-boss stores a thrown error in the job's output column.
 */
export interface PushDeliveryOutcome {
  /** Devices that received the payload during this attempt. */
  readonly delivered: number;
  /** Devices skipped because an earlier attempt already delivered this payload to them. */
  readonly alreadyDelivered: number;
  /** Devices whose send failed temporarily (throttled, 5xx, network, timeout). */
  readonly temporaryFailures: number;
  /** One entry per temporary failure: the status code, "timeout" or "network". */
  readonly reasons: readonly string[];
}

/** Thrown after commit to make pg-boss retry the job; carries counts and status codes only. */
export class PushDeliveryRetryError extends Error {
  constructor(outcome: PushDeliveryOutcome) {
    super(
      `push delivery: ${outcome.temporaryFailures} device(s) failed temporarily (${outcome.reasons.join(", ")})`
    );
    this.name = "PushDeliveryRetryError";
  }
}

/**
 * After-commit hook for both push workers (#743 security finding 8). Throwing here, and only
 * here, fails the job so pg-boss retries it while the bookkeeping the attempt wrote (delivery
 * marks, removed devices, failure counts) stays committed. On the final attempt the throw
 * simply records the job as failed.
 */
export function throwIfPushRetryNeeded(outcome: PushDeliveryOutcome): void {
  if (outcome.temporaryFailures > 0) {
    throw new PushDeliveryRetryError(outcome);
  }
}

function isFinalAttempt(job: PushJob<unknown>): boolean {
  if (typeof job.retryCount !== "number" || typeof job.retryLimit !== "number") {
    return true;
  }
  return job.retryCount >= job.retryLimit;
}

type SendFailure =
  | { readonly kind: "gone" }
  | { readonly kind: "temporary"; readonly reason: string }
  | { readonly kind: "permanent" };

/**
 * 404/410 and a stored address the policy refuses: the device is gone. 429, any 5xx, and
 * anything without a status code (DNS, connection, socket timeout, our own deadline) is
 * temporary. Every other 4xx (bad payload, rejected VAPID key, too large) will not improve on
 * a retry, so it counts against the device at once.
 */
function classifySendFailure(error: unknown): SendFailure {
  if (error instanceof PushSubscriptionInvalidError) {
    return { kind: "gone" };
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode !== "number") {
    return {
      kind: "temporary",
      reason: error instanceof PushSendTimeoutError ? "timeout" : "network"
    };
  }
  if (statusCode === 404 || statusCode === 410) {
    return { kind: "gone" };
  }
  if (statusCode === 429 || statusCode >= 500) {
    return { kind: "temporary", reason: String(statusCode) };
  }
  return { kind: "permanent" };
}

function withDeadline<T>(send: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PushSendTimeoutError()), deadlineMs);
    timer.unref?.();
  });
  return Promise.race([send, deadline]).finally(() => clearTimeout(timer));
}

interface WebPushPayload {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
}

interface VapidDetails {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/**
 * The VAPID identity presented to the push service: the stored key pair plus a subject
 * resolved from configuration at send time (never from a request, never from the row).
 */
function buildVapidDetails(signingKey: {
  readonly publicKey: string;
  readonly privateKey: string;
}): VapidDetails {
  return {
    subject: resolveVapidSubject(),
    publicKey: signingKey.publicKey,
    privateKey: signingKey.privateKey
  };
}

type DeviceResult =
  | { readonly kind: "delivered" }
  | { readonly kind: "alreadyDelivered" }
  | { readonly kind: "temporary"; readonly reason: string }
  | { readonly kind: "settled" };

/**
 * Sends one payload to every given subscription, independently: a send failure for one
 * subscription never blocks another. 404/410 (the push service says the subscription is
 * gone) deletes that row outright. A temporary failure leaves the row alone while pg-boss
 * attempts remain and is reported in the outcome so the after-commit hook can ask for a
 * retry; on the final attempt, and for any failure a retry cannot fix, it increments
 * `failure_count`, and a fifth consecutive failure disables the row instead of deleting it,
 * so the settings page can still show it (spec 5.4). A success resets the count and records
 * the payload id, and a device already holding that id is skipped (#743 finding 8).
 */
async function deliverToSubscriptions(
  scopedDb: DataContextDb,
  subscriptionsRepository: PushSubscriptionsRepository,
  sendWebPush: typeof webpush.sendNotification,
  httpsAgent: https.Agent,
  subscriptions: readonly PushDeliveryTarget[],
  vapidDetails: VapidDetails,
  payload: WebPushPayload,
  finalAttempt: boolean
): Promise<PushDeliveryOutcome> {
  const serialized = JSON.stringify(payload);

  const results = await Promise.all(
    subscriptions.map(async (subscription): Promise<DeviceResult> => {
      if (subscription.lastDeliveredKey === payload.id) {
        return { kind: "alreadyDelivered" };
      }
      try {
        // Re-check the stored address at send time so a row written before the policy
        // existed, or under a weaker one, can never turn a send into a private request.
        const endpoint = validatePushEndpoint(subscription.endpoint);
        await withDeadline(
          sendWebPush(
            {
              endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth }
            },
            serialized,
            { vapidDetails, timeout: PUSH_SEND_TIMEOUT_MS, agent: httpsAgent }
          ),
          PUSH_SEND_DEADLINE_MS
        );
        await subscriptionsRepository.recordDeliverySuccess(scopedDb, subscription.id, payload.id);
        return { kind: "delivered" };
      } catch (error) {
        const failure = classifySendFailure(error);
        if (failure.kind === "gone") {
          // Gone, or an address the policy will never send to: drop the row.
          await subscriptionsRepository.delete(scopedDb, subscription.id);
          return { kind: "settled" };
        }
        if (failure.kind === "temporary" && !finalAttempt) {
          // Leave the row for the next attempt; the after-commit hook asks pg-boss for it.
          return failure;
        }
        await subscriptionsRepository.recordDeliveryFailure(scopedDb, subscription.id);
        return failure.kind === "temporary" ? failure : { kind: "settled" };
      }
    })
  );

  const reasons = results.flatMap((result) => (result.kind === "temporary" ? [result.reason] : []));
  return {
    delivered: results.filter((result) => result.kind === "delivered").length,
    alreadyDelivered: results.filter((result) => result.kind === "alreadyDelivered").length,
    temporaryFailures: reasons.length,
    reasons
  };
}

/**
 * Delivers one notification to every non-disabled subscription of its recipient.
 */
export async function runPushDeliverJob(
  job: PushJob<PushDeliverJobPayload>,
  scopedDb: DataContextDb,
  deps: PushWorkerDependencies = {}
): Promise<PushDeliveryOutcome> {
  assertDataContextDb(scopedDb);

  const notificationsRepository = deps.notificationsRepository ?? new NotificationsRepository();
  const subscriptionsRepository = deps.subscriptionsRepository ?? new PushSubscriptionsRepository();
  const cipher = deps.cipher ?? createPushSigningCipher();
  const sendWebPush = deps.sendWebPush ?? webpush.sendNotification;

  const notification = await notificationsRepository.getById(scopedDb, job.data.notificationId);
  if (!notification) {
    // Deleted, or not visible under the recipient's RLS context — nothing to deliver.
    return NOTHING_TO_DELIVER;
  }

  const subscriptions = await subscriptionsRepository.listActiveForDelivery(scopedDb);
  if (subscriptions.length === 0) {
    return NOTHING_TO_DELIVER;
  }

  const signingKey = await getOrGeneratePushSigningKey(scopedDb, cipher);

  return deliverToSubscriptions(
    scopedDb,
    subscriptionsRepository,
    sendWebPush,
    resolveHttpsAgent(deps),
    subscriptions,
    buildVapidDetails(signingKey),
    buildPushPayload({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      href: notification.href
    }),
    isFinalAttempt(job)
  );
}

const NOTHING_TO_DELIVER: PushDeliveryOutcome = {
  delivered: 0,
  alreadyDelivered: 0,
  temporaryFailures: 0,
  reasons: []
};

/**
 * Sends one summary push, "N notifications while you were away", for every unread
 * notification whose deferred_until matches this job's release time exactly. All
 * notifications deferred within the same quiet-hours window resolve to the identical
 * deferredUntil instant (computeDeferredUntil is deterministic per window), which is why
 * an exact match — not a range — is the right cohort for one release. Zero sends nothing.
 */
export async function runPushSummaryJob(
  job: PushJob<PushSummaryJobPayload>,
  scopedDb: DataContextDb,
  deps: PushWorkerDependencies = {}
): Promise<PushDeliveryOutcome> {
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
    return NOTHING_TO_DELIVER;
  }

  const subscriptions = await subscriptionsRepository.listActiveForDelivery(scopedDb);
  if (subscriptions.length === 0) {
    return NOTHING_TO_DELIVER;
  }

  const signingKey = await getOrGeneratePushSigningKey(scopedDb, cipher);

  return deliverToSubscriptions(
    scopedDb,
    subscriptionsRepository,
    sendWebPush,
    resolveHttpsAgent(deps),
    subscriptions,
    buildVapidDetails(signingKey),
    {
      id: `summary:${job.data.releaseAt}`,
      title: "Moss",
      body: `${count} notification${count === 1 ? "" : "s"} while you were away`,
      href: "/notifications"
    },
    isFinalAttempt(job)
  );
}
