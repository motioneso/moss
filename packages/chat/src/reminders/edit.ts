import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { strictLocalWallClockToInstant } from "@moss/module-sdk";
import type { ReminderEditTerms } from "@moss/shared";
import { lockReminderControl } from "./controls.js";
import { enqueueReminderDelivery } from "./deliver.js";
import { ReminderRepository } from "./repository.js";

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
      "time_zone"
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
  let deadlineAt = current.deadline_at === null ? null : new Date(current.deadline_at);
  if (terms.deadline === "remove") deadlineAt = null;
  if (terms.deadline === "set") {
    if (terms.localDeadline === null || timing !== "local_clock")
      throw new Error("A deadline needs a local-clock reminder time.");
    deadlineAt = strictLocalWallClockToInstant(terms.localDeadline, zone ?? timeZone);
  }
  if (
    deadlineAt !== null &&
    (timing !== "local_clock" ||
      deadlineAt <= dueAt ||
      deadlineAt.getTime() > dueAt.getTime() + 43200000)
  )
    throw new Error(
      "The deadline must follow the reminder time by no more than 12 hours. Change or remove it explicitly."
    );
  return {
    reminder_text: text,
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
  timeZone: string
): Promise<ReminderEditResult> {
  const locked = await lockReminderControl(scopedDb, id);
  if (!locked) return { kind: "missing" };
  if (locked.version !== expectedVersion) return { kind: "stale" };
  if (locked.state !== "queued" && locked.state !== "paused") return { kind: "not_pending" };
  const current = (await readEditableReminders(scopedDb)).find((row) => row.id === id);
  if (!current) return { kind: "missing" };
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
        "That text, time or deadline is invalid or ambiguous. Nothing changed. Use a future time and a deadline within 12 hours after it."
    };
  }
  const changed =
    values.reminder_text !== current.reminder_text ||
    values.timing !== current.timing ||
    values.due_at.getTime() !== new Date(current.due_at).getTime() ||
    (values.deadline_at?.getTime() ?? null) !==
      (current.deadline_at === null ? null : new Date(current.deadline_at).getTime());
  if (!changed) return { kind: "unchanged", reminder: current };
  const row = await scopedDb.db
    .updateTable("app.chat_reminders")
    .set({ ...values, version: current.version + 1 })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
  // Shared enqueue seam: the scheduled-read lane can route extension-backed rows here.
  if (row.state === "queued")
    await enqueueReminderDelivery(boss, scopedDb, actorUserId, {
      id,
      version: row.version,
      dueAt: new Date(row.due_at)
    });
  return { kind: "changed", reminder: row };
}
