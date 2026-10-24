import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { storedVisualText } from "@moss/shared";
import { visibleChatMessage } from "./chat-message-visibility.js";
import { toIsoString } from "./memory-serializers.js";

export async function readArchiveMessages(
  scopedDb: DataContextDb,
  actorUserId: string,
  rangeStartUtcIso: string,
  rangeEndUtcIso: string
): Promise<
  Array<{
    threadId: string;
    threadTitle: string;
    threadFirstMessageAt: string;
    role: "user" | "assistant";
    body: string;
    createdAt: string;
  }>
> {
  assertDataContextDb(scopedDb);

  const rows = await scopedDb.db
    .selectFrom("app.chat_messages as m")
    .where(visibleChatMessage("m"))
    .innerJoin("app.chat_threads as t", "t.id", "m.thread_id")
    .select([
      "m.thread_id as threadId",
      "t.title as threadTitle",
      sql<Date>`min(m.created_at) over (partition by m.thread_id)`.as("threadFirstMessageAt"),
      "m.role as role",
      "m.body as body",
      "m.tool_metadata as toolMetadata",
      "m.created_at as createdAt"
    ])
    .where("t.incognito", "=", false)
    // Meeting-derived text is scoped evidence, not input to general chat archives or memory.
    .where("t.surface", "not like", "mtg-%")
    .where("m.owner_user_id", "=", actorUserId)
    .where("m.status", "=", "stored")
    .where("m.role", "in", ["user", "assistant"])
    .where("m.created_at", ">=", new Date(rangeStartUtcIso))
    .where("m.created_at", "<=", new Date(rangeEndUtcIso))
    .orderBy("threadFirstMessageAt")
    .orderBy("m.created_at")
    .orderBy(sql<number>`CASE WHEN m.role = 'user' THEN 0 ELSE 1 END`)
    .orderBy("m.id")
    .execute();

  return rows.map((row) => ({
    threadId: row.threadId,
    threadTitle: row.threadTitle,
    threadFirstMessageAt: toIsoString(row.threadFirstMessageAt),
    role: row.role as "user" | "assistant",
    body:
      row.role === "assistant"
        ? storedVisualText(row.body, row.toolMetadata.visualReplyV1)
        : row.body,
    createdAt: toIsoString(row.createdAt)
  }));
}
