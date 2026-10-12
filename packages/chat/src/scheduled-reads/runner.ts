import type { PgBoss, WorkOptions } from "pg-boss";
import type { AssistantToolGateway } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import { ChatRepository } from "../repository.js";
import { ReminderRepository, type DueReminder } from "../reminders/repository.js";
import { persistReminderResult, type DeliverReminderJobPayload } from "../reminders/deliver.js";
import { enqueueReminderNotification } from "../reminders/notifications.js";
import { readScheduledOperation, recordReadOutcome } from "./repository.js";
import { scheduledReadReport, SCHEDULED_READ_FAILED, SCHEDULED_READ_REFUSED } from "./report.js";
import { CHAT_SCHEDULED_READ_QUEUE } from "./queue.js";

export interface ScheduledReadRunnerDeps {
  readonly dataContext: DataContextRunner;
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
    const main = await chat.getMainThread(db, payload.actorUserId);
    if (main?.id !== reminder.threadId) {
      await reminders.markFailed(db, reminder.id);
      return null;
    }
    return { reminder, operation, now };
  };
  const snapshot = await deps.dataContext.withDataContext(access, load);
  if (!snapshot) return "inactive";
  let response;
  try {
    response = await deps.gateway.runBackgroundReadForActor(payload.actorUserId, {
      operation: snapshot.operation.operation,
      itemId: snapshot.operation.item_id,
      runId: access.requestId
    });
  } catch {
    response = { ok: false as const, error: "Read failed" };
  }
  const report = scheduledReadReport(response, snapshot.operation.item_id);
  const transient =
    !report && (response.ok || ("error" in response && /failed/i.test(response.error)));
  if (
    transient &&
    typeof job.retryCount === "number" &&
    typeof job.retryLimit === "number" &&
    job.retryCount < job.retryLimit
  )
    throw new Error("scheduled read temporarily failed");
  const outcome = report ? "success" : transient ? "failed" : "refused";
  return deps.dataContext.withDataContext(access, async (db) => {
    const current = await load(db);
    if (!current) return "inactive";
    await recordReadOutcome(db, current.reminder.id, outcome);
    await persistReminderResult(
      db,
      current.reminder,
      report ?? (transient ? SCHEDULED_READ_FAILED : SCHEDULED_READ_REFUSED),
      current.now,
      {
        chat,
        reminders,
        enqueueNotification: deps.enqueueNotification,
        ...(report ? { scheduledReadSource: "tasks" as const } : {})
      }
    );
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
