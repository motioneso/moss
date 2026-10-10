import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { assertDataContextDb, type ChatMessage, type DataContextDb } from "@moss/db";
import type { ChatAttachmentDto } from "@moss/shared";

/**
 * #3128: identifies this API process. Engines never outlive the process that launched them,
 * so a live-turn row from any other boot belongs to a reply that can no longer finish.
 */
export const CHAT_PROCESS_BOOT_ID = randomUUID();

/** Assistant body stored in place of a reply an interruption cut off. */
export const INTERRUPTED_REPLY_TEXT =
  "Moss was interrupted before finishing this reply. Anything it started may not have " +
  "completed, so check before asking again.";

export interface LiveTurnStart {
  readonly turnId: string;
  readonly threadId: string;
  readonly bootId: string;
  readonly userText: string;
  readonly attachments?: readonly ChatAttachmentDto[];
}

/** Records a reply in flight. RLS refuses another owner's thread and any incognito thread. */
export async function insertLiveTurn(scopedDb: DataContextDb, turn: LiveTurnStart): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .insertInto("app.chat_live_turns")
    .values({
      turn_id: turn.turnId,
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      thread_id: turn.threadId,
      boot_id: turn.bootId,
      user_text: turn.userText,
      attachments: [...(turn.attachments ?? [])]
    })
    .execute();
}

/** Drops a live-turn row; a missing row is a no-op. */
export async function deleteLiveTurn(scopedDb: DataContextDb, turnId: string): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db.deleteFrom("app.chat_live_turns").where("turn_id", "=", turnId).execute();
}

/** The stored user and assistant rows of a completed turn, when this turn id already landed. */
export async function findStoredTurn(
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
  const assistantMessage = rows.find((row) => row.role === "assistant");
  return userMessage && assistantMessage ? { userMessage, assistantMessage } : undefined;
}

/**
 * Turns each claimed live-turn row into its stored question plus an interrupted note. The
 * delete claims the rows, so concurrent readers convert each one at most once. Nothing is
 * resubmitted: a tool the interrupted reply started may or may not have run.
 */
async function storeInterrupted(
  scopedDb: DataContextDb,
  claim: (scopedDb: DataContextDb) => Promise<readonly ClaimedLiveTurn[]>
): Promise<number> {
  const claimed = await claim(scopedDb);
  for (const turn of claimed) {
    const now = new Date();
    const base = {
      thread_id: turn.thread_id,
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      model_metadata: {},
      created_at: now,
      updated_at: now
    };
    await scopedDb.db
      .insertInto("app.chat_messages")
      .values([
        {
          ...base,
          id: randomUUID(),
          role: "user",
          status: "stored",
          body: turn.user_text,
          tool_metadata: {
            selectedTools: [],
            turnId: turn.turn_id,
            ...(turn.attachments.length > 0 ? { attachments: turn.attachments } : {})
          }
        },
        {
          ...base,
          id: randomUUID(),
          role: "assistant",
          status: "error",
          body: INTERRUPTED_REPLY_TEXT,
          tool_metadata: { selectedTools: [], turnId: turn.turn_id, interruptedTurn: true }
        }
      ])
      .execute();
  }
  return claimed.length;
}

interface ClaimedLiveTurn {
  readonly turn_id: string;
  readonly thread_id: string;
  readonly user_text: string;
  readonly attachments: unknown[];
}

/** Stores every reply in this thread that an earlier API boot left unfinished. */
export async function reconcileInterruptedTurns(
  scopedDb: DataContextDb,
  threadId: string,
  bootId: string = CHAT_PROCESS_BOOT_ID
): Promise<number> {
  assertDataContextDb(scopedDb);
  return storeInterrupted(scopedDb, (db) =>
    db.db
      .deleteFrom("app.chat_live_turns")
      .where("thread_id", "=", threadId)
      .where("boot_id", "<>", bootId)
      .returning(["turn_id", "thread_id", "user_text", "attachments"])
      .execute()
  );
}

/** Stores one reply that failed in this process after the model received it. */
export async function storeInterruptedTurn(
  scopedDb: DataContextDb,
  turnId: string
): Promise<boolean> {
  assertDataContextDb(scopedDb);
  const stored = await storeInterrupted(scopedDb, (db) =>
    db.db
      .deleteFrom("app.chat_live_turns")
      .where("turn_id", "=", turnId)
      .returning(["turn_id", "thread_id", "user_text", "attachments"])
      .execute()
  );
  return stored > 0;
}
