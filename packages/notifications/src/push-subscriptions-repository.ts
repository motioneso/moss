import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb, type PushSubscription } from "@moss/db";

export type { PushSubscription };

const MAX_SUBSCRIPTIONS_PER_USER = 10;

export class PushSubscriptionLimitError extends Error {
  constructor() {
    super(`A user may register at most ${MAX_SUBSCRIPTIONS_PER_USER} push devices`);
    this.name = "PushSubscriptionLimitError";
  }
}

/**
 * All tables here are RLS-scoped to `app.current_actor_user_id()` (migration 0214), so
 * every method here is implicitly owner-scoped: the settings page reads/writes its own
 * user's rows, and the delivery worker (running in the recipient's data context) reads
 * and cleans up that same recipient's rows. No method takes an explicit owner id.
 */
export class PushSubscriptionsRepository {
  /** All of the current actor's registered devices, active and disabled alike. */
  async listForActor(scopedDb: DataContextDb): Promise<readonly PushSubscription[]> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.push_subscriptions")
      .selectAll()
      .orderBy("created_at", "asc")
      .execute();
  }

  /** Non-disabled devices only, for delivery fan-out. */
  async listActiveForActor(scopedDb: DataContextDb): Promise<readonly PushSubscription[]> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.push_subscriptions")
      .selectAll()
      .where("disabled_at", "is", null)
      .orderBy("created_at", "asc")
      .execute();
  }

  /**
   * Registers or re-registers a browser subscription for the current actor. Re-registering
   * an existing endpoint (the browser's `PushSubscription` never changes for the life of a
   * service worker registration, but this call is also the recovery path after a delivery
   * failure disabled the row) clears `disabled_at` and resets `failure_count`.
   */
  async upsert(
    scopedDb: DataContextDb,
    input: {
      readonly endpoint: string;
      readonly p256dh: string;
      readonly auth: string;
      readonly userAgentLabel: string | null;
    }
  ): Promise<PushSubscription> {
    assertDataContextDb(scopedDb);

    const existingCount = await scopedDb.db
      .selectFrom("app.push_subscriptions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("endpoint", "!=", input.endpoint)
      .executeTakeFirst();

    if (existingCount && Number(existingCount.count) >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw new PushSubscriptionLimitError();
    }

    const rows = await sql<PushSubscription>`
      INSERT INTO app.push_subscriptions (
        owner_user_id, endpoint, p256dh, auth, user_agent_label
      )
      VALUES (
        app.current_actor_user_id(),
        ${input.endpoint},
        ${input.p256dh},
        ${input.auth},
        ${input.userAgentLabel}
      )
      ON CONFLICT (owner_user_id, endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent_label = excluded.user_agent_label,
        disabled_at = NULL,
        failure_count = 0
      RETURNING *
    `.execute(scopedDb.db);

    const row = rows.rows[0];
    if (!row) throw new Error("push subscription upsert returned no row");
    return row;
  }

  /** Owner-only delete; returns whether a row was removed. */
  async delete(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.push_subscriptions")
      .where("id", "=", id)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  async recordDeliverySuccess(scopedDb: DataContextDb, id: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.push_subscriptions")
      .set({ failure_count: 0, last_used_at: new Date() })
      .where("id", "=", id)
      .execute();
  }

  /** Fifth consecutive failure disables the row rather than deleting it (spec 5.2/5.4). */
  async recordDeliveryFailure(scopedDb: DataContextDb, id: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      UPDATE app.push_subscriptions
      SET failure_count = failure_count + 1,
          disabled_at = CASE WHEN failure_count + 1 >= 5 THEN now() ELSE disabled_at END
      WHERE id = ${id}
    `.execute(scopedDb.db);
  }
}
