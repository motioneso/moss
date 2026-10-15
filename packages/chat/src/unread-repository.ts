import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ChatUnreadResponse } from "@moss/shared";

export class ChatUnreadRepository {
  async counts(scopedDb: DataContextDb): Promise<ChatUnreadResponse> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.chat_unread_messages as unread")
      .innerJoin("app.chat_threads as thread", "thread.id", "unread.thread_id")
      .whereRef("thread.owner_user_id", "=", "unread.owner_user_id")
      .where("thread.incognito", "=", false)
      .where("thread.surface", "=", "drawer")
      .select("unread.thread_id")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .groupBy("unread.thread_id")
      .execute();
    const unreadByThread = Object.fromEntries(
      rows.map((row) => [row.thread_id, Number(row.count)])
    );
    return {
      unreadCount: Object.values(unreadByThread).reduce((a, b) => a + b, 0),
      unreadByThread
    };
  }

  async markRead(scopedDb: DataContextDb, threadId: string, messageIds: readonly string[]) {
    assertDataContextDb(scopedDb);
    if (messageIds.length === 0) return;
    await scopedDb.db
      .deleteFrom("app.chat_unread_messages")
      .where("thread_id", "=", threadId)
      .where("message_id", "in", messageIds)
      .execute();
  }
}
