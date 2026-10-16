import { sql } from "kysely";
import { isUuid, type DataContextDb } from "@moss/db";
import { lockNotificationDelivery, type DueReminder } from "../reminders/repository.js";
import { enqueueReminderNotification } from "../reminders/notifications.js";
import {
  recoverScheduledReadOccurrence,
  scheduleScheduledReadBookkeeping,
  type ScheduledReadBookkeepingDeps,
  type ScheduledReadRecoveryTarget,
  type ScheduledReadRecoveryOutcome
} from "./bookkeeping.js";
import { CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE } from "./queue.js";

export type ScheduledReadSupportMode = "seed" | "recover";
export type ScheduledReadSupportDeps = ScheduledReadBookkeepingDeps & {
  readonly boss: NonNullable<ScheduledReadBookkeepingDeps["boss"]>;
};
export type ScheduledReadSupportReceipt = ScheduledReadRecoveryTarget & {
  readonly status: "seeded" | "already_seeded" | "terminal" | ScheduledReadRecoveryOutcome;
  readonly jobId?: string;
};

export function validateScheduledReadTargets(
  value: unknown,
  limit: number
): ScheduledReadRecoveryTarget[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > limit
  )
    throw new Error("A finite manifest of 1..limit entries (limit <= 1000) is required");
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid occurrence metadata");
    const fields = Object.keys(entry).sort();
    if (fields.join(",") !== "actorUserId,expectedMessageId,resourceId")
      throw new Error("Only exact occurrence metadata is accepted");
    const row = entry as Record<string, unknown>;
    for (const field of fields)
      if (typeof row[field] !== "string" || !isUuid(row[field]))
        throw new Error("Invalid occurrence identity");
    const target = {
      actorUserId: String(row.actorUserId).toLowerCase(),
      resourceId: String(row.resourceId).toLowerCase(),
      expectedMessageId: String(row.expectedMessageId).toLowerCase()
    };
    // One operation per reminder, including aliases of the same UUID.
    if (seen.has(target.resourceId)) throw new Error("Duplicate occurrence target");
    seen.add(target.resourceId);
    return target;
  });
}

/** Metadata only: neither saved task content nor source snapshots are selected. */
async function metadata(db: DataContextDb, target: ScheduledReadRecoveryTarget) {
  const row = await db.db
    .selectFrom("app.chat_reminders as r")
    .innerJoin("app.chat_scheduled_reads as s", "s.reminder_id", "r.id")
    .select([
      "r.id",
      "r.owner_user_id",
      "r.reserved_message_id",
      "r.state",
      "r.version",
      "r.due_at",
      "s.attempt_message_id",
      "s.attempt_state",
      "s.watchdog_job_id",
      "s.watchdog_generation"
    ])
    .where("r.id", "=", target.resourceId)
    .where("r.owner_user_id", "=", target.actorUserId)
    .where("s.owner_user_id", "=", target.actorUserId)
    .executeTakeFirst();
  if (
    !row ||
    row.reserved_message_id !== target.expectedMessageId ||
    (row.attempt_message_id !== null && row.attempt_message_id !== target.expectedMessageId)
  )
    throw new Error("Scheduled read owner or occurrence mismatch");
  return row;
}

/** Precheck the entire bounded batch before its first effect. Operations recheck under lock. */
export async function validateScheduledReadCutover(
  targets: readonly ScheduledReadRecoveryTarget[],
  limit: number,
  deps: ScheduledReadSupportDeps
): Promise<void> {
  const checked = validateScheduledReadTargets(targets, limit);
  for (const target of checked)
    await deps.dataContext.withDataContext({ actorUserId: target.actorUserId }, async (db) => {
      await metadata(db, target);
    });
}

/** One transaction per exact legacy identity; a failed entry leaves no job or seed receipt. */
export async function seedScheduledReadCutover(
  input: ScheduledReadRecoveryTarget,
  deps: ScheduledReadSupportDeps
): Promise<ScheduledReadSupportReceipt> {
  const target = validateScheduledReadTargets([input], 1)[0]!;
  return deps.dataContext.withDataContext({ actorUserId: target.actorUserId }, async (db) => {
    await lockNotificationDelivery(db, target.resourceId);
    const row = await metadata(db, target);
    if (!["queued", "paused"].includes(row.state)) return { ...target, status: "terminal" };
    if (
      row.attempt_state !== "legacy_unknown" ||
      row.attempt_message_id !== target.expectedMessageId
    )
      throw new Error("Seed requires a quarantined legacy occurrence");
    if (row.state === "paused") return { ...target, status: "paused" };
    if (row.watchdog_job_id) {
      const receipt = await sql<{ valid: boolean }>`select exists (
        select 1 from pgboss.job where id = ${row.watchdog_job_id}::uuid
        and name = ${CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE}
        and data->>'actorUserId' = ${target.actorUserId}
        and data->>'resourceId' = ${target.resourceId}
        and data->>'idempotencyKey' = ${target.expectedMessageId}
        and (data->>'step')::integer = ${row.watchdog_generation}
        and not (data ? 'operationId') and state <> 'failed'
      ) as valid`.execute(db.db);
      if (receipt.rows[0]?.valid !== true)
        throw new Error("Seed job receipt unavailable; recover exact occurrence");
      return { ...target, status: "already_seeded", jobId: row.watchdog_job_id };
    }
    const clock = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db.db);
    const dueAt = new Date(row.due_at);
    const startAfter = new Date(Math.max(dueAt.getTime(), clock.rows[0]!.now.getTime()));
    // The B1 enqueue contract accepts DueReminder but uses only identity/version. Do not
    // fetch content to populate its unused completion fields.
    const reminder: DueReminder = {
      id: row.id,
      ownerUserId: row.owner_user_id,
      reservedMessageId: row.reserved_message_id,
      version: row.version,
      dueAt,
      state: row.state,
      text: "",
      threadId: "",
      destinationTitle: null,
      deadlineAt: null,
      repeat: null,
      localDue: null,
      timeZone: null
    };
    const jobId = await scheduleScheduledReadBookkeeping(db, reminder, deps.boss, startAfter);
    return { ...target, status: "seeded", jobId };
  });
}

/** Uses the frozen recovery gates and actual notification composition; never grants allowance. */
export async function recoverScheduledReadCutover(
  input: ScheduledReadRecoveryTarget,
  deps: ScheduledReadSupportDeps
): Promise<ScheduledReadSupportReceipt> {
  const target = validateScheduledReadTargets([input], 1)[0]!;
  await validateScheduledReadCutover([target], 1, deps);
  const status = await recoverScheduledReadOccurrence(target, {
    ...deps,
    enqueueNotification: (db, reminder) => enqueueReminderNotification(deps.boss, db, reminder)
  });
  return { ...target, status };
}
