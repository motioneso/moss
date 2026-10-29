import type { RecordingFactLineage } from "./recording-fact-lineage.js";
import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { MemoryGraphRepository } from "./graph-repository.js";
import type {
  MemoryFactRecord,
  MemoryCorrectionInput,
  MemoryStatusPatchInput
} from "./graph-types.js";
import { type FactRow, mapFact } from "./graph-repository-utils.js";
import { listMemoryFactSources } from "./graph-fact-sources.js";

/** Owning fact transitions inside the graph repository's source admission scope. */
export class MemoryFactLifecycleRepository {
  constructor(
    private readonly graph: Pick<
      MemoryGraphRepository,
      | "createFact"
      | "createFactFromEpisode"
      | "deactivateSearchDocument"
      | "setSearchDocumentStatus"
    >,
    private readonly lineage: RecordingFactLineage
  ) {}

  async supersedeFact(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string,
    validTo: Date | null = new Date()
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ id: string }>`
      UPDATE app.memory_facts
      SET status = 'superseded',
          valid_to = ${validTo},
          updated_at = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
      RETURNING id
    `.execute(scopedDb.db);
    if (result.rows.length > 0) {
      await this.graph.deactivateSearchDocument(scopedDb, ownerUserId, "fact", factId);
    }
    return result.rows.length > 0;
  }

  async pinFact(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string,
    pinned: boolean
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ id: string }>`
      UPDATE app.memory_facts
      SET pinned = ${pinned}, updated_at = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
      RETURNING id
    `.execute(scopedDb.db);
    return result.rows.length > 0;
  }

  async confirmFact(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string
  ): Promise<MemoryFactRecord | undefined> {
    assertDataContextDb(scopedDb);
    const existing = await this.getFact(scopedDb, ownerUserId, factId);
    if (!existing) return undefined;

    if (existing.conflictGroupId) {
      const siblings = await this.affectedFacts(
        scopedDb,
        ownerUserId,
        existing.id,
        existing.conflictGroupId
      );
      await this.lineage.transfer(scopedDb, ownerUserId, siblings, factId, false);
      await sql`
        UPDATE app.memory_facts
        SET status = 'superseded',
            superseded_by_fact_id = ${factId}::uuid,
            valid_to = COALESCE(valid_to, now()),
            updated_at = now()
        WHERE owner_user_id = ${ownerUserId}::uuid
          AND conflict_group_id = ${existing.conflictGroupId}::uuid
          AND id <> ${factId}::uuid
      `.execute(scopedDb.db);
      await sql`
        UPDATE app.memory_conflict_groups
        SET status = 'resolved', resolved_at = now()
        WHERE owner_user_id = ${ownerUserId}::uuid
          AND id = ${existing.conflictGroupId}::uuid
      `.execute(scopedDb.db);
      await this.deactivateConflictGroupSearchDocuments(
        scopedDb,
        ownerUserId,
        existing.conflictGroupId,
        factId
      );
    }

    const result = await sql<FactRow>`
      UPDATE app.memory_facts
      SET provenance = 'confirmed',
          confidence = GREATEST(confidence, 0.90),
          status = 'active',
          conflict_group_id = NULL,
          last_confirmed_at = now(),
          updated_at = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
      RETURNING *
    `.execute(scopedDb.db);

    await this.graph.setSearchDocumentStatus(scopedDb, ownerUserId, "fact", factId, "active");
    return this.mapFactRow(scopedDb, ownerUserId, result.rows[0]);
  }

  async markFactStale(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string
  ): Promise<MemoryFactRecord | undefined> {
    return this.patchFactStatus(scopedDb, ownerUserId, factId, {
      status: "stale"
    });
  }

  async patchFactStatus(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string,
    input: MemoryStatusPatchInput
  ): Promise<MemoryFactRecord | undefined> {
    assertDataContextDb(scopedDb);
    const existing = await this.getFact(scopedDb, ownerUserId, factId);
    if (!existing) return undefined;
    if (existing.conflictGroupId) {
      throw new Error("conflict-group memory must be resolved with confirm or correct");
    }
    if (existing.supersededByFactId != null && input.status === "active") {
      throw Object.assign(
        new Error("Cannot reactivate a superseded memory record; create a new fact instead"),
        { code: "SUPERSEDED_REACTIVATION_BLOCKED" }
      );
    }

    const result = await sql<FactRow>`
      UPDATE app.memory_facts
      SET status = ${input.status},
          stale_at = CASE WHEN ${input.status} = 'stale' THEN now() ELSE stale_at END,
          valid_to = CASE WHEN ${input.status} = 'expired' THEN COALESCE(valid_to, now()) ELSE valid_to END,
          updated_at = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
      RETURNING *
    `.execute(scopedDb.db);

    await this.graph.setSearchDocumentStatus(
      scopedDb,
      ownerUserId,
      "fact",
      factId,
      input.status === "expired" || input.status === "rejected" ? "inactive" : "active"
    );
    return this.mapFactRow(scopedDb, ownerUserId, result.rows[0]);
  }

  async correctFact(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: MemoryCorrectionInput
  ): Promise<MemoryFactRecord | undefined> {
    assertDataContextDb(scopedDb);
    const existing = await this.getFact(scopedDb, ownerUserId, input.targetFactId);
    if (!existing) return undefined;

    const source = existing.sources[0];
    const corrected = {
      subjectEntityId: existing.subjectEntityId,
      predicate: existing.predicate,
      objectEntityId: null,
      objectText: input.replacementText,
      recordKind: existing.recordKind,
      confidence: Math.max(existing.confidence, 0.9),
      provenance: "confirmed" as const,
      importance: existing.importance,
      pinned: existing.pinned
    };
    const replacement = source
      ? await this.graph.createFactFromEpisode(scopedDb, ownerUserId, {
          ...corrected,
          episodeId: source.id
        })
      : await this.graph.createFact(scopedDb, ownerUserId, {
          ...corrected,
          source: {
            sourceKind: "manual",
            sourceRef: `memory:${existing.id}`,
            sourceLabel: "Memory correction",
            excerpt: ""
          }
        });

    // Retain the original episode identities, including every resolved conflict sibling.
    // Copying their display values into a new episode loses the original associations.
    await sql`
      INSERT INTO app.memory_fact_sources (owner_user_id, fact_id, episode_id)
      SELECT s.owner_user_id, ${replacement.id}::uuid, s.episode_id
      FROM app.memory_fact_sources s
      JOIN app.memory_facts f ON f.owner_user_id = s.owner_user_id AND f.id = s.fact_id
      WHERE s.owner_user_id = ${ownerUserId}::uuid
        AND (f.id = ${existing.id}::uuid
          OR (${existing.conflictGroupId}::uuid IS NOT NULL
            AND f.conflict_group_id = ${existing.conflictGroupId}::uuid))
      ON CONFLICT (owner_user_id, fact_id, episode_id) DO NOTHING
    `.execute(scopedDb.db);

    await this.lineage.transfer(
      scopedDb,
      ownerUserId,
      await this.affectedFacts(scopedDb, ownerUserId, existing.id, existing.conflictGroupId),
      replacement.id,
      true
    );
    if (existing.conflictGroupId) {
      await sql`
        UPDATE app.memory_facts
        SET status = 'superseded',
            superseded_by_fact_id = ${replacement.id}::uuid,
            valid_to = COALESCE(valid_to, now()),
            updated_at = now()
        WHERE owner_user_id = ${ownerUserId}::uuid
          AND conflict_group_id = ${existing.conflictGroupId}::uuid
      `.execute(scopedDb.db);
      await sql`
        UPDATE app.memory_conflict_groups
        SET status = 'resolved', resolved_at = now()
        WHERE owner_user_id = ${ownerUserId}::uuid
          AND id = ${existing.conflictGroupId}::uuid
      `.execute(scopedDb.db);
      await this.deactivateConflictGroupSearchDocuments(
        scopedDb,
        ownerUserId,
        existing.conflictGroupId,
        replacement.id
      );
    } else {
      await sql`
        UPDATE app.memory_facts
        SET status = 'superseded',
            superseded_by_fact_id = ${replacement.id}::uuid,
            valid_to = COALESCE(valid_to, now()),
            updated_at = now()
        WHERE owner_user_id = ${ownerUserId}::uuid
          AND id = ${existing.id}::uuid
      `.execute(scopedDb.db);
    }

    await this.graph.deactivateSearchDocument(scopedDb, ownerUserId, "fact", existing.id);
    return this.getFact(scopedDb, ownerUserId, replacement.id);
  }

  private async affectedFacts(
    db: DataContextDb,
    owner: string,
    id: string,
    group: string | null
  ): Promise<string[]> {
    const result = await sql<{ id: string }>`SELECT id FROM app.memory_facts
      WHERE owner_user_id = ${owner}::uuid AND (id = ${id}::uuid
        OR (${group}::uuid IS NOT NULL AND conflict_group_id = ${group}::uuid)) ORDER BY id`.execute(
      db.db
    );
    return result.rows.map((row) => row.id);
  }

  private async getFact(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string
  ): Promise<MemoryFactRecord | undefined> {
    const result = await sql<FactRow>`
      SELECT *
      FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
    `.execute(scopedDb.db);
    return this.mapFactRow(scopedDb, ownerUserId, result.rows[0]);
  }

  private async deactivateConflictGroupSearchDocuments(
    scopedDb: DataContextDb,
    ownerUserId: string,
    conflictGroupId: string,
    exceptFactId: string
  ): Promise<void> {
    await sql`
      UPDATE app.memory_search_documents
      SET status = 'inactive', updated_at = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND target_kind = 'fact'
        AND target_id IN (
          SELECT id
          FROM app.memory_facts
          WHERE owner_user_id = ${ownerUserId}::uuid
            AND conflict_group_id = ${conflictGroupId}::uuid
            AND id <> ${exceptFactId}::uuid
        )
    `.execute(scopedDb.db);
  }

  private async mapFactRow(
    scopedDb: DataContextDb,
    ownerUserId: string,
    row: FactRow | undefined
  ): Promise<MemoryFactRecord | undefined> {
    return row
      ? mapFact(row, await listMemoryFactSources(scopedDb, ownerUserId, row.id))
      : undefined;
  }
}
