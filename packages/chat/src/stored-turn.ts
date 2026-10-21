import { sql } from "kysely";
import { assertDataContextDb, type ChatMessage, type DataContextDb } from "@moss/db";

/** Recover a saved pair by execution identity; a real reply outranks an interruption note. */
export async function findStoredChatTurn(
  scopedDb: DataContextDb,
  threadId: string,
  turnId: string
): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage } | undefined> {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.chat_messages")
    .selectAll()
    .where("thread_id", "=", threadId)
    .where(sql<boolean>`tool_metadata @> ${JSON.stringify({ turnId })}::jsonb`)
    .execute();
  const userMessage = rows.find((row) => row.role === "user");
  const assistants = rows.filter((row) => row.role === "assistant");
  const assistantMessage =
    assistants.find((row) => row.tool_metadata.interruptedTurn !== true) ?? assistants[0];
  return userMessage && assistantMessage ? { userMessage, assistantMessage } : undefined;
}
