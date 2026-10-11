import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { AdmissionPath, ConversationProvenancePort } from "@moss/ai";
import { assertDataContextDb, isUuid, type DataContextDb, type DataContextRunner } from "@moss/db";

const admissionUnavailable = "Conversation is unavailable for content admission";

/** Durable conversation state, always read using the token-bound thread and actor. */
export class ConversationProvenanceStore implements ConversationProvenancePort {
  constructor(private readonly dataContext: Pick<DataContextRunner, "withDataContext">) {}

  async isTainted(actorUserId: string, threadId: string | undefined): Promise<boolean> {
    if (!threadId || !isUuid(threadId)) return true;

    return this.dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
      const row = await this.ownedProvenance(scopedDb, actorUserId, threadId)
        .select((eb) =>
          eb
            .exists(
              eb
                .selectFrom("app.chat_automatic_action_reservations")
                .select("thread_id")
                .where("thread_id", "=", threadId)
            )
            .as("reserved")
        )
        .executeTakeFirst();
      // Missing history and unfinished automatic work never establish clean authority.
      return !row || row.tainted_at !== null || Boolean(row.reserved);
    });
  }

  async isMarked(actorUserId: string, threadId: string | undefined): Promise<boolean> {
    if (!threadId || !isUuid(threadId)) return false;

    return this.dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
      const row = await this.ownedProvenance(scopedDb, actorUserId, threadId).executeTakeFirst();
      if (!row || row.tainted_at === null) return false;
      return !(await this.hasReservation(scopedDb, threadId));
    });
  }

  async runAutomatic<T>(
    actorUserId: string,
    threadId: string | undefined,
    run: () => Promise<T>
  ): Promise<{ kind: "ran"; value: T } | { kind: "confirm" }> {
    if (!threadId || !isUuid(threadId)) return { kind: "confirm" };
    const reservationId = randomUUID();
    let acquired: boolean;
    try {
      acquired = await this.dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
        const row = await this.ownedProvenance(scopedDb, actorUserId, threadId)
          .forUpdate("provenance")
          .executeTakeFirst();
        if (!row || row.tainted_at !== null) return false;
        if (await this.hasReservation(scopedDb, threadId)) return false;
        await scopedDb.db
          .insertInto("app.chat_automatic_action_reservations")
          .values({
            thread_id: threadId,
            owner_user_id: actorUserId,
            reservation_id: reservationId
          })
          .execute();
        return true;
      });
    } catch {
      // Only failure to acquire may fall back to confirmation. A failed commit may
      // leave an uncertain reservation; retaining it is deliberately fail-closed.
      return { kind: "confirm" };
    }
    if (!acquired) return { kind: "confirm" };

    // withDataContext has committed and returned its connection before invoking
    // application code. The callback may acquire another transaction, even in a
    // single-connection pool. No timer, cancellation or startup path releases this.
    try {
      return { kind: "ran", value: await run() };
    } finally {
      // Wait for the actual callback to settle. Errors here propagate, never ask
      // for confirmation and never execute the callback a second time.
      await this.dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
        assertDataContextDb(scopedDb);
        await scopedDb.db
          .deleteFrom("app.chat_automatic_action_reservations")
          .where("thread_id", "=", threadId)
          .where("owner_user_id", "=", actorUserId)
          .where("reservation_id", "=", reservationId)
          .execute();
      });
    }
  }

  async recordAdmission(actorUserId: string, threadId: string, path: AdmissionPath): Promise<void> {
    await this.dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
      await this.ownedProvenance(scopedDb, actorUserId, threadId)
        .forUpdate("provenance")
        .executeTakeFirst();
      // This must be a separate statement after locking: a lock wait can outlive
      // the first statement's READ COMMITTED snapshot. Never expose content while
      // an automatic callback is active, including one left behind by a crash.
      if (await this.hasReservation(scopedDb, threadId)) throw new Error(admissionUnavailable);
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
      if (!row) throw new Error(admissionUnavailable);
    });
  }

  private ownedProvenance(scopedDb: DataContextDb, actorUserId: string, threadId: string) {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.chat_conversation_provenance as provenance")
      .innerJoin("app.chat_threads as thread", "thread.id", "provenance.thread_id")
      .select("provenance.tainted_at")
      .where("provenance.thread_id", "=", threadId)
      .where("provenance.owner_user_id", "=", actorUserId)
      .where("thread.owner_user_id", "=", actorUserId);
  }

  private async hasReservation(scopedDb: DataContextDb, threadId: string): Promise<boolean> {
    const reservation = await scopedDb.db
      .selectFrom("app.chat_automatic_action_reservations")
      .select("reservation_id")
      .where("thread_id", "=", threadId)
      .executeTakeFirst();
    return reservation !== undefined;
  }
}
