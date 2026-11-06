import type https from "node:https";

import webpush from "web-push";

import type { DataContextDb, DataContextRunner } from "@moss/db";
import { assertDataContextDb } from "@moss/db";

import { PushDeliveryClaimsRepository } from "./push-delivery-claims.js";
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
import {
  NotificationsRepository,
  actorQuietHoursDeferredUntil,
  type NotificationPreferencePort,
  type NotificationWithReadState,
  type QuietHoursPort,
  type QuietHoursAllowancePolicy,
  type PushQueuePort
} from "./repository.js";
import { shouldPushImmediately } from "./sensitivity.js";

export interface PushWorkerDependencies {
  readonly notificationPreferencePort?: NotificationPreferencePort;
  readonly quietHoursPort?: QuietHoursPort;
  readonly isAllowedDuringQuietHours?: QuietHoursAllowancePolicy;
  readonly pushQueuePort?: PushQueuePort;
  readonly isNotificationActive?: (
    scopedDb: DataContextDb,
    notification: NotificationWithReadState
  ) => Promise<boolean>;
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
  readonly id?: string;
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
  | SendFailure;

interface DeviceAttempt {
  readonly subscriptionId: string;
  readonly result: DeviceResult;
}

/** Network only: no scoped database or repository can escape into a send. */
async function deliverToSubscriptions(
  sendWebPush: typeof webpush.sendNotification,
  httpsAgent: https.Agent,
  subscriptions: readonly PushDeliveryTarget[],
  vapidDetails: VapidDetails,
  payload: WebPushPayload,
  summaryNotificationIds?: readonly string[]
): Promise<readonly DeviceAttempt[]> {
  return Promise.all(
    subscriptions.map(async (subscription): Promise<DeviceAttempt> => {
      const attempt = (result: DeviceResult): DeviceAttempt => ({
        subscriptionId: subscription.id,
        result
      });
      if (subscription.lastDeliveredKey === payload.id)
        return attempt({ kind: "alreadyDelivered" });
      let devicePayload = payload;
      if (summaryNotificationIds) {
        const count = summaryNotificationIds.filter(
          (id) => id !== subscription.lastDeliveredKey
        ).length;
        if (count === 0) return attempt({ kind: "alreadyDelivered" });
        devicePayload = {
          ...payload,
          body: `${count} notification${count === 1 ? "" : "s"} while you were away`
        };
      }
      try {
        const endpoint = validatePushEndpoint(subscription.endpoint);
        await withDeadline(
          sendWebPush(
            { endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            JSON.stringify(devicePayload),
            { vapidDetails, timeout: PUSH_SEND_TIMEOUT_MS, agent: httpsAgent }
          ),
          PUSH_SEND_DEADLINE_MS
        );
        return attempt({ kind: "delivered" });
      } catch (error) {
        return attempt(classifySendFailure(error));
      }
    })
  );
}

/** A runner, rather than a scoped transaction: sends must happen after the claim commits. */
export type PushDataContext = Pick<DataContextRunner, "withDataContext">;

interface PushContent {
  readonly notifications: readonly NotificationWithReadState[];
  readonly payload: WebPushPayload;
  readonly summaryNotificationIds?: readonly string[];
}

async function runPushJob(
  job: PushJob<PushDeliverJobPayload | PushSummaryJobPayload>,
  dataContext: PushDataContext,
  deps: PushWorkerDependencies,
  load: (db: DataContextDb, repository: NotificationsRepository) => Promise<PushContent | undefined>
): Promise<PushDeliveryOutcome> {
  const notificationsRepository = deps.notificationsRepository ?? new NotificationsRepository();
  const subscriptionsRepository = deps.subscriptionsRepository ?? new PushSubscriptionsRepository();
  const claims = new PushDeliveryClaimsRepository();
  const access = {
    actorUserId: job.data.actorUserId,
    requestId: job.id ? `pgboss:${job.id}` : undefined
  };
  const prepared = await dataContext.withDataContext(access, async (db) => {
    assertDataContextDb(db);
    const content = await load(db, notificationsRepository);
    if (!content) return NOTHING_TO_DELIVER;
    // Lifecycle locks order this admission against dismissal. Persist a lease before
    // releasing those locks so another worker cannot admit the same payload concurrently.
    const claimToken = await claims.claim(db, content.payload.id);
    if (!claimToken) return CLAIM_BUSY;
    const subscriptions = await subscriptionsRepository.listActiveForDelivery(db);
    if (subscriptions.length === 0) {
      await claims.release(db, content.payload.id, claimToken);
      return NOTHING_TO_DELIVER;
    }
    const signingKey = await getOrGeneratePushSigningKey(
      db,
      deps.cipher ?? createPushSigningCipher()
    );
    return { ...content, claimToken, subscriptions, vapidDetails: buildVapidDetails(signingKey) };
  });
  if (!("claimToken" in prepared)) return prepared;

  const attempts = await deliverToSubscriptions(
    deps.sendWebPush ?? webpush.sendNotification,
    resolveHttpsAgent(deps),
    prepared.subscriptions,
    prepared.vapidDetails,
    prepared.payload,
    prepared.summaryNotificationIds
  );

  return dataContext.withDataContext(access, async (db) => {
    // Reacquire the source lifecycle locks in the same order as admission. A send
    // admitted before dismissal may finish, but a dismissed source cannot ask for retries.
    let active = false;
    for (const notification of prepared.notifications) {
      if (!deps.isNotificationActive || (await deps.isNotificationActive(db, notification)))
        active = true;
    }
    if (!(await claims.release(db, prepared.payload.id, prepared.claimToken))) {
      return active ? CLAIM_BUSY : NOTHING_TO_DELIVER;
    }
    for (const { subscriptionId, result } of attempts) {
      if (result.kind === "delivered") {
        await subscriptionsRepository.recordDeliverySuccess(
          db,
          subscriptionId,
          prepared.payload.id
        );
      } else if (result.kind === "gone") {
        await subscriptionsRepository.delete(db, subscriptionId);
      } else if (
        result.kind === "permanent" ||
        (result.kind === "temporary" && isFinalAttempt(job))
      ) {
        await subscriptionsRepository.recordDeliveryFailure(db, subscriptionId);
      }
    }
    const reasons = active
      ? attempts.flatMap(({ result }) => (result.kind === "temporary" ? [result.reason] : []))
      : [];
    return {
      delivered: attempts.filter(({ result }) => result.kind === "delivered").length,
      alreadyDelivered: attempts.filter(({ result }) => result.kind === "alreadyDelivered").length,
      temporaryFailures: reasons.length,
      reasons
    };
  });
}

/** Delivers one notification; all database transactions finish before network I/O. */
export function runPushDeliverJob(
  job: PushJob<PushDeliverJobPayload>,
  dataContext: PushDataContext,
  deps: PushWorkerDependencies = {}
): Promise<PushDeliveryOutcome> {
  return runPushJob(job, dataContext, deps, async (db, repository) => {
    const notification = await repository.getById(db, job.data.notificationId);
    if (
      !notification ||
      !(await canDeliverPush(
        db,
        notification,
        repository,
        deps,
        new Date(Math.max(Date.now(), job.data.releaseAt ? Date.parse(job.data.releaseAt) : 0)),
        false
      ))
    )
      return undefined;
    return {
      notifications: [notification],
      payload: buildPushPayload({
        id: notification.id,
        title: notification.title,
        body: notification.body,
        href: notification.href
      })
    };
  });
}

const CLAIM_BUSY: PushDeliveryOutcome = {
  delivered: 0,
  alreadyDelivered: 0,
  temporaryFailures: 1,
  reasons: ["in-flight"]
};

const NOTHING_TO_DELIVER: PushDeliveryOutcome = {
  delivered: 0,
  alreadyDelivered: 0,
  temporaryFailures: 0,
  reasons: []
};

async function canDeliverPush(
  scopedDb: DataContextDb,
  notification: NotificationWithReadState,
  repository: NotificationsRepository,
  deps: PushWorkerDependencies,
  now: Date,
  summary: boolean
): Promise<boolean> {
  if (
    notification.module_id &&
    deps.notificationPreferencePort &&
    !(await deps.notificationPreferencePort.isModuleEnabled(scopedDb, notification.module_id))
  )
    return false;
  if (deps.isNotificationActive && !(await deps.isNotificationActive(scopedDb, notification)))
    return false;
  const urgency =
    notification.urgency === "urgent" || notification.urgency === "low"
      ? notification.urgency
      : "normal";
  const sensitivity =
    (await deps.notificationPreferencePort?.getSensitivity?.(scopedDb)) ?? "balanced";
  if (!shouldPushImmediately(sensitivity, urgency)) return false;
  if (
    urgency !== "urgent" &&
    deps.quietHoursPort &&
    !(await deps.isAllowedDuringQuietHours?.(scopedDb, notification))
  ) {
    const releaseAt = await actorQuietHoursDeferredUntil(scopedDb, deps.quietHoursPort, now);
    if (releaseAt) {
      if (!deps.pushQueuePort) throw new Error("push quiet-hours queue is not configured");
      if (summary) {
        await repository.deferDelivery(scopedDb, notification.id, releaseAt);
        await deps.pushQueuePort.enqueueSummary(
          scopedDb,
          notification.recipient_user_id!,
          releaseAt
        );
      } else {
        // The bell item is already visible; only its device alert waits.
        await deps.pushQueuePort.enqueueDeliver(
          scopedDb,
          notification.id,
          notification.recipient_user_id!,
          releaseAt
        );
      }
      return false;
    }
  }
  return true;
}

/**
 * Sends one summary push, "N notifications while you were away", for every unread
 * notification whose deferred_until matches this job's release time exactly. All
 * notifications deferred within the same quiet-hours window resolve to the identical
 * deferredUntil instant (computeDeferredUntil is deterministic per window), which is why
 * an exact match — not a range — is the right cohort for one release. Zero sends nothing.
 */
export function runPushSummaryJob(
  job: PushJob<PushSummaryJobPayload>,
  dataContext: PushDataContext,
  deps: PushWorkerDependencies = {}
): Promise<PushDeliveryOutcome> {
  return runPushJob(job, dataContext, deps, async (db, repository) => {
    const releaseAt = new Date(job.data.releaseAt);
    const now = new Date(Math.max(Date.now(), releaseAt.getTime()));
    const cohort = await repository.listUnreadDeferred(db, releaseAt);
    const notifications: NotificationWithReadState[] = [];
    // Stable lock order across overlapping summary cohorts and finalization.
    for (const notification of [...cohort].sort((a, b) => a.id.localeCompare(b.id))) {
      if (await canDeliverPush(db, notification, repository, deps, now, true))
        notifications.push(notification);
    }
    if (notifications.length === 0) return undefined;
    return {
      notifications,
      summaryNotificationIds: notifications.map((row) => row.id),
      payload: {
        id: `summary:${job.data.releaseAt}`,
        title: "Moss",
        body: `${notifications.length} notification${notifications.length === 1 ? "" : "s"} while you were away`,
        href: "/notifications"
      }
    };
  });
}
