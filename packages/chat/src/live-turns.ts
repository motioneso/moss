import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ChatAttachmentDto } from "@moss/shared";

/**
 * #3128: identifies this API process. Only the process that wrote a live-turn row can save its
 * reply, so a row from any other boot is treated as interrupted. This assumes one API process
 * per database; a second process can mark a reply still running elsewhere, and that reply's save
 * then lands after the note.
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
      // pg sends a bare JS array as a Postgres array literal, so encode the list as JSON.
      attachments: sql<ChatAttachmentDto[]>`${JSON.stringify(turn.attachments ?? [])}::jsonb`
    })
    .execute();
}

/** Drops a live-turn row; a missing row is a no-op. */
export async function deleteLiveTurn(scopedDb: DataContextDb, turnId: string): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db.deleteFrom("app.chat_live_turns").where("turn_id", "=", turnId).execute();
}

export interface ClaimedLiveTurn {
  readonly turn_id: string;
  readonly thread_id: string;
  readonly user_text: string;
  readonly attachments: ChatAttachmentDto[];
  readonly started_at: Date;
}

const CLAIMED_COLUMNS = ["turn_id", "thread_id", "user_text", "attachments", "started_at"] as const;

/** Whether this thread holds a live-turn row from another boot. Lets readers skip the locks. */
export async function hasStaleLiveTurns(
  scopedDb: DataContextDb,
  threadId: string,
  bootId: string
): Promise<boolean> {
  assertDataContextDb(scopedDb);
  const row = await scopedDb.db
    .selectFrom("app.chat_live_turns")
    .select("turn_id")
    .where("thread_id", "=", threadId)
    .where("boot_id", "<>", bootId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Claims every live-turn row in this thread that another boot left behind. The delete is the
 * claim, so concurrent readers each convert a row at most once.
 */
export async function claimStaleLiveTurns(
  scopedDb: DataContextDb,
  threadId: string,
  bootId: string
): Promise<ClaimedLiveTurn[]> {
  assertDataContextDb(scopedDb);
  return scopedDb.db
    .deleteFrom("app.chat_live_turns")
    .where("thread_id", "=", threadId)
    .where("boot_id", "<>", bootId)
    .returning(CLAIMED_COLUMNS)
    .execute();
}

/** Claims one live-turn row by id. */
export async function claimLiveTurn(
  scopedDb: DataContextDb,
  threadId: string,
  turnId: string
): Promise<ClaimedLiveTurn[]> {
  assertDataContextDb(scopedDb);
  return scopedDb.db
    .deleteFrom("app.chat_live_turns")
    .where("thread_id", "=", threadId)
    .where("turn_id", "=", turnId)
    .returning(CLAIMED_COLUMNS)
    .execute();
}
