import type { PgBoss, WorkOptions } from "pg-boss";
import type { AssistantToolGateway, GatewayToolResponse } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import { ChatRepository } from "../repository.js";
import { ReminderRepository, type DueReminder } from "../reminders/repository.js";
import { persistReminderResult, type DeliverReminderJobPayload } from "../reminders/deliver.js";
import { lockReminderDestination } from "../reminders/destination.js";
import { enqueueReminderNotification } from "../reminders/notifications.js";
import {
  scheduledObservationKey,
  scheduledObservationDecision,
  recurringReadFailureMessage,
  scheduledFailureNotification
} from "./observation.js";
import { persistQuietScheduledRun } from "./recurring.js";
import { nextReminderOccurrence } from "../reminders/repeating.js";
import { recordReminderRun } from "../reminders/runs.js";
import {
  readScheduledOperation,
  recordReadOutcome,
  recordScheduledObservation
} from "./repository.js";
import {
  readScheduledTask,
  SCHEDULED_READ_FAILED,
  SCHEDULED_READ_REFUSED,
  SCHEDULED_READ_IMMEDIATE_FAILURE,
  SCHEDULED_REPORT_FAILED,
  SCHEDULED_REPORT_UNAVAILABLE,
  SCHEDULED_REPORT_TIMEOUT,
  SCHEDULED_SOURCE_CHANGED
} from "./report.js";
import type { ScheduledReportGenerator } from "./report-generation.js";
import { CHAT_SCHEDULED_READ_QUEUE } from "./queue.js";
import {
  admitScheduledReadAttempt,
  validScheduledReadAttempt,
  dispatchScheduledReadRecovery,
  startScheduledReadRenewal,
  finishScheduledReadAttempt,
  type ScheduledReadAttempt
} from "./attempts.js";

export interface ScheduledReadRunnerDeps {
  readonly dataContext: DataContextRunner;
  readonly boss?: Pick<PgBoss, "send">;
  readonly generateReport: ScheduledReportGenerator;
  readonly gateway: Pick<AssistantToolGateway, "runBackgroundReadForActor">;
  readonly enqueueNotification?: (db: DataContextDb, reminder: DueReminder) => Promise<void>;
}

export async function runScheduledReadJob(
  job: {
    readonly data: DeliverReminderJobPayload;
    readonly retryCount?: number;
    readonly retryLimit?: number;
  },
  deps: ScheduledReadRunnerDeps
): Promise<string> {
  const payload = job.data;
  const access = {
    actorUserId: payload.actorUserId,
    requestId: `scheduled-read:${payload.resourceId}:${payload.version}`
  };
  const reminders = new ReminderRepository();
  const chat = new ChatRepository();
  const load = async (db: DataContextDb, attempt?: ScheduledReadAttempt) => {
    await chat.lockThreadSelection(db);
    const reminder = await reminders.lockForDelivery(db, payload.resourceId);
    if (
      !reminder ||
      reminder.ownerUserId !== payload.actorUserId ||
      reminder.state !== "queued" ||
      reminder.version !== payload.version
    )
      return null;
    if ("idempotencyKey" in payload && payload.idempotencyKey !== reminder.reservedMessageId)
      return null;
    if (attempt && !(await validScheduledReadAttempt(db, reminder, attempt))) return null;
    const now = await reminders.now(db);
    if (now < reminder.dueAt) throw new Error("scheduled read ran early");
    if (reminder.deadlineAt && now > reminder.deadlineAt) {
      if (reminder.repeat) await recordReminderRun(db, reminder, "expired", false);
      await reminders.markExpired(db, reminder.id);
      return null;
    }
    const operation = await readScheduledOperation(db, reminder.id);
    if (!operation || operation.owner_user_id !== payload.actorUserId) return null;
    const target = await lockReminderDestination(
      db,
      payload.actorUserId,
      reminder.threadId,
      reminder.destinationTitle
    );
    if (!target) {
      await reminders.markFailed(db, reminder.id);
      return null;
    }
    return { reminder, operation, now };
  };
  const snapshot = await deps.dataContext.withDataContext(access, async (db) => {
    const loaded = await load(db);
    if (!loaded) return null;
    if (!deps.boss) throw new Error("Scheduled read watchdog queue unavailable");
    const admitted = await admitScheduledReadAttempt(db, loaded.reminder, deps.boss);
    return admitted ? { ...loaded, admitted } : null;
  });
  if (!snapshot) return "inactive";
  const recheck = (db: DataContextDb) => load(db, snapshot.admitted);
  const stopRenewal = startScheduledReadRenewal(
    deps.dataContext,
    payload.actorUserId,
    payload.resourceId,
    snapshot.admitted
  );
  try {
    const read = async (): Promise<GatewayToolResponse | null> => {
      if (!(await deps.dataContext.withDataContext(access, recheck))) return null;
      try {
        return await deps.gateway.runBackgroundReadForActor(payload.actorUserId, {
          operation: snapshot.operation.operation,
          itemId: snapshot.operation.item_id,
          runId: access.requestId
        });
      } catch {
        return { ok: false, error: "Read failed", failureKind: "read" };
      }
    };
    const readFailure = async (response: GatewayToolResponse) => {
      const temporary =
        !response.ok &&
        "failureKind" in response &&
        response.failureKind === "read" &&
        "retryable" in response &&
        response.retryable === true;
      const eligibleRetry =
        Number.isInteger(job.retryCount) &&
        (job.retryCount ?? -1) >= 0 &&
        Number.isInteger(job.retryLimit) &&
        (job.retryCount ?? 0) < Math.min(job.retryLimit ?? 0, 1);
      if (temporary && eligibleRetry && snapshot.admitted.ordinal === 1) {
        const dispatched = await deps.dataContext.withDataContext(access, async (db) => {
          const current = await recheck(db);
          return current && deps.boss
            ? dispatchScheduledReadRecovery(db, current.reminder, deps.boss, snapshot.admitted)
            : null;
        });
        if (!dispatched) return null;
        throw new Error("scheduled read temporarily failed");
      }
      const failed = response.ok || ("failureKind" in response && response.failureKind === "read");
      return {
        outcome: failed ? ("failed" as const) : ("refused" as const),
        text: failed
          ? temporary && (job.retryCount ?? 0) > 0
            ? SCHEDULED_READ_FAILED
            : SCHEDULED_READ_IMMEDIATE_FAILURE
          : SCHEDULED_READ_REFUSED
      };
    };
    const response = await read();
    if (!response) return "inactive";
    const task = readScheduledTask(response, snapshot.operation.item_id);
    let result: {
      outcome: "success" | "refused" | "failed";
      text: string;
      observationKey?: string;
      quiet?: boolean;
    };
    if (!task) {
      const failure = await readFailure(response);
      if (!failure) return "inactive";
      result = failure;
    } else {
      if (!(await deps.dataContext.withDataContext(access, recheck))) return "inactive";
      const decision = scheduledObservationDecision(snapshot.operation.observation_key, task);
      const quiet = snapshot.reminder.repeat !== null && decision !== "changed";
      let generated;
      try {
        generated = quiet
          ? { ok: true as const, text: "" }
          : await deps.generateReport(payload.actorUserId, task, AbortSignal.timeout(120_000));
      } catch {
        generated = { ok: false as const, reason: "failed" as const };
      }
      if (!(await deps.dataContext.withDataContext(access, recheck))) return "inactive";
      const latestResponse = await read();
      if (!latestResponse) return "inactive";
      const latest = readScheduledTask(latestResponse, snapshot.operation.item_id);
      if (!latest) {
        const failure = await readFailure(latestResponse);
        if (!failure) return "inactive";
        result = failure;
      } else if (latest.title !== task.title || latest.status !== task.status)
        result = { outcome: "failed" as const, text: SCHEDULED_SOURCE_CHANGED };
      else if (!generated.ok)
        result = {
          outcome: "failed" as const,
          text:
            generated.reason === "unavailable"
              ? SCHEDULED_REPORT_UNAVAILABLE
              : generated.reason === "timeout"
                ? SCHEDULED_REPORT_TIMEOUT
                : SCHEDULED_REPORT_FAILED
        };
      else
        result = {
          outcome: "success",
          text: generated.text,
          observationKey: scheduledObservationKey(task),
          quiet
        };
    }
    const { outcome, text } = result;
    return await deps.dataContext.withDataContext(access, async (db) => {
      const current = await recheck(db);
      if (!current) return "inactive";
      const continues =
        !current.reminder.repeat ||
        !current.reminder.deadlineAt ||
        nextReminderOccurrence(
          { ...current.reminder, repeat: current.reminder.repeat },
          current.now
        ).dueAt <= current.reminder.deadlineAt;
      const postedText =
        current.reminder.repeat && outcome !== "success"
          ? recurringReadFailureMessage(outcome, continues)
          : text;
      if (current.reminder.repeat) {
        if (!deps.boss) throw new Error("Recurring scheduled read queue unavailable");
        await recordScheduledObservation(
          db,
          current.reminder.id,
          outcome,
          result.observationKey ?? null
        );
        if (
          result.quiet ||
          (outcome !== "success" && !scheduledFailureNotification(current.operation.failure_streak))
        ) {
          await persistQuietScheduledRun(
            db,
            current.reminder,
            outcome === "success" ? "quiet" : outcome,
            current.now,
            reminders,
            deps.boss
          );
          await finishScheduledReadAttempt(db, current.reminder, snapshot.admitted);
          return outcome === "success" ? "quiet" : outcome;
        }
      } else await recordReadOutcome(db, current.reminder.id, outcome);
      await persistReminderResult(db, current.reminder, postedText, current.now, {
        chat,
        reminders,
        boss: deps.boss,
        runOutcome: outcome === "success" ? "delivered" : outcome,
        enqueueNotification: deps.enqueueNotification,
        ...(outcome === "success" ? { scheduledReadSource: "tasks" as const } : {})
      });
      await finishScheduledReadAttempt(db, current.reminder, snapshot.admitted);
      return outcome;
    });
  } finally {
    await stopRenewal();
  }
}

export function registerScheduledReadWorker(
  boss: PgBoss,
  deps: ScheduledReadRunnerDeps,
  workOptions?: WorkOptions
): Promise<string> {
  return boss.work<DeliverReminderJobPayload>(
    CHAT_SCHEDULED_READ_QUEUE,
    { pollingIntervalSeconds: 1, ...workOptions, includeMetadata: true },
    async ([job]) => {
      if (job)
        await runScheduledReadJob(job, {
          ...deps,
          boss,
          enqueueNotification: (db, reminder) => enqueueReminderNotification(boss, db, reminder)
        });
    }
  );
}
