import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";

import type { MemoryEntityRecord, MemoryFactRecord, MemorySourceSummary } from "./graph-types.js";
import type { EntityRow, FactRow, MemoryGraphRepository, SourceRow } from "./graph-repository.js";
import { mapEntity, mapFact, mapSource } from "./graph-repository.js";

export class MemoryGraphDashboardRepository {
  constructor(private readonly graphRepo: MemoryGraphRepository) {}

  async listFactsForDashboard(
    scopedDb: DataContextDb,
    ownerUserId: string,
    opts: {
      readonly statuses?: readonly string[];
      readonly recordKind?: string;
      readonly limit: number;
      readonly cursor?: string;
    }
  ): Promise<{ items: MemoryFactRecord[]; nextCursor?: string }> {
    assertDataContextDb(scopedDb);
    const statuses = opts.statuses ?? ["active", "stale", "conflicting"];
    const fetchLimit = opts.limit + 1;
    const result = await sql<FactRow>`
      SELECT *
      FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND status = ANY(${statuses}::text[])
        AND (${opts.recordKind ?? null}::text IS NULL OR record_kind = ${opts.recordKind ?? null}::text)
        AND (${opts.cursor ?? null}::uuid IS NULL OR id < ${opts.cursor ?? null}::uuid)
      ORDER BY
        CASE WHEN status = 'conflicting' THEN 0
             WHEN status = 'stale' THEN 1
             ELSE 2 END ASC,
        pinned DESC,
        importance DESC,
        updated_at DESC,
        id DESC
      LIMIT ${fetchLimit}
    `.execute(scopedDb.db);

    const rows = await Promise.all(
      result.rows.map(async (row) =>
        mapFact(row, await listSourcesForFact(scopedDb, ownerUserId, row.id))
      )
    );
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id : undefined
    };
  }

  async countFactsByStatus(
    scopedDb: DataContextDb,
    ownerUserId: string
  ): Promise<Record<string, number>> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ status: string; cnt: string }>`
      SELECT status, COUNT(*) AS cnt
      FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid
      GROUP BY status
    `.execute(scopedDb.db);
    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      counts[row.status] = Number(row.cnt);
    }
    return counts;
  }

  async patchFactLifecycle(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string,
    patch: {
      readonly validFrom?: string | null;
      readonly validTo?: string | null;
      readonly staleAt?: string | null;
      readonly pinned?: boolean;
    }
  ): Promise<MemoryFactRecord | undefined> {
    assertDataContextDb(scopedDb);
    const result = await sql<FactRow>`
      UPDATE app.memory_facts
      SET
        valid_from  = CASE WHEN ${patch.validFrom !== undefined}  THEN ${patch.validFrom ?? null}::timestamptz ELSE valid_from  END,
        valid_to    = CASE WHEN ${patch.validTo !== undefined}  THEN ${patch.validTo ?? null}::timestamptz ELSE valid_to    END,
        stale_at    = CASE WHEN ${patch.staleAt !== undefined}  THEN ${patch.staleAt ?? null}::timestamptz ELSE stale_at    END,
        pinned      = CASE WHEN ${patch.pinned !== undefined}  THEN ${patch.pinned ?? false}             ELSE pinned      END,
        updated_at  = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
      RETURNING *
    `.execute(scopedDb.db);

    const row = result.rows[0];
    if (!row) return undefined;

    const newStatus: "active" | "inactive" =
      patch.validTo != null && new Date(patch.validTo) <= new Date() ? "inactive" : "active";
    await this.graphRepo.setSearchDocumentStatus(scopedDb, ownerUserId, "fact", factId, newStatus);

    return mapFact(row, await listSourcesForFact(scopedDb, ownerUserId, row.id));
  }

  async updateEntity(
    scopedDb: DataContextDb,
    ownerUserId: string,
    entityId: string,
    patch: {
      readonly name?: string;
      readonly summary?: string | null;
      readonly status?: "active" | "archived";
    }
  ): Promise<MemoryEntityRecord | undefined> {
    assertDataContextDb(scopedDb);

    if (patch.status === "archived") {
      const activeFactCount = await sql<{ cnt: string }>`
        SELECT COUNT(*) AS cnt
        FROM app.memory_facts
        WHERE owner_user_id = ${ownerUserId}::uuid
          AND (subject_entity_id = ${entityId}::uuid OR object_entity_id = ${entityId}::uuid)
          AND status = 'active'
      `.execute(scopedDb.db);
      if (Number(activeFactCount.rows[0]?.cnt ?? 0) > 0) {
        throw Object.assign(new Error("entity has active facts"), {
          code: "ENTITY_HAS_ACTIVE_FACTS"
        });
      }
    }

    const result = await sql<EntityRow>`
      UPDATE app.memory_entities
      SET
        name       = CASE WHEN ${patch.name !== undefined}    THEN ${patch.name ?? ""}   ELSE name    END,
        summary    = CASE WHEN ${patch.summary !== undefined} THEN ${patch.summary ?? ""}   ELSE summary END,
        status     = CASE WHEN ${patch.status !== undefined}  THEN ${patch.status ?? "active"} ELSE status  END,
        updated_at = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${entityId}::uuid
      RETURNING *
    `.execute(scopedDb.db);

    return result.rows[0] ? mapEntity(result.rows[0]) : undefined;
  }

  async forgetEntity(
    scopedDb: DataContextDb,
    ownerUserId: string,
    entityId: string
  ): Promise<{ deleted: boolean; blockedByFacts: boolean }> {
    assertDataContextDb(scopedDb);

    const entityKindResult = await sql<{ kind: string }>`
      SELECT kind FROM app.memory_entities
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${entityId}::uuid
    `.execute(scopedDb.db);
    if (entityKindResult.rows[0]?.kind === "self") {
      throw Object.assign(new Error("Cannot delete the self entity"), {
        code: "SELF_ENTITY_PROTECTED"
      });
    }

    const factCount = await sql<{ cnt: string }>`
      SELECT COUNT(*) AS cnt
      FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND (subject_entity_id = ${entityId}::uuid OR object_entity_id = ${entityId}::uuid)
    `.execute(scopedDb.db);

    if (Number(factCount.rows[0]?.cnt ?? 0) > 0) {
      return { deleted: false, blockedByFacts: true };
    }

    await this.graphRepo.deactivateSearchDocument(scopedDb, ownerUserId, "entity", entityId);
    const result = await sql<{ id: string }>`
      DELETE FROM app.memory_entities
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${entityId}::uuid
      RETURNING id
    `.execute(scopedDb.db);
    return { deleted: result.rows.length > 0, blockedByFacts: false };
  }

  async forgetFactWithConflictCleanup(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string
  ): Promise<{ deleted: boolean }> {
    assertDataContextDb(scopedDb);

    const existingResult = await sql<{ id: string; conflict_group_id: string | null }>`
      SELECT id, conflict_group_id
      FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
    `.execute(scopedDb.db);
    const existing = existingResult.rows[0];
    if (!existing) return { deleted: false };

    if (existing.conflict_group_id) {
      const siblings = await sql<{ id: string }>`
        SELECT id
        FROM app.memory_facts
        WHERE owner_user_id = ${ownerUserId}::uuid
          AND conflict_group_id = ${existing.conflict_group_id}::uuid
          AND id <> ${factId}::uuid
          AND status = 'conflicting'
      `.execute(scopedDb.db);

      if (siblings.rows.length === 1) {
        const sibling = siblings.rows[0];
        if (sibling) {
          await sql`
            UPDATE app.memory_facts
            SET conflict_group_id = NULL,
                status = 'active',
                updated_at = now()
            WHERE owner_user_id = ${ownerUserId}::uuid
              AND id = ${sibling.id}::uuid
          `.execute(scopedDb.db);
          await sql`
            UPDATE app.memory_conflict_groups
            SET status = 'resolved', resolved_at = now()
            WHERE owner_user_id = ${ownerUserId}::uuid
              AND id = ${existing.conflict_group_id}::uuid
          `.execute(scopedDb.db);
          await this.graphRepo.setSearchDocumentStatus(
            scopedDb,
            ownerUserId,
            "fact",
            sibling.id,
            "active"
          );
        }
      }
    }

    await this.graphRepo.deactivateSearchDocument(scopedDb, ownerUserId, "fact", factId);
    const result = await sql<{ id: string }>`
      DELETE FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
      RETURNING id
    `.execute(scopedDb.db);
    return { deleted: result.rows.length > 0 };
  }
}

async function listSourcesForFact(
  scopedDb: DataContextDb,
  ownerUserId: string,
  factId: string
): Promise<MemorySourceSummary[]> {
  const result = await sql<SourceRow>`
    SELECT e.id, e.source_kind, e.source_ref, e.source_label, e.occurred_at, e.excerpt
    FROM app.memory_episodes e
    JOIN app.memory_fact_sources s
      ON s.owner_user_id = e.owner_user_id
     AND s.episode_id = e.id
    WHERE s.owner_user_id = ${ownerUserId}::uuid
      AND s.fact_id = ${factId}::uuid
    ORDER BY e.occurred_at DESC NULLS LAST, e.created_at DESC
  `.execute(scopedDb.db);
  return result.rows.map(mapSource);
}
