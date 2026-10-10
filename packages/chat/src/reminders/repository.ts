// #3309: storage for relative reminders. Row security and the table's triggers own every
// rule; this file only names the queries.

import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import {
  assertDataContextDb,
  type ChatReminderContextState,
  type ChatReminderState,
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
}

export interface OwnedReminder {
  readonly id: string;
  readonly text: string;
  readonly state: ChatReminderState;
  readonly contextState: ChatReminderContextState;
  readonly dueAt: Date;
  readonly createdAt: Date;
}

const OWNED_COLUMNS = [
  "id",
  "reminder_text",
  "state",
  "context_state",
  "due_at",
  "created_at"
] as const;

function toOwned(row: {
  id: string;
  reminder_text: string;
  state: ChatReminderState;
  context_state: ChatReminderContextState;
  due_at: Date;
  created_at: Date;
}): OwnedReminder {
  return {
    id: row.id,
    text: row.reminder_text,
    state: row.state,
    contextState: row.context_state,
    dueAt: new Date(row.due_at),
    createdAt: new Date(row.created_at)
  };
}

export class ReminderRepository {
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
      readonly delaySeconds: number;
      readonly text: string;
    }
  ): Promise<SavedReminder> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .insertInto("app.chat_reminders")
      .values({
        id: input.id ?? randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        thread_id: input.threadId,
        source_message_id: input.sourceMessageId,
        reserved_message_id: randomUUID(),
        reminder_text: input.text,
        delay_seconds: input.delaySeconds
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
        "due_at"
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
      dueAt: new Date(row.due_at)
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
      .select(["reminder.reserved_message_id", "message.body"])
      .where("reminder.thread_id", "=", threadId)
      .where("reminder.owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("reminder.state", "=", "delivered")
      .where("reminder.context_state", "=", "pending")
      .where("thread.is_main", "=", true)
      .where("thread.incognito", "=", false)
      .orderBy("reminder.delivered_at")
      .orderBy("reminder.id")
      .limit(limit)
      .execute();
    return rows.map((row) => ({ reservedMessageId: row.reserved_message_id, body: row.body }));
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
      .where("state", "=", "queued")
      .executeTakeFirstOrThrow();
    if (result.numUpdatedRows !== 1n) throw new Error("chat reminder was not cancelled");
  }

  /** Frees the slot a delivered reminder holds while its context is still pending. */
  async dismissContext(scopedDb: DataContextDb, reminderId: string): Promise<void> {
    assertDataContextDb(scopedDb);
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
