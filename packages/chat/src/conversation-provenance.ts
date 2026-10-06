import { sql } from "kysely";

import type { AdmissionPath, ConversationProvenancePort } from "@moss/ai";
import { assertDataContextDb, isUuid, type DataContextRunner } from "@moss/db";

/** Durable conversation state, always read using the token-bound thread and actor. */
export class ConversationProvenanceStore implements ConversationProvenancePort {
  constructor(private readonly dataContext: Pick<DataContextRunner, "withDataContext">) {}

  async isTainted(actorUserId: string, threadId: string | undefined): Promise<boolean> {
    if (!threadId || !isUuid(threadId)) return true;

    return this.dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
      assertDataContextDb(scopedDb);
      const row = await scopedDb.db
        .selectFrom("app.chat_conversation_provenance as provenance")
        .innerJoin("app.chat_threads as thread", "thread.id", "provenance.thread_id")
        .select("provenance.tainted_at")
        .where("provenance.thread_id", "=", threadId)
        .where("provenance.owner_user_id", "=", actorUserId)
        .where("thread.owner_user_id", "=", actorUserId)
        .executeTakeFirst();
      // No row is unknown history, never evidence that the conversation is clean.
      return row?.tainted_at !== null;
    });
  }

  async recordAdmission(actorUserId: string, threadId: string, path: AdmissionPath): Promise<void> {
    await this.dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
      assertDataContextDb(scopedDb);
      const row = await scopedDb.db
        .insertInto("app.chat_conversation_provenance")
        .columns(["thread_id", "owner_user_id", "tainted_at", "first_admission_path"])
        .expression((eb) =>
          eb
            .selectFrom("app.chat_threads")
            .select([
              "id as thread_id",
              "owner_user_id",
              sql<Date>`now()`.as("tainted_at"),
              sql<string>`${path}`.as("first_admission_path")
            ])
            .where("id", "=", threadId)
            .where("owner_user_id", "=", actorUserId)
        )
        .onConflict((conflict) =>
          conflict.column("thread_id").doUpdateSet({
            tainted_at: sql`coalesce(app.chat_conversation_provenance.tainted_at, excluded.tainted_at)`,
            first_admission_path: sql`coalesce(app.chat_conversation_provenance.first_admission_path, excluded.first_admission_path)`
          })
        )
        .returning("thread_id")
        .executeTakeFirst();
      if (!row) throw new Error("Conversation is unavailable for content admission");
    });
  }
}
