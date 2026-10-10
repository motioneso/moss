import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ProactiveCardDto, ProactiveCardStatus } from "@moss/shared";

import type { ProactiveCardRow } from "./types.js";

interface UpsertCardInput {
  readonly ownerUserId: string;
  readonly source: string;
  readonly stableKey: string;
  readonly sourceRefHash: string;
  readonly title: string;
  readonly summary: string;
  readonly signalType: string;
  readonly priorityBand: "critical" | "high" | "normal" | "low";
  readonly priorityReasons: readonly string[];
  readonly occurredAt?: string | null;
  readonly targetAt?: string | null;
  readonly expiresAt?: string | null;
  readonly deferredUntil?: string | null;
  readonly metadata?: Record<string, unknown>;
}

interface ActiveCountsRow {
  readonly total_today: string;
  readonly source_today: string;
  readonly source_last_hour: string;
}

export class CardRepository {
  async upsertCard(scopedDb: DataContextDb, input: UpsertCardInput): Promise<ProactiveCardRow> {
    assertDataContextDb(scopedDb);
    const result = await sql<ProactiveCardRow>`
      INSERT INTO app.proactive_cards (
        owner_user_id, source, stable_key, source_ref_hash,
        title, summary, signal_type,
        priority_band, priority_reasons,
        occurred_at, target_at, expires_at, deferred_until,
        metadata_json, first_seen_at, last_seen_at
      ) VALUES (
        ${input.ownerUserId}::uuid, ${input.source}, ${input.stableKey}, ${input.sourceRefHash},
        ${input.title}, ${input.summary}, ${input.signalType},
        ${input.priorityBand}, ${JSON.stringify(input.priorityReasons)}::jsonb,
        ${input.occurredAt ?? null}::timestamptz,
        ${input.targetAt ?? null}::timestamptz,
        ${input.expiresAt ?? null}::timestamptz,
        ${input.deferredUntil ?? null}::timestamptz,
        ${JSON.stringify(input.metadata ?? {})}::jsonb,
        now(), now()
      )
      ON CONFLICT (owner_user_id, source, stable_key)
        WHERE status NOT IN ('dismissed', 'expired', 'suppressed')
      DO UPDATE SET
        source_ref_hash = EXCLUDED.source_ref_hash,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        priority_band = EXCLUDED.priority_band,
        priority_reasons = EXCLUDED.priority_reasons,
        occurred_at = EXCLUDED.occurred_at,
        target_at = EXCLUDED.target_at,
        expires_at = EXCLUDED.expires_at,
        last_seen_at = now(),
        updated_at = now()
      RETURNING *
    `.execute(scopedDb.db);
    const row = result.rows[0];
    if (!row) throw new Error("proactive_cards upsert returned no row");
    return row;
  }

  async listActive(
    scopedDb: DataContextDb,
    ownerUserId: string,
    limit = 5
  ): Promise<ProactiveCardRow[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<ProactiveCardRow>`
      SELECT * FROM app.proactive_cards
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND status = 'active'
        AND (deferred_until IS NULL OR deferred_until <= now())
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY
        CASE priority_band
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'normal' THEN 2
          ELSE 3
        END,
        COALESCE(target_at, last_seen_at) ASC
      LIMIT ${limit}
    `.execute(scopedDb.db);
    return result.rows;
  }

  async findByStableKey(
    scopedDb: DataContextDb,
    ownerUserId: string,
    source: string,
    stableKey: string
  ): Promise<ProactiveCardRow | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.proactive_cards")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId)
      .where("source", "=", source)
      .where("stable_key", "=", stableKey)
      .executeTakeFirst() as Promise<ProactiveCardRow | undefined>;
  }

  async findById(
    scopedDb: DataContextDb,
    ownerUserId: string,
    id: string
  ): Promise<ProactiveCardRow | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.proactive_cards")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId)
      .where("id", "=", id)
      .executeTakeFirst() as Promise<ProactiveCardRow | undefined>;
  }

  async markDismissed(
    scopedDb: DataContextDb,
    ownerUserId: string,
    id: string
  ): Promise<ProactiveCardRow | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .updateTable("app.proactive_cards")
      .set({ status: "dismissed", dismissed_at: new Date(), updated_at: new Date() })
      .where("owner_user_id", "=", ownerUserId)
      .where("id", "=", id)
      .where("status", "!=", "dismissed")
      .returningAll()
      .executeTakeFirst() as Promise<ProactiveCardRow | undefined>;
  }

  async reactivate(
    scopedDb: DataContextDb,
    ownerUserId: string,
    id: string
  ): Promise<ProactiveCardRow | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .updateTable("app.proactive_cards")
      .set({ status: "active", dismissed_at: null, updated_at: new Date() })
      .where("owner_user_id", "=", ownerUserId)
      .where("id", "=", id)
      .where("status", "=", "dismissed")
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]))
      .returningAll()
      .executeTakeFirst() as Promise<ProactiveCardRow | undefined>;
  }

  async getActiveCounts(
    scopedDb: DataContextDb,
    ownerUserId: string,
    source: string,
    nowIso: string,
    localDayStartIso: string
  ): Promise<{ totalToday: number; sourceToday: number; sourceLastHour: number }> {
    assertDataContextDb(scopedDb);
    const result = await sql<ActiveCountsRow>`
      SELECT
        COUNT(*) FILTER (
          WHERE status = 'active'
            AND owner_user_id = ${ownerUserId}::uuid
            AND COALESCE(deferred_until, created_at) >= ${localDayStartIso}::timestamptz
            AND (deferred_until IS NULL OR deferred_until <= ${nowIso}::timestamptz OR status = 'active')
        ) AS total_today,
        COUNT(*) FILTER (
          WHERE status = 'active'
            AND owner_user_id = ${ownerUserId}::uuid
            AND source = ${source}
            AND COALESCE(deferred_until, created_at) >= ${localDayStartIso}::timestamptz
        ) AS source_today,
        COUNT(*) FILTER (
          WHERE status = 'active'
            AND owner_user_id = ${ownerUserId}::uuid
            AND source = ${source}
            AND COALESCE(deferred_until, created_at) >= (${nowIso}::timestamptz - interval '1 hour')
        ) AS source_last_hour
      FROM app.proactive_cards
    `.execute(scopedDb.db);
    const row = result.rows[0];
    return {
      totalToday: parseInt(row?.total_today ?? "0", 10),
      sourceToday: parseInt(row?.source_today ?? "0", 10),
      sourceLastHour: parseInt(row?.source_last_hour ?? "0", 10)
    };
  }

  async isDismissedStableKeySuppressed(
    scopedDb: DataContextDb,
    ownerUserId: string,
    source: string,
    stableKey: string
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ count: string }>`
      SELECT COUNT(*) AS count
      FROM app.proactive_cards
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND source = ${source}
        AND stable_key = ${stableKey}
        AND status = 'dismissed'
        AND dismissed_at >= now() - interval '30 days'
    `.execute(scopedDb.db);
    return parseInt(result.rows[0]?.count ?? "0", 10) > 0;
  }
}

export function serializeCard(row: ProactiveCardRow): ProactiveCardDto {
  return {
    id: row.id,
    source: row.source as ProactiveCardDto["source"],
    stableKey: row.stable_key,
    title: row.title,
    summary: row.summary,
    signalType: row.signal_type,
    priorityBand: row.priority_band as ProactiveCardDto["priorityBand"],
    priorityReasons: row.priority_reasons,
    status: row.status as ProactiveCardStatus,
    occurredAt: row.occurred_at ? toIso(row.occurred_at) : null,
    targetAt: row.target_at ? toIso(row.target_at) : null,
    deferredUntil: row.deferred_until ? toIso(row.deferred_until) : null,
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
    createdAt: toIso(row.created_at)
  };
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}
