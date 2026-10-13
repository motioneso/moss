import type { ReminderRepeat } from "@moss/shared";
// #3309, #3150: storage for chat reminders, set a time from now or at a local clock time. Row
// security, the table's checks and its triggers own the storage rules; this file only names the
// queries. A time the clocks show twice is refused by the turn, before it reaches storage.

import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import {
  assertDataContextDb,
  type ChatReminderContextState,
  type ChatReminderState,
  type ChatReminderTiming,
  type DataContextDb
} from "@moss/db";

export interface SavedReminder {
  readonly id: string;
  readonly version: number;
  readonly dueAt: Date;
}

export interface DueReminder {
  readonly id: string;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly reservedMessageId: string;
  readonly text: string;
  readonly state: ChatReminderState;
  readonly version: number;
  readonly dueAt: Date;
  readonly deadlineAt: Date | null;
  readonly repeat: ReminderRepeat | null;
  readonly localDue: string | null;
  readonly timeZone: string | null;
}

export interface OwnedReminder {
  readonly id: string;
  readonly text: string;
  readonly state: ChatReminderState;
  readonly contextState: ChatReminderContextState;
  readonly timing: ChatReminderTiming;
  readonly dueAt: Date;
  readonly deadlineAt: Date | null;
  readonly late: boolean | null;
  readonly createdAt: Date;
}

/** When a new reminder is due: a delay the database adds to its clock, or a local clock time. */
export type ReminderTimingInput = (
  | { readonly timing: "relative"; readonly delaySeconds: number }
  | {
      readonly timing: "local_clock";
      readonly dueAt: Date;
      readonly localDue: string;
      readonly timeZone: string;
      readonly deadlineAt: Date | null;
    }
) & { readonly repeat?: ReminderRepeat };

const OWNED_COLUMNS = [
  "id",
  "reminder_text",
  "state",
  "context_state",
  "timing",
  "due_at",
  "deadline_at",
  "late",
  "created_at"
] as const;

function toOwned(row: {
  id: string;
  reminder_text: string;
  state: ChatReminderState;
  context_state: ChatReminderContextState;
  timing: ChatReminderTiming;
  due_at: Date;
  deadline_at: Date | null;
  late: boolean | null;
  created_at: Date;
}): OwnedReminder {
  return {
    id: row.id,
    text: row.reminder_text,
    state: row.state,
    contextState: row.context_state,
    timing: row.timing,
    dueAt: new Date(row.due_at),
    deadlineAt: row.deadline_at === null ? null : new Date(row.deadline_at),
    late: row.late,
    createdAt: new Date(row.created_at)
  };
}

export class ReminderRepository {
  async readNotificationResult(scopedDb: DataContextDb, reminderId: string, messageId?: string) {
    assertDataContextDb(scopedDb);
    await lockNotificationDelivery(scopedDb, reminderId);
    if (messageId) {
      const run = await scopedDb.db
        .selectFrom("app.chat_reminder_runs as run")
        .innerJoin("app.chat_reminders as reminder", "reminder.id", "run.reminder_id")
        .innerJoin("app.chat_messages as message", (join) =>
          join
            .onRef("message.id", "=", "run.message_id")
            .onRef("message.owner_user_id", "=", "run.owner_user_id")
            .onRef("message.thread_id", "=", "reminder.thread_id")
        )
        .select(["run.owner_user_id", "run.version", "message.id", "message.body"])
        .where("run.reminder_id", "=", reminderId)
        .where("run.message_id", "=", messageId)
        .where("run.outcome", "=", "delivered")
        .where("run.context_state", "!=", "dismissed")
        .where("reminder.state", "in", ["queued", "delivered"])
        .where("message.role", "=", "assistant")
        .where("message.status", "=", "stored")
        .executeTakeFirst();
      if (run)
        return {
          ownerUserId: run.owner_user_id,
          version: run.version,
          messageId: run.id,
          body: run.body
        };
    }
    const row = await scopedDb.db
      .selectFrom("app.chat_reminders as reminder")
      .innerJoin("app.chat_messages as message", (join) =>
        join
          .onRef("message.id", "=", "reminder.reserved_message_id")
          .onRef("message.thread_id", "=", "reminder.thread_id")
          .onRef("message.owner_user_id", "=", "reminder.owner_user_id")
      )
      .select(["reminder.owner_user_id", "reminder.version", "message.id", "message.body"])
      .where("reminder.id", "=", reminderId)
      .where("reminder.state", "=", "delivered")
      .where("reminder.repeat_kind", "is", null)
      .where("reminder.context_state", "!=", "dismissed")
      .where("message.role", "=", "assistant")
      .where("message.status", "=", "stored")
      .executeTakeFirst();
    return (
      row && {
        ownerUserId: row.owner_user_id,
        version: row.version,
        messageId: row.id,
        body: row.body
      }
    );
  }

  /** Takes the owner's reminder lock for this transaction and counts the slots in use. */
  async openCountLocked(scopedDb: DataContextDb, ownerUserId: string): Promise<number> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ count: number }>`
      select app.chat_reminder_open_count_locked(${ownerUserId}::uuid) as count
    `.execute(scopedDb.db);
    return Number(result.rows[0]?.count ?? 0);
  }

  async create(
    scopedDb: DataContextDb,
    input: {
      readonly id?: string;
      readonly threadId: string;
      readonly sourceMessageId: string;
      readonly when: ReminderTimingInput;
      readonly text: string;
    }
  ): Promise<SavedReminder> {
    assertDataContextDb(scopedDb);
    const when = input.when;
    const row = await scopedDb.db
      .insertInto("app.chat_reminders")
      .values({
        id: input.id ?? randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        thread_id: input.threadId,
        source_message_id: input.sourceMessageId,
        reserved_message_id: randomUUID(),
        reminder_text: input.text,
        repeat_kind: when.repeat?.kind ?? null,
        repeat_seconds: when.repeat?.kind === "interval" ? when.repeat.seconds : null,
        ...(when.timing === "relative"
          ? { delay_seconds: when.delaySeconds }
          : {
              timing: "local_clock" as const,
              delay_seconds: null,
              due_at: when.dueAt,
              local_due: when.localDue,
              time_zone: when.timeZone,
              deadline_at: when.deadlineAt
            })
      })
      .returning(["id", "version", "due_at"])
      .executeTakeFirstOrThrow();
    return { id: row.id, version: row.version, dueAt: new Date(row.due_at) };
  }

  /** Locks one reminder row for delivery. Rows the actor cannot see come back undefined. */
  async lockForDelivery(
    scopedDb: DataContextDb,
    reminderId: string
  ): Promise<DueReminder | undefined> {
    assertDataContextDb(scopedDb);
    await lockNotificationDelivery(scopedDb, reminderId);
    const row = await scopedDb.db
      .selectFrom("app.chat_reminders")
      .select([
        "id",
        "owner_user_id",
        "thread_id",
        "reserved_message_id",
        "reminder_text",
        "state",
        "version",
        "due_at",
        "deadline_at",
        "repeat_kind",
        "repeat_seconds",
        "local_due",
        "time_zone"
      ])
      .where("id", "=", reminderId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      threadId: row.thread_id,
      reservedMessageId: row.reserved_message_id,
      text: row.reminder_text,
      state: row.state,
      version: row.version,
      dueAt: new Date(row.due_at),
      deadlineAt: row.deadline_at === null ? null : new Date(row.deadline_at),
      repeat: repeatFor(row),
      localDue: row.local_due,
      timeZone: row.time_zone
    };
  }

  async markDelivered(scopedDb: DataContextDb, reminderId: string, late: boolean): Promise<void> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .updateTable("app.chat_reminders")
      .set({ state: "delivered", delivered_at: sql<Date>`now()`, late })
      .where("id", "=", reminderId)
      .where("state", "=", "queued")
      .executeTakeFirstOrThrow();
    if (result.numUpdatedRows !== 1n) throw new Error("chat reminder was not marked delivered");
  }

  /** Ends an undeliverable reminder so it frees its slot. Failed reminders carry no message. */
  async markFailed(scopedDb: DataContextDb, reminderId: string): Promise<void> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .updateTable("app.chat_reminders")
      .set({ state: "failed" })
      .where("id", "=", reminderId)
      .where("state", "=", "queued")
      .executeTakeFirstOrThrow();
    if (result.numUpdatedRows !== 1n) throw new Error("chat reminder was not marked failed");
  }

  /** #3150: ends a reminder whose deadline passed before delivery. Nothing is posted. */
  async markExpired(scopedDb: DataContextDb, reminderId: string): Promise<void> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .updateTable("app.chat_reminders")
      .set({ state: "expired" })
      .where("id", "=", reminderId)
      .where("state", "=", "queued")
      .executeTakeFirstOrThrow();
    if (result.numUpdatedRows !== 1n) throw new Error("chat reminder was not marked expired");
  }

  /** Reads a row the delivery lock cannot see, because the worker may lock only queued rows. */
  async readState(
    scopedDb: DataContextDb,
    reminderId: string
  ): Promise<{ ownerUserId: string; state: string } | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.chat_reminders")
      .select(["owner_user_id", "state"])
      .where("id", "=", reminderId)
      .executeTakeFirst();
    return row && { ownerUserId: row.owner_user_id, state: row.state };
  }

  /**
   * #3311: delivered reminders whose context is pending in this exact Main chat, oldest first.
   * The body is the reserved assistant message the owner saw.
   */
  async listPendingMain(
    scopedDb: DataContextDb,
    threadId: string,
    limit: number
  ): Promise<readonly { reservedMessageId: string; body: string }[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.chat_reminders as reminder")
      .innerJoin("app.chat_threads as thread", "thread.id", "reminder.thread_id")
      .innerJoin("app.chat_messages as message", (join) =>
        join
          .onRef("message.id", "=", "reminder.reserved_message_id")
          .onRef("message.thread_id", "=", "reminder.thread_id")
      )
      .select(["reminder.reserved_message_id", "message.body", "reminder.delivered_at"])
      .where("reminder.thread_id", "=", threadId)
      .where("reminder.owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("reminder.state", "=", "delivered")
      .where("reminder.repeat_kind", "is", null)
      .where("reminder.context_state", "=", "pending")
      .where("thread.is_main", "=", true)
      .where("thread.incognito", "=", false)
      .orderBy("reminder.delivered_at")
      .orderBy("reminder.id")
      .limit(limit)
      .execute();
    const runs = await scopedDb.db
      .selectFrom("app.chat_reminder_runs as run")
      .innerJoin("app.chat_reminders as reminder", "reminder.id", "run.reminder_id")
      .innerJoin("app.chat_threads as thread", "thread.id", "reminder.thread_id")
      .innerJoin("app.chat_messages as message", (join) =>
        join
          .onRef("message.id", "=", "run.message_id")
          .onRef("message.thread_id", "=", "reminder.thread_id")
          .onRef("message.owner_user_id", "=", "run.owner_user_id")
      )
      .select(["message.id", "message.body", "run.at"])
      .where("reminder.thread_id", "=", threadId)
      .where("thread.is_main", "=", true)
      .where("thread.incognito", "=", false)
      .where("run.context_state", "=", "pending")
      .where("run.outcome", "=", "delivered")
      .where("reminder.state", "in", ["queued", "paused", "delivered"])
      .orderBy("run.at")
      .orderBy("run.id")
      .limit(limit)
      .execute();
    const seen = new Set<string>();
    return [
      ...rows.map((row) => ({
        reservedMessageId: row.reserved_message_id,
        body: row.body,
        at: new Date(row.delivered_at!).getTime()
      })),
      ...runs.map((row) => ({
        reservedMessageId: row.id,
        body: row.body,
        at: new Date(row.at).getTime()
      }))
    ]
      .sort((a, b) => a.at - b.at || a.reservedMessageId.localeCompare(b.reservedMessageId))
      .filter((row) => !seen.has(row.reservedMessageId) && !!seen.add(row.reservedMessageId))
      .slice(0, limit)
      .map(({ reservedMessageId, body }) => ({ reservedMessageId, body }));
  }

  /** #3311: acknowledges exactly the shown reminders that are still pending in this Main chat. */
  async acknowledgeMain(
    scopedDb: DataContextDb,
    threadId: string,
    reservedMessageIds: readonly string[]
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    if (reservedMessageIds.length === 0) return;
    await scopedDb.db
      .updateTable("app.chat_reminder_runs")
      .set({ context_state: "acknowledged" })
      .where("message_id", "in", [...reservedMessageIds])
      .where("context_state", "=", "pending")
      .where(
        "reminder_id",
        "in",
        scopedDb.db.selectFrom("app.chat_reminders").select("id").where("thread_id", "=", threadId)
      )
      .execute();
    await scopedDb.db
      .updateTable("app.chat_reminders")
      .set({ context_state: "acknowledged" })
      .where("thread_id", "=", threadId)
      .where("reserved_message_id", "in", [...reservedMessageIds])
      .where("state", "=", "delivered")
      .where("context_state", "=", "pending")
      .execute();
  }

  /** The actor's reminders, newest first. Row security limits them to the actor's own. */
  async listOwned(scopedDb: DataContextDb): Promise<OwnedReminder[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.chat_reminders")
      .select(OWNED_COLUMNS)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map(toOwned);
  }

  /**
   * Locks one of the actor's reminders for cancel. An in-flight delivery holds the same lock,
   * so this waits for it and then reads the delivery's result.
   */
  async lockForCancel(
    scopedDb: DataContextDb,
    reminderId: string
  ): Promise<OwnedReminder | undefined> {
    assertDataContextDb(scopedDb);
    await lockNotificationDelivery(scopedDb, reminderId);
    const row = await scopedDb.db
      .selectFrom("app.chat_reminders")
      .select(OWNED_COLUMNS)
      .where("id", "=", reminderId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .forUpdate()
      .executeTakeFirst();
    return row && toOwned(row);
  }

  async markCancelled(scopedDb: DataContextDb, reminderId: string): Promise<void> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .updateTable("app.chat_reminders")
      .set({ state: "cancelled" })
      .where("id", "=", reminderId)
      .where("state", "in", ["queued", "paused"])
      .executeTakeFirstOrThrow();
    if (result.numUpdatedRows !== 1n) throw new Error("chat reminder was not cancelled");
  }

  /** Frees the slot a delivered reminder holds while its context is still pending. */
  async dismissContext(scopedDb: DataContextDb, reminderId: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.chat_reminder_runs")
      .set({ context_state: "dismissed" })
      .where("reminder_id", "=", reminderId)
      .where("context_state", "=", "pending")
      .execute();
    const result = await scopedDb.db
      .updateTable("app.chat_reminders")
      .set({ context_state: "dismissed" })
      .where("id", "=", reminderId)
      .where("state", "=", "delivered")
      .where("context_state", "=", "pending")
      .executeTakeFirstOrThrow();
    if (result.numUpdatedRows !== 1n) throw new Error("chat reminder context was not dismissed");
  }

  /** The database clock, so the due check and the late flag never depend on worker clocks. */
  async now(scopedDb: DataContextDb): Promise<Date> {
    const result = await sql<{ now: Date }>`select now() as now`.execute(scopedDb.db);
    return new Date(result.rows[0]!.now);
  }
}

// Cancellation and outward delivery must see whichever commits first, even after chat delivery.
export async function lockNotificationDelivery(
  scopedDb: DataContextDb,
  reminderId: string
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(
    'reminder-notification:' || app.current_actor_user_id()::text || ':' || ${reminderId}, 0
  ))`.execute(scopedDb.db);
}

export function repeatFor(row: {
  readonly repeat_kind: "daily" | "weekly" | "interval" | null;
  readonly repeat_seconds: number | null;
}): ReminderRepeat | null {
  if (row.repeat_kind === null) return null;
  if (row.repeat_kind === "interval") {
    if (row.repeat_seconds === null) throw new Error("Missing reminder interval");
    return { kind: "interval", seconds: row.repeat_seconds };
  }
  return { kind: row.repeat_kind };
}
