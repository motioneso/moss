import {
  combinesReminderDestination,
  REMINDER_DESTINATION_SEPARATE_REPLY
} from "./edit-recognizer.js";
import { resolveReminderDestination } from "./destination.js";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { strictLocalWallClockToInstant } from "@moss/module-sdk";
import type { ReminderEditTerms } from "@moss/shared";
import { lockReminderControl } from "./controls.js";
import { enqueueReminderDelivery } from "./deliver.js";
import { ReminderRepository } from "./repository.js";
import { readScheduledOperation } from "../scheduled-reads/repository.js";

export async function readEditableReminders(scopedDb: DataContextDb) {
  assertDataContextDb(scopedDb);
  return scopedDb.db
    .selectFrom("app.chat_reminders")
    .select([
      "id",
      "version",
      "reminder_text",
      "state",
      "due_at",
      "deadline_at",
      "timing",
      "delay_seconds",
      "local_due",
      "time_zone",
      "repeat_kind",
      "repeat_seconds",
      "thread_id",
      "destination_title"
    ])
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("state", "in", ["queued", "paused"])
    .orderBy("due_at")
    .orderBy("id")
    .execute();
}
export type EditableReminder = Awaited<ReturnType<typeof readEditableReminders>>[number];

/** Validate a complete field diff before accepting model-authored reminder terms. */
export function resolveReminderEdit(
  current: EditableReminder,
  terms: ReminderEditTerms,
  now: Date,
  timeZone: string
) {
  const text = terms.text === null ? current.reminder_text : terms.text.trim();
  if (!text || text.length > 500)
    throw new Error("Keep reminder text between 1 and 500 characters.");
  if (terms.delaySeconds !== null && terms.localDue !== null)
    throw new Error("Choose one reminder time.");
  const timingChanged = terms.delaySeconds !== null || terms.localDue !== null;
  let dueAt = new Date(current.due_at);
  let timing = current.timing;
  let delaySeconds = current.delay_seconds;
  let localDue = current.local_due;
  let zone = current.time_zone;
  if (terms.delaySeconds !== null) {
    if (
      !Number.isInteger(terms.delaySeconds) ||
      terms.delaySeconds < 1 ||
      terms.delaySeconds > 2592000
    )
      throw new Error("Choose a time from 1 second to 30 days ahead.");
    dueAt = new Date(now.getTime() + terms.delaySeconds * 1000);
    timing = "relative";
    delaySeconds = terms.delaySeconds;
    localDue = null;
    zone = null;
  } else if (terms.localDue !== null) {
    dueAt = strictLocalWallClockToInstant(terms.localDue, timeZone);
    timing = "local_clock";
    delaySeconds = null;
    localDue = terms.localDue;
    zone = timeZone;
  }
  if (timingChanged && (dueAt <= now || dueAt.getTime() > now.getTime() + 2592000000))
    throw new Error("Choose a future reminder time within 30 days.");
  const repeat =
    terms.repeat === undefined || terms.repeat === null
      ? current.repeat_kind === "interval"
        ? { kind: "interval" as const, seconds: current.repeat_seconds! }
        : current.repeat_kind
          ? { kind: current.repeat_kind }
          : null
      : terms.repeat === "remove"
        ? null
        : terms.repeat;
  if (repeat && repeat.kind !== "interval" && timing !== "local_clock")
    throw new Error("Daily and weekly reminders need a local clock time.");
  if (
    repeat?.kind === "interval" &&
    (timing !== "relative" ||
      !Number.isInteger(repeat.seconds) ||
      repeat.seconds < 60 ||
      repeat.seconds >= 86400)
  )
    throw new Error("Intervals need a relative start and 60 to 86399 seconds.");
  let deadlineAt = current.deadline_at === null ? null : new Date(current.deadline_at);
  if (terms.deadline === "remove") deadlineAt = null;
  if (terms.deadline === "set") {
    if (terms.localDeadline === null || (timing !== "local_clock" && !repeat))
      throw new Error("A deadline needs a local-clock reminder time.");
    deadlineAt = strictLocalWallClockToInstant(terms.localDeadline, zone ?? timeZone);
  }
  if (
    deadlineAt !== null &&
    (deadlineAt <= dueAt ||
      (!repeat && (timing !== "local_clock" || deadlineAt.getTime() > dueAt.getTime() + 43200000)))
  )
    throw new Error(
      repeat
        ? "The stop time must follow the reminder time. Change or remove it explicitly."
        : "The deadline must follow the reminder time by no more than 12 hours. Change or remove it explicitly."
    );
  return {
    reminder_text: text,
    repeat_kind: repeat?.kind ?? null,
    repeat_seconds: repeat?.kind === "interval" ? repeat.seconds : null,
    timing,
    delay_seconds: delaySeconds,
    due_at: dueAt,
    local_due: localDue,
    time_zone: zone,
    deadline_at: deadlineAt
  };
}

export type ReminderEditResult =
  | { readonly kind: "missing" | "stale" | "not_pending" }
  | { readonly kind: "invalid"; readonly reply: string }
  | { readonly kind: "changed" | "unchanged"; readonly reminder: EditableReminder };

export async function editReminderById(
  scopedDb: DataContextDb,
  boss: Pick<PgBoss, "send">,
  actorUserId: string,
  id: string,
  expectedVersion: number,
  terms: ReminderEditTerms,
  timeZone: string,
  sourceThreadId?: string
): Promise<ReminderEditResult> {
  const locked = await lockReminderControl(scopedDb, id);
  if (!locked) return { kind: "missing" };
  if (locked.version !== expectedVersion) return { kind: "stale" };
  if (locked.state !== "queued" && locked.state !== "paused") return { kind: "not_pending" };
  if (combinesReminderDestination(terms))
    return { kind: "invalid", reply: REMINDER_DESTINATION_SEPARATE_REPLY };
  const current = (await readEditableReminders(scopedDb)).find((row) => row.id === id);
  if (!current) return { kind: "missing" };
  if (terms.text !== null && (await readScheduledOperation(scopedDb, id)))
    return {
      kind: "invalid",
      reply:
        "A task check's source is fixed. You can change its time, but not its text. Nothing changed."
    };
  const destination = terms.destination
    ? await resolveReminderDestination(scopedDb, actorUserId, terms.destination, sourceThreadId)
    : { threadId: current.thread_id, title: current.destination_title };
  if ("reply" in destination) return { kind: "invalid", reply: destination.reply };
  let values;
  try {
    values = resolveReminderEdit(
      current,
      terms,
      await new ReminderRepository().now(scopedDb),
      timeZone
    );
  } catch {
    return {
      kind: "invalid",
      reply:
        "Those reminder terms are invalid or ambiguous. Nothing changed. Daily and weekly reminders need a local time; intervals need a relative start and at least 60 seconds. A stop must follow the next reminder time."
    };
  }
  const changed =
    values.repeat_kind !== current.repeat_kind ||
    values.repeat_seconds !== current.repeat_seconds ||
    destination.threadId !== current.thread_id ||
    values.reminder_text !== current.reminder_text ||
    values.timing !== current.timing ||
    values.local_due !== current.local_due ||
    values.time_zone !== current.time_zone ||
    values.delay_seconds !== current.delay_seconds ||
    values.due_at.getTime() !== new Date(current.due_at).getTime() ||
    (values.deadline_at?.getTime() ?? null) !==
      (current.deadline_at === null ? null : new Date(current.deadline_at).getTime());
  if (!changed) return { kind: "unchanged", reminder: current };
  const row = await scopedDb.db
    .updateTable("app.chat_reminders")
    .set({
      reminder_text: values.reminder_text,
      repeat_kind: values.repeat_kind,
      repeat_seconds: values.repeat_seconds,
      ...(terms.destination
        ? { thread_id: destination.threadId, destination_title: destination.title }
        : {}),
      // Preserve omitted timestamps in PostgreSQL, including their microseconds.
      ...(terms.delaySeconds !== null || terms.localDue !== null
        ? {
            timing: values.timing,
            delay_seconds: values.delay_seconds,
            due_at: values.due_at,
            local_due: values.local_due,
            time_zone: values.time_zone
          }
        : {}),
      ...(terms.deadline !== "keep" ? { deadline_at: values.deadline_at } : {}),
      version: current.version + 1
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (row.state === "queued")
    await enqueueReminderDelivery(boss, scopedDb, actorUserId, {
      id,
      version: row.version,
      dueAt: new Date(row.due_at)
    });
  return { kind: "changed", reminder: row };
}
