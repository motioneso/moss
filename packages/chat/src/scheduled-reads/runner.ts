import type { PgBoss, WorkOptions } from "pg-boss";
import type { AssistantToolGateway, GatewayToolResponse } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import { ChatRepository } from "../repository.js";
import { ReminderRepository, type DueReminder } from "../reminders/repository.js";
import { persistReminderResult, type DeliverReminderJobPayload } from "../reminders/deliver.js";
import { lockReminderDestination } from "../reminders/destination.js";
import { enqueueReminderNotification } from "../reminders/notifications.js";
import { readScheduledOperation, recordReadOutcome } from "./repository.js";
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

export interface ScheduledReadRunnerDeps {
  readonly dataContext: DataContextRunner;
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
  const load = async (db: DataContextDb) => {
    await chat.lockThreadSelection(db);
    const reminder = await reminders.lockForDelivery(db, payload.resourceId);
    if (
      !reminder ||
      reminder.ownerUserId !== payload.actorUserId ||
      reminder.state !== "queued" ||
      reminder.version !== payload.version
    )
      return null;
    const now = await reminders.now(db);
    if (now < reminder.dueAt) throw new Error("scheduled read ran early");
    if (reminder.deadlineAt && now > reminder.deadlineAt) {
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
  const snapshot = await deps.dataContext.withDataContext(access, load);
  if (!snapshot) return "inactive";
  const read = async (): Promise<GatewayToolResponse> => {
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
  const readFailure = (response: GatewayToolResponse) => {
    const temporary = !response.ok && "retryable" in response && response.retryable === true;
    const retries = Math.min(job.retryLimit ?? 0, 2);
    if (temporary && typeof job.retryCount === "number" && job.retryCount < retries)
      throw new Error("scheduled read temporarily failed");
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
  const task = readScheduledTask(response, snapshot.operation.item_id);
  let result;
  if (!task) result = readFailure(response);
  else {
    if (!(await deps.dataContext.withDataContext(access, load))) return "inactive";
    let generated;
    try {
      generated = await deps.generateReport(
        payload.actorUserId,
        task,
        AbortSignal.timeout(120_000)
      );
    } catch {
      generated = { ok: false as const, reason: "failed" as const };
    }
    if (!(await deps.dataContext.withDataContext(access, load))) return "inactive";
    const latestResponse = await read();
    const latest = readScheduledTask(latestResponse, snapshot.operation.item_id);
    if (!latest) result = readFailure(latestResponse);
    else if (latest.title !== task.title || latest.status !== task.status)
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
    else result = { outcome: "success" as const, text: generated.text };
  }
  const { outcome, text } = result;
  return deps.dataContext.withDataContext(access, async (db) => {
    const current = await load(db);
    if (!current) return "inactive";
    await recordReadOutcome(db, current.reminder.id, outcome);
    await persistReminderResult(db, current.reminder, text, current.now, {
      chat,
      reminders,
      enqueueNotification: deps.enqueueNotification,
      ...(outcome === "success" ? { scheduledReadSource: "tasks" as const } : {})
    });
    return outcome;
  });
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
          enqueueNotification: (db, reminder) => enqueueReminderNotification(boss, db, reminder)
        });
    }
  );
}
