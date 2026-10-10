// #3309: storage for relative reminders. Row security and the table's triggers own every
// rule; this file only names the queries.

import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";

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
  readonly state: "queued" | "delivered";
  readonly version: number;
  readonly dueAt: Date;
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
        id: randomUUID(),
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

  /** The database clock, so the due check and the late flag never depend on worker clocks. */
  async now(scopedDb: DataContextDb): Promise<Date> {
    const result = await sql<{ now: Date }>`select now() as now`.execute(scopedDb.db);
    return new Date(result.rows[0]!.now);
  }
}
