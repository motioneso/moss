import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { localDay, resolveTimeZone } from "@moss/shared";
import { sql } from "kysely";
import { boundReminderSummary } from "./contract.js";
import {
  REMINDER_SUMMARY_LIMIT,
  type ReminderSummary,
  type ReminderSummaryRepeat,
  type ReminderSummaryScope,
  type ReminderSummaryState
} from "./types.js";

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const SCOPE_STATES: Record<ReminderSummaryScope, readonly ReminderSummaryState[] | null> = {
  upcoming: ["queued", "paused"],
  delivered: ["delivered"],
  ended: ["cancelled", "expired", "failed"],
  all: null
};

async function readActorTimeZone(db: DataContextDb): Promise<string> {
  const row = await db.db
    .selectFrom("app.preferences")
    .select("value_json")
    .where("key", "=", "locale")
    .executeTakeFirst();
  const raw = row?.value_json;
  const stored =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).timezone
      : undefined;
  const resolved = resolveTimeZone(null, typeof stored === "string" ? stored : null);
  return stored === resolved ? resolved : DEFAULT_TIMEZONE;
}

/** SELECT-only: takes no lock, advances no repeat and enqueues nothing. */
export async function readReminderSummary(
  db: DataContextDb,
  scope: ReminderSummaryScope = "upcoming",
  now = new Date()
): Promise<ReminderSummary> {
  assertDataContextDb(db);
  const timeZone = await readActorTimeZone(db);
  let query = db.db
    .selectFrom("app.chat_reminders")
    .select([
      "id",
      "reminder_text",
      "state",
      "context_state",
      "timing",
      "due_at",
      "deadline_at",
      "repeat_kind",
      "repeat_seconds",
      "destination_title",
      "delivered_at",
      "late",
      "created_at"
    ])
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`);
  const states = SCOPE_STATES[scope];
  if (states) query = query.where("state", "in", [...states]);
  const rows = await query
    .orderBy("due_at")
    .orderBy("id")
    .limit(REMINDER_SUMMARY_LIMIT + 1)
    .execute();
  const iso = (v: Date | string): string => new Date(v).toISOString();
  const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : iso(v));
  return boundReminderSummary({
    scope,
    timeZone,
    localDate: localDay(now, timeZone),
    retrievedAt: now.toISOString(),
    truncated: rows.length > REMINDER_SUMMARY_LIMIT,
    items: rows.slice(0, REMINDER_SUMMARY_LIMIT).map((row) => {
      const repeat: ReminderSummaryRepeat | null =
        row.repeat_kind === null
          ? null
          : row.repeat_kind === "interval"
            ? { kind: "interval", seconds: row.repeat_seconds ?? 0 }
            : { kind: row.repeat_kind };
      return {
        id: row.id,
        text: row.reminder_text,
        state: row.state,
        contextState: row.context_state,
        timing: row.timing,
        dueAt: iso(row.due_at),
        dueLocalDay: localDay(row.due_at, timeZone),
        deadlineAt: isoOrNull(row.deadline_at),
        repeat,
        destinationTitle: row.destination_title,
        deliveredAt: isoOrNull(row.delivered_at),
        late: row.late,
        createdAt: iso(row.created_at)
      };
    })
  });
}
