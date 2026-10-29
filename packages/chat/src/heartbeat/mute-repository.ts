import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { readChatHeartbeatOrigin, type HeartbeatMute, type HeartbeatSource } from "@moss/shared";

/** A published check-in item the owner can still point at, with the key a mute needs. */
export interface RecentHeartbeatItem {
  readonly findingId: string;
  readonly source: HeartbeatSource;
  readonly title: string;
  readonly entityKey: string | null;
}

export type NewHeartbeatMute =
  | {
      readonly scope: "item";
      readonly source: HeartbeatSource;
      readonly entityKey: string;
      readonly label: string;
    }
  | { readonly scope: "topic"; readonly topic: string; readonly label: string };

const RECENT_MESSAGE_LIMIT = 20;

export class HeartbeatMuteRepository {
  async list(scopedDb: DataContextDb): Promise<readonly HeartbeatMute[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.heartbeat_mutes")
      .select(["id", "label", "scope", "created_at"])
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      scope: row.scope,
      createdAt: row.created_at.toISOString()
    }));
  }

  /**
   * Items from the owner's latest check-in messages, newest first. Titles come from the saved
   * message origin and entity keys from the saved findings.
   */
  async recentItems(scopedDb: DataContextDb): Promise<readonly RecentHeartbeatItem[]> {
    assertDataContextDb(scopedDb);
    const messages = await scopedDb.db
      .selectFrom("app.chat_messages")
      .select("model_metadata")
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("role", "=", "assistant")
      .where(sql<string>`model_metadata->'origin'->>'kind'`, "=", "heartbeat")
      .orderBy("created_at", "desc")
      .limit(RECENT_MESSAGE_LIMIT)
      .execute();
    const origins = messages.flatMap((row) => {
      const origin = readChatHeartbeatOrigin(
        (row.model_metadata as Record<string, unknown> | null)?.origin
      );
      return origin ? [origin] : [];
    });
    if (origins.length === 0) return [];
    const findings = await scopedDb.db
      .selectFrom("app.heartbeat_findings")
      .select(["id", "source", "entity_key", "occurrence_id"])
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where(
        "occurrence_id",
        "in",
        origins.map((origin) => origin.occurrenceId)
      )
      .execute();
    const byId = new Map(findings.map((finding) => [finding.id, finding.entity_key]));
    return origins.flatMap((origin) =>
      origin.items.map((item) => ({
        findingId: item.findingId,
        source: item.source,
        title: item.title,
        entityKey: byId.get(item.findingId) ?? null
      }))
    );
  }

  /** Saves a mute, or returns the one that already covers the same item or topic. */
  async create(scopedDb: DataContextDb, input: NewHeartbeatMute): Promise<HeartbeatMute> {
    assertDataContextDb(scopedDb);
    const existing = await scopedDb.db
      .selectFrom("app.heartbeat_mutes")
      .select(["id", "label", "scope", "created_at"])
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("scope", "=", input.scope)
      .$call((query) =>
        input.scope === "item"
          ? query.where("source", "=", input.source).where("entity_key", "=", input.entityKey)
          : query.where("topic", "=", input.topic)
      )
      .executeTakeFirst();
    if (existing) {
      return {
        id: existing.id,
        label: existing.label,
        scope: existing.scope,
        createdAt: existing.created_at.toISOString()
      };
    }
    const row = await scopedDb.db
      .insertInto("app.heartbeat_mutes")
      .values({
        id: randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        scope: input.scope,
        source: input.scope === "item" ? input.source : null,
        entity_key: input.scope === "item" ? input.entityKey : null,
        topic: input.scope === "topic" ? input.topic : null,
        label: input.label
      })
      .returning(["id", "label", "scope", "created_at"])
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      label: row.label,
      scope: row.scope,
      createdAt: row.created_at.toISOString()
    };
  }

  /** True when a mute was removed. Another owner's mute is invisible under RLS and reads as absent. */
  async remove(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.heartbeat_mutes")
      .where("id", "=", id)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
