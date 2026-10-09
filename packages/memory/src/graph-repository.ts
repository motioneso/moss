import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";

import type {
  MemoryAliasRecord,
  MemoryCorrectionInput,
  MemoryEntityRecord,
  MemoryFactRecallCandidate,
  MemoryFactPredicate,
  MemoryFactProvenance,
  MemoryFactRecord,
  MemoryRecordKind,
  MemorySearchDocumentRecord,
  MemorySearchTargetKind,
  MemoryStatusPatchInput,
  MemorySourceInput,
  MemorySourceSummary,
  NewMemoryEntity,
  NewMemoryFact
} from "./graph-types.js";
import {
  type EntityRow,
  type FactRow,
  type SourceRow,
  confidenceTier,
  mapEntity,
  mapFact,
  mapSource
} from "./graph-repository-utils.js";

export type { EntityRow, FactRow, SourceRow };
export { confidenceTier, mapEntity, mapFact, mapSource };

// All multi-write methods (confirmFact, correctFact, patchFactStatus) assume the caller
// provides a DataContextDb whose .db is already a Kysely Transaction — guaranteed by
// withDataContext (packages/db/src/data-context.ts). If any write in the method throws,
// the caller's transaction rolls back atomically. assertDataContextDb() enforces this seam.
export class MemoryGraphRepository {
  async ensureSelfEntity(
    scopedDb: DataContextDb,
    ownerUserId: string
  ): Promise<MemoryEntityRecord> {
    assertDataContextDb(scopedDb);
    await sql`
      INSERT INTO app.memory_entities (owner_user_id, kind, name, summary)
      VALUES (${ownerUserId}::uuid, 'self', 'Self', 'Owner self memory root')
      ON CONFLICT (owner_user_id) WHERE kind = 'self' DO NOTHING
    `.execute(scopedDb.db);

    const result = await sql<EntityRow>`
      SELECT *
      FROM app.memory_entities
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND kind = 'self'
    `.execute(scopedDb.db);

    const row = result.rows[0];
    if (!row) throw new Error("self memory entity was not created");
    return mapEntity(row);
  }

  async createEntity(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: NewMemoryEntity
  ): Promise<MemoryEntityRecord> {
    assertDataContextDb(scopedDb);
    const result = await sql<EntityRow>`
      INSERT INTO app.memory_entities (
        owner_user_id,
        kind,
        name,
        summary,
        importance,
        pinned
      )
      VALUES (
        ${ownerUserId}::uuid,
        ${input.kind},
        ${input.name},
        ${input.summary ?? ""},
        ${input.importance ?? 0.5},
        ${input.pinned ?? false}
      )
      RETURNING *
    `.execute(scopedDb.db);

    const row = result.rows[0];
    if (!row) throw new Error("createEntity returned no row");
    const entity = mapEntity(row);
    await this.upsertSearchDocument(
      scopedDb,
      ownerUserId,
      "entity",
      entity.id,
      `${entity.name} ${entity.summary}`.trim()
    );
    return entity;
  }

  async addAlias(
    scopedDb: DataContextDb,
    ownerUserId: string,
    entityId: string,
    alias: string,
    ambiguous: boolean
  ): Promise<MemoryAliasRecord> {
    assertDataContextDb(scopedDb);
    const normalizedAlias = normalizeAlias(alias);
    const result = await sql<{
      id: string;
      owner_user_id: string;
      entity_id: string;
      alias: string;
      normalized_alias: string;
      ambiguous: boolean;
      created_at: Date;
      updated_at: Date;
    }>`
      INSERT INTO app.memory_aliases (
        owner_user_id,
        entity_id,
        alias,
        normalized_alias,
        ambiguous
      )
      VALUES (${ownerUserId}::uuid, ${entityId}::uuid, ${alias}, ${normalizedAlias}, ${ambiguous})
      RETURNING *
    `.execute(scopedDb.db);

    const row = result.rows[0];
    if (!row) throw new Error("addAlias returned no row");
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      entityId: row.entity_id,
      alias: row.alias,
      normalizedAlias: row.normalized_alias,
      ambiguous: row.ambiguous,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async createFact(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: NewMemoryFact
  ): Promise<MemoryFactRecord> {
    assertDataContextDb(scopedDb);
    if (Boolean(input.objectEntityId) === Boolean(input.objectText)) {
      throw new Error("memory fact requires exactly one object target");
    }

    const factResult = await sql<FactRow>`
      INSERT INTO app.memory_facts (
        owner_user_id,
        subject_entity_id,
        predicate,
        object_entity_id,
        object_text,
        record_kind,
        confidence,
        provenance,
        importance,
        pinned
      )
      VALUES (
        ${ownerUserId}::uuid,
        ${input.subjectEntityId}::uuid,
        ${input.predicate},
        ${input.objectEntityId ?? null}::uuid,
        ${input.objectText ?? null},
        ${input.recordKind ?? recordKindForPredicate(input.predicate, input.provenance)},
        ${input.confidence ?? 0.6},
        ${input.provenance ?? "inferred"},
        ${input.importance ?? 0.5},
        ${input.pinned ?? false}
      )
      RETURNING *
    `.execute(scopedDb.db);
    const factRow = factResult.rows[0];
    if (!factRow) throw new Error("createFact returned no row");

    const episodeResult = await sql<SourceRow>`
      INSERT INTO app.memory_episodes (
        owner_user_id,
        source_kind,
        source_ref,
        source_label,
        occurred_at,
        excerpt
      )
      VALUES (
        ${ownerUserId}::uuid,
        ${input.source.sourceKind},
        ${input.source.sourceRef},
        ${input.source.sourceLabel ?? ""},
        ${input.source.occurredAt ?? null},
        ${input.source.excerpt}
      )
      RETURNING id, source_kind, source_ref, source_label, occurred_at, excerpt
    `.execute(scopedDb.db);
    const source = episodeResult.rows[0];
    if (!source) throw new Error("createFact source insert returned no row");

    await sql`
      INSERT INTO app.memory_fact_sources (owner_user_id, fact_id, episode_id)
      VALUES (${ownerUserId}::uuid, ${factRow.id}::uuid, ${source.id}::uuid)
    `.execute(scopedDb.db);

    await this.upsertSearchDocument(
      scopedDb,
      ownerUserId,
      "fact",
      factRow.id,
      [factRow.predicate, factRow.object_text].filter(Boolean).join(" ")
    );
    await this.upsertSearchDocument(scopedDb, ownerUserId, "episode", source.id, source.excerpt);

    return mapFact(factRow, [mapSource(source)]);
  }

  async createEpisode(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: MemorySourceInput
  ): Promise<MemorySourceSummary> {
    assertDataContextDb(scopedDb);
    const result = await sql<SourceRow>`
      INSERT INTO app.memory_episodes (
        owner_user_id,
        source_kind,
        source_ref,
        source_label,
        occurred_at,
        excerpt
      )
      VALUES (
        ${ownerUserId}::uuid,
        ${input.sourceKind},
        ${input.sourceRef},
        ${input.sourceLabel ?? ""},
        ${input.occurredAt ?? null},
        ${input.excerpt}
      )
      RETURNING id, source_kind, source_ref, source_label, occurred_at, excerpt
    `.execute(scopedDb.db);
    const row = result.rows[0];
    if (!row) throw new Error("createEpisode returned no row");
    await this.upsertSearchDocument(scopedDb, ownerUserId, "episode", row.id, row.excerpt);
    return mapSource(row);
  }

  async createFactFromEpisode(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: Omit<NewMemoryFact, "source"> & { readonly episodeId: string }
  ): Promise<MemoryFactRecord> {
    assertDataContextDb(scopedDb);
    if (Boolean(input.objectEntityId) === Boolean(input.objectText)) {
      throw new Error("memory fact requires exactly one object target");
    }

    const factResult = await sql<FactRow>`
      INSERT INTO app.memory_facts (
        owner_user_id,
        subject_entity_id,
        predicate,
        object_entity_id,
        object_text,
        record_kind,
        confidence,
        provenance,
        importance,
        pinned
      )
      VALUES (
        ${ownerUserId}::uuid,
        ${input.subjectEntityId}::uuid,
        ${input.predicate},
        ${input.objectEntityId ?? null}::uuid,
        ${input.objectText ?? null},
        ${input.recordKind ?? recordKindForPredicate(input.predicate, input.provenance)},
        ${input.confidence ?? 0.6},
        ${input.provenance ?? "inferred"},
        ${input.importance ?? 0.5},
        ${input.pinned ?? false}
      )
      RETURNING *
    `.execute(scopedDb.db);
    const factRow = factResult.rows[0];
    if (!factRow) throw new Error("createFactFromEpisode returned no row");

    await sql`
      INSERT INTO app.memory_fact_sources (owner_user_id, fact_id, episode_id)
      VALUES (${ownerUserId}::uuid, ${factRow.id}::uuid, ${input.episodeId}::uuid)
    `.execute(scopedDb.db);

    const sources = await this.listSourcesForFact(scopedDb, ownerUserId, factRow.id);
    await this.upsertSearchDocument(
      scopedDb,
      ownerUserId,
      "fact",
      factRow.id,
      [factRow.predicate, factRow.object_text].filter(Boolean).join(" ")
    );
    return mapFact(factRow, sources);
  }

  async upsertSearchDocument(
    scopedDb: DataContextDb,
    ownerUserId: string,
    targetKind: MemorySearchTargetKind,
    targetId: string,
    searchText: string,
    embedding?: readonly number[],
    embedModelName?: string,
    embedModelVersion?: string
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    const vectorSql = embedding ? sql`${toVectorLiteral(embedding)}::vector` : sql`NULL`;
    await sql`
      INSERT INTO app.memory_search_documents (
        owner_user_id,
        target_kind,
        target_id,
        search_text,
        embedding,
        embed_model_name,
        embed_model_version,
        status,
        updated_at
      )
      VALUES (
        ${ownerUserId}::uuid,
        ${targetKind},
        ${targetId}::uuid,
        ${searchText},
        ${vectorSql},
        ${embedModelName ?? null},
        ${embedModelVersion ?? null},
        'active',
        now()
      )
      ON CONFLICT (owner_user_id, target_kind, target_id) DO UPDATE SET
        search_text = EXCLUDED.search_text,
        embedding = EXCLUDED.embedding,
        embed_model_name = EXCLUDED.embed_model_name,
        embed_model_version = EXCLUDED.embed_model_version,
        status = 'active',
        updated_at = now()
    `.execute(scopedDb.db);
  }

  async deactivateSearchDocument(
    scopedDb: DataContextDb,
    ownerUserId: string,
    targetKind: MemorySearchTargetKind,
    targetId: string
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      UPDATE app.memory_search_documents
      SET status = 'inactive', updated_at = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND target_kind = ${targetKind}
        AND target_id = ${targetId}::uuid
    `.execute(scopedDb.db);
  }

  async setSearchDocumentStatus(
    scopedDb: DataContextDb,
    ownerUserId: string,
    targetKind: MemorySearchTargetKind,
    targetId: string,
    status: "active" | "inactive"
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      UPDATE app.memory_search_documents
      SET status = ${status}, updated_at = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND target_kind = ${targetKind}
        AND target_id = ${targetId}::uuid
    `.execute(scopedDb.db);
  }

  async listSearchDocumentsForOwner(
    scopedDb: DataContextDb,
    ownerUserId: string
  ): Promise<MemorySearchDocumentRecord[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      id: string;
      owner_user_id: string;
      target_kind: MemorySearchTargetKind;
      target_id: string;
      search_text: string;
      embed_model_name: string | null;
      embed_model_version: string | null;
      status: "active" | "inactive";
      created_at: Date;
      updated_at: Date;
    }>`
      SELECT id,
             owner_user_id,
             target_kind,
             target_id,
             search_text,
             embed_model_name,
             embed_model_version,
             status,
             created_at,
             updated_at
      FROM app.memory_search_documents
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY created_at, id
    `.execute(scopedDb.db);

    return result.rows.map((row) => ({
      id: row.id,
      ownerUserId: row.owner_user_id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      searchText: row.search_text,
      embedModelName: row.embed_model_name,
      embedModelVersion: row.embed_model_version,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async listFactRecallCandidates(
    scopedDb: DataContextDb,
    ownerUserId: string,
    queryEmbedding: readonly number[],
    options: { readonly includeInactive?: boolean; readonly includeStale?: boolean } = {}
  ): Promise<MemoryFactRecallCandidate[]> {
    assertDataContextDb(scopedDb);
    const vectorLiteral = toVectorLiteral(queryEmbedding);
    const result = await sql<
      FactRow & {
        search_text: string | null;
        vector_similarity: string | number | null;
      }
    >`
      SELECT f.*,
             d.search_text,
             CASE
               WHEN d.embedding IS NULL THEN 0
               ELSE 1 - (d.embedding <=> ${vectorLiteral}::vector)
             END AS vector_similarity
      FROM app.memory_facts f
      LEFT JOIN app.memory_search_documents d
        ON d.owner_user_id = f.owner_user_id
       AND d.target_kind = 'fact'
       AND d.target_id = f.id
       AND (${options.includeInactive ?? false} OR d.status = 'active')
      WHERE f.owner_user_id = ${ownerUserId}::uuid
        AND (f.valid_from IS NULL OR f.valid_from <= now())
        AND (
          ${options.includeInactive ?? false}
          OR (
            (f.status IN ('active', 'conflicting')
              OR (${options.includeStale ?? false} AND f.status = 'stale'))
            AND (f.valid_to IS NULL OR f.valid_to > now())
            AND (${options.includeStale ?? false} OR f.stale_at IS NULL OR f.stale_at > now())
          )
        )
      ORDER BY f.pinned DESC, f.importance DESC, f.updated_at DESC
      LIMIT 100
    `.execute(scopedDb.db);

    return Promise.all(
      result.rows.map(async (row) => ({
        fact: mapFact(row, await this.listSourcesForFact(scopedDb, ownerUserId, row.id)),
        searchText: row.search_text ?? [row.predicate, row.object_text].filter(Boolean).join(" "),
        vectorSimilarity: clamp01(Number(row.vector_similarity ?? 0))
      }))
    );
  }

  async listCoreFacts(
    scopedDb: DataContextDb,
    ownerUserId: string,
    limit: number
  ): Promise<MemoryFactRecord[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<FactRow>`
      SELECT *
      FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND status = 'active'
        AND (valid_to IS NULL OR valid_to > now())
        AND (stale_at IS NULL OR stale_at > now())
        AND (
          (pinned = true AND confidence >= 0.70)
          OR provenance = 'confirmed'
          OR confidence >= 0.80
        )
      ORDER BY pinned DESC, importance DESC, last_confirmed_at DESC NULLS LAST, updated_at DESC
      LIMIT ${limit}
    `.execute(scopedDb.db);

    return Promise.all(
      result.rows.map(async (row) =>
        mapFact(row, await this.listSourcesForFact(scopedDb, ownerUserId, row.id))
      )
    );
  }

  async getActiveFact(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string
  ): Promise<MemoryFactRecord | undefined> {
    assertDataContextDb(scopedDb);
    const result = await sql<FactRow>`
      SELECT *
      FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
        AND status = 'active'
        AND (valid_to IS NULL OR valid_to > now())
    `.execute(scopedDb.db);
    const row = result.rows[0];
    return row
      ? mapFact(row, await this.listSourcesForFact(scopedDb, ownerUserId, row.id))
      : undefined;
  }

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
      await this.deactivateSearchDocument(scopedDb, ownerUserId, "fact", factId);
    }
    return result.rows.length > 0;
  }

  async forgetFact(scopedDb: DataContextDb, ownerUserId: string, factId: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    await this.deactivateSearchDocument(scopedDb, ownerUserId, "fact", factId);
    const result = await sql<{ id: string }>`
      DELETE FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${factId}::uuid
      RETURNING id
    `.execute(scopedDb.db);
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

    await this.setSearchDocumentStatus(scopedDb, ownerUserId, "fact", factId, "active");
    return this.mapFactRow(scopedDb, ownerUserId, result.rows[0]);
  }

  async markFactStale(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string
  ): Promise<MemoryFactRecord | undefined> {
    return this.patchFactStatus(scopedDb, ownerUserId, factId, { status: "stale" });
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

    await this.setSearchDocumentStatus(
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
    const replacement = await this.createFact(scopedDb, ownerUserId, {
      subjectEntityId: existing.subjectEntityId,
      predicate: existing.predicate,
      objectEntityId: null,
      objectText: input.replacementText,
      recordKind: existing.recordKind,
      confidence: Math.max(existing.confidence, 0.9),
      provenance: "confirmed",
      importance: existing.importance,
      pinned: existing.pinned,
      source: {
        sourceKind: source?.sourceKind ?? "manual",
        sourceRef: source?.sourceRef ?? `memory:${existing.id}`,
        sourceLabel: source?.sourceLabel ?? "Memory correction",
        occurredAt: source?.occurredAt ?? null,
        excerpt: source?.excerpt ?? ""
      }
    });

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

    await this.deactivateSearchDocument(scopedDb, ownerUserId, "fact", existing.id);
    return replacement;
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
      ? mapFact(row, await this.listSourcesForFact(scopedDb, ownerUserId, row.id))
      : undefined;
  }

  private async listSourcesForFact(
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

  async getEntityIdByAlias(
    scopedDb: DataContextDb,
    ownerUserId: string,
    alias: string
  ): Promise<string | null> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ entity_id: string }>`
      SELECT entity_id
      FROM app.memory_aliases
      WHERE owner_user_id = ${ownerUserId}::uuid AND alias = ${alias}
    `.execute(scopedDb.db);
    return result.rows[0]?.entity_id ?? null;
  }

  /**
   * Active non-self entities whose name or alias matches `name` case-insensitively. The caller
   * decides what to do with zero or several matches.
   */
  async findEntitiesByName(
    scopedDb: DataContextDb,
    ownerUserId: string,
    name: string
  ): Promise<MemoryEntityRecord[]> {
    assertDataContextDb(scopedDb);
    const normalized = normalizeAlias(name);
    const result = await sql<EntityRow>`
      SELECT e.*
      FROM app.memory_entities e
      WHERE e.owner_user_id = ${ownerUserId}::uuid
        AND e.status = 'active'
        AND e.kind <> 'self'
        AND (
          lower(e.name) = ${normalized}
          OR EXISTS (
            SELECT 1 FROM app.memory_aliases a
            WHERE a.owner_user_id = e.owner_user_id
              AND a.entity_id = e.id
              AND a.normalized_alias = ${normalized}
          )
        )
      ORDER BY e.created_at, e.id
    `.execute(scopedDb.db);
    return result.rows.map(mapEntity);
  }

  async updateEntity(
    scopedDb: DataContextDb,
    ownerUserId: string,
    entityId: string,
    input: { name: string; summary: string }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      UPDATE app.memory_entities
      SET name = ${input.name}, summary = ${input.summary}, updated_at = now()
      WHERE id = ${entityId}::uuid AND owner_user_id = ${ownerUserId}::uuid
    `.execute(scopedDb.db);

    await this.upsertSearchDocument(
      scopedDb,
      ownerUserId,
      "entity",
      entityId,
      `${input.name} ${input.summary}`.trim()
    );
  }

  async forgetEntity(
    scopedDb: DataContextDb,
    ownerUserId: string,
    entityId: string
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      UPDATE app.memory_entities
      SET status = 'forgotten'
      WHERE id = ${entityId}::uuid AND owner_user_id = ${ownerUserId}::uuid
    `.execute(scopedDb.db);
  }
}

function normalizeAlias(alias: string): string {
  return alias.trim().toLocaleLowerCase();
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function recordKindForPredicate(
  predicate: MemoryFactPredicate,
  provenance: MemoryFactProvenance | undefined
): MemoryRecordKind {
  switch (predicate) {
    case "prefers":
      return "preference";
    case "has_goal":
      return "goal";
    case "has_constraint":
      return "constraint";
    case "decided":
      return "decision";
    case "alias_of":
      return "alias";
    case "related_to":
      return "relationship";
    default:
      return provenance === "inferred" ? "inference" : "fact";
  }
}
