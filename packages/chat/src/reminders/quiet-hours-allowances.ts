import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ListQuietHoursAllowancesResponse } from "@moss/shared";
import { lockNotificationDelivery } from "./repository.js";

export async function listQuietHoursAllowances(
  scopedDb: DataContextDb
): Promise<ListQuietHoursAllowancesResponse> {
  assertDataContextDb(scopedDb);
  const main = await scopedDb.db
    .selectFrom("app.chat_threads")
    .select("id")
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("is_main", "=", true)
    .where("incognito", "=", false)
    .executeTakeFirst();
  const allowances = await scopedDb.db
    .selectFrom("app.chat_reminder_quiet_allowances as allowance")
    .innerJoin("app.chat_reminders as reminder", "reminder.id", "allowance.reminder_id")
    .select(["reminder.id", "reminder.reminder_text as title"])
    .where("allowance.owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .orderBy("allowance.created_at")
    .orderBy("reminder.id")
    .execute();
  return { mainThreadId: main?.id ?? null, allowances };
}

export async function readQuietHoursProposal(scopedDb: DataContextDb, threadId: string) {
  assertDataContextDb(scopedDb);
  return scopedDb.db
    .selectFrom("app.chat_reminder_quiet_proposals")
    .selectAll()
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
}

export async function clearQuietHoursProposal(scopedDb: DataContextDb, threadId: string) {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .deleteFrom("app.chat_reminder_quiet_proposals")
    .where("thread_id", "=", threadId)
    .execute();
}

export async function readQuietHoursReminder(scopedDb: DataContextDb, reminderId: string) {
  assertDataContextDb(scopedDb);
  await lockNotificationDelivery(scopedDb, reminderId);
  return scopedDb.db
    .selectFrom("app.chat_reminders")
    .select(["id", "reminder_text", "version", "state", "context_state", "deadline_at"])
    .where("id", "=", reminderId)
    .executeTakeFirst();
}

export async function hasQuietHoursAllowance(scopedDb: DataContextDb, reminderId: string) {
  assertDataContextDb(scopedDb);
  return Boolean(
    await scopedDb.db
      .selectFrom("app.chat_reminder_quiet_allowances")
      .select("reminder_id")
      .where("reminder_id", "=", reminderId)
      .executeTakeFirst()
  );
}

export async function saveQuietHoursAllowance(
  scopedDb: DataContextDb,
  reminderId: string,
  allow: boolean,
  sourceMessageId: string
) {
  assertDataContextDb(scopedDb);
  if (allow) {
    await scopedDb.db
      .insertInto("app.chat_reminder_quiet_allowances")
      .values({
        reminder_id: reminderId,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        source_message_id: sourceMessageId
      })
      .onConflict((oc) => oc.column("reminder_id").doNothing())
      .execute();
  } else {
    await scopedDb.db
      .deleteFrom("app.chat_reminder_quiet_allowances")
      .where("reminder_id", "=", reminderId)
      .execute();
  }
}

export async function saveQuietHoursProposal(
  scopedDb: DataContextDb,
  input: {
    readonly threadId: string;
    readonly reminderId: string;
    readonly version: number;
    readonly allow: boolean;
    readonly sourceMessageId: string;
  }
) {
  assertDataContextDb(scopedDb);
  await clearQuietHoursProposal(scopedDb, input.threadId);
  await scopedDb.db
    .insertInto("app.chat_reminder_quiet_proposals")
    .values({
      thread_id: input.threadId,
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      reminder_id: input.reminderId,
      reminder_version: input.version,
      allow: input.allow,
      source_message_id: input.sourceMessageId
    })
    .execute();
}
