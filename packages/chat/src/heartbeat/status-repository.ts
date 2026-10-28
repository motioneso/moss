import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { HeartbeatOutcomeKind, HeartbeatStatus } from "@moss/shared";

import { HEARTBEAT_RECENT_OCCURRENCES } from "./limits.js";
import type { ReadHeartbeatSettings } from "./settings-repository.js";

const FINISHED_OUTCOMES: ReadonlySet<string> = new Set([
  "quiet",
  "message",
  "held_allowance",
  "degraded",
  "failed"
]);

export class HeartbeatOccurrenceRepository {
  /** Records one check as started. Slice 3 adds the source reads and model call between the two. */
  async start(
    scopedDb: DataContextDb,
    input: { readonly id: string; readonly settingsRevision: number }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .insertInto("app.heartbeat_occurrences")
      .values({
        id: input.id,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        settings_revision: input.settingsRevision,
        started_at: new Date(),
        outcome: "running"
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }

  async finish(
    scopedDb: DataContextDb,
    input: {
      readonly id: string;
      readonly outcome: Exclude<HeartbeatOutcomeKind, "never" | "off">;
      readonly itemCount?: number;
    }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.heartbeat_occurrences")
      .set({ outcome: input.outcome, item_count: input.itemCount ?? 0, finished_at: new Date() })
      .where("id", "=", input.id)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("outcome", "=", "running")
      .execute();
  }

  async hasOccurrence(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.heartbeat_occurrences")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    return row !== undefined;
  }

  async status(
    scopedDb: DataContextDb,
    stored: ReadHeartbeatSettings | undefined
  ): Promise<HeartbeatStatus> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.heartbeat_occurrences")
      .select(["finished_at", "outcome", "item_count"])
      .where("finished_at", "is not", null)
      .orderBy("finished_at", "desc")
      .limit(HEARTBEAT_RECENT_OCCURRENCES)
      .execute();
    const recent = rows.flatMap((row) =>
      row.finished_at && FINISHED_OUTCOMES.has(row.outcome)
        ? [
            {
              at: row.finished_at.toISOString(),
              outcome: row.outcome as HeartbeatOutcomeKind,
              itemCount: row.item_count
            }
          ]
        : []
    );
    const latest = recent[0];
    const enabled = stored?.settings.enabled ?? true;
    return {
      lastCheckedAt: latest?.at ?? null,
      nextCheckAt: enabled && stored?.nextDueAt ? stored.nextDueAt.toISOString() : null,
      outcome: !enabled ? "off" : (latest?.outcome ?? "never"),
      unavailableSources: [],
      recent
    };
  }
}
