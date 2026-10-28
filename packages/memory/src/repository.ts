import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { VaultIndexSnapshot } from "./vault-index-publication.js";

export interface NewChunkData {
  readonly sourcePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly contentHash: string;
  readonly text: string;
  readonly embedding: number[];
}

export interface RetrievedChunk {
  readonly id: string;
  readonly sourcePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
  readonly similarity: number;
  readonly updatedAt: Date;
}

export interface VaultFileChunk {
  readonly text: string;
  readonly lineStart: number;
  readonly updatedAt: Date;
}

export interface VaultFileWithChunks {
  readonly sourcePath: string;
  readonly ingestedAt: Date;
  readonly fileHash: string;
  readonly chunks: readonly VaultFileChunk[];
}

/**
 * Render an embedding as a pgvector literal `[v0,v1,...]`. The components are
 * already typed `number[]`, so there is no SQL-injection surface (a number can
 * only stringify to digits/`.`/`-`/`e`/`NaN`/`Infinity`); this guard is purely
 * defense-in-depth (#146). A non-finite component would serialize to `NaN`/
 * `Infinity` and be rejected by the `::vector` cast with an opaque DB error — and
 * filtering it out would silently change the vector's dimensionality, corrupting
 * the index. So fail loud and early instead.
 */
function toVectorLiteral(embedding: readonly number[]): string {
  for (const component of embedding) {
    if (!Number.isFinite(component)) {
      throw new Error("Embedding contains a non-finite component");
    }
  }
  return `[${embedding.join(",")}]`;
}

/**
 * Postgres rejects NUL (`U+0000`) in `text` columns outright (#1589). Strip the
 * rest of the C0 control range too, except `\t`/`\n`/`\r`, which chunk text can
 * legitimately carry.
 */
function sanitizeChunkText(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export class MemoryRepository {
  async fileChunkCheckpoint(
    db: DataContextDb,
    owner: string,
    kind: string,
    path: string,
    snapshotKey: string,
    modelName: string,
    modelVersion: string
  ): Promise<number | null> {
    assertDataContextDb(db);
    const result = await sql<{ count: number; matching: number }>`
      select count(*)::int as count,
        count(*) filter (where managed_snapshot->>'key'=${snapshotKey}
          and embed_model_name=${modelName} and embed_model_version=${modelVersion})::int as matching
      from app.memory_chunks where owner_user_id=${owner}::uuid
        and source_kind=${kind} and source_path=${path}
    `.execute(db.db);
    const row = result.rows[0]!;
    return row.count === row.matching ? row.count : null;
  }
  /** Clear every alias of an authoritative canonical destination before a receipt changes. */
  async invalidateManagedDestinations(
    db: DataContextDb,
    owner: string,
    destinationIds: readonly string[]
  ): Promise<void> {
    assertDataContextDb(db);
    if (destinationIds.length === 0) return;
    if (destinationIds.length > 200 || destinationIds.some((id) => !/^[a-f0-9]{64}$/.test(id)))
      throw new Error("Invalid managed destination invalidation");
    const paths = await sql<{ path: string }>`
      select source_path as path from app.memory_file_index
      where owner_user_id=${owner}::uuid and managed_snapshot->>'destinationId'=any(${[...destinationIds]}::text[])
      union select source_path as path from app.memory_chunks
      where owner_user_id=${owner}::uuid and managed_snapshot->>'destinationId'=any(${[...destinationIds]}::text[])
    `.execute(db.db);
    if (paths.rows.length)
      await sql`delete from app.memory_links where owner_user_id=${owner}::uuid and from_path=any(${paths.rows.map(({ path }) => path)}::text[])`.execute(
        db.db
      );
    await sql`delete from app.memory_chunks where owner_user_id=${owner}::uuid and managed_snapshot->>'destinationId'=any(${[...destinationIds]}::text[])`.execute(
      db.db
    );
    await sql`delete from app.memory_file_index where owner_user_id=${owner}::uuid and managed_snapshot->>'destinationId'=any(${[...destinationIds]}::text[])`.execute(
      db.db
    );
  }
  /** An unguarded legacy writer cannot erase an already labelled destination. */
  private async assertSnapshotAuthority(
    db: DataContextDb,
    owner: string,
    kind: string,
    path: string,
    snapshot: VaultIndexSnapshot | null
  ): Promise<void> {
    if (snapshot) {
      if (snapshot.ownerUserId.toLowerCase() !== owner.toLowerCase())
        throw new Error("Snapshot owner differs from derivative owner");
      if (snapshot.side !== null) return;
    }
    const result = await sql<{ managed: boolean }>`select exists (
      select 1 from app.memory_file_index where owner_user_id=${owner}::uuid and source_kind=${kind} and source_path=${path} and managed_snapshot->>'side' is not null
      union all
      select 1 from app.memory_chunks where owner_user_id=${owner}::uuid and source_kind=${kind} and source_path=${path} and managed_snapshot->>'side' is not null
    ) as managed`.execute(db.db);
    if (result.rows[0]?.managed)
      throw new Error("Managed derivatives require current snapshot publication authority");
  }

  async upsertFileChunks(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourcePath: string,
    chunks: readonly NewChunkData[],
    embedModelName: string,
    embedModelVersion: string,
    sourceKind: string = "vault",
    replaceExisting = true,
    snapshot: VaultIndexSnapshot | null = null
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await this.assertSnapshotAuthority(scopedDb, ownerUserId, sourceKind, sourcePath, snapshot);
    if (replaceExisting) {
      await this.deleteFileChunks(scopedDb, ownerUserId, sourcePath, sourceKind);
    }

    for (const chunk of chunks) {
      const vectorLiteral = toVectorLiteral(chunk.embedding);
      await sql`
        INSERT INTO app.memory_chunks
          (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text,
           embedding, embed_model_name, embed_model_version, managed_snapshot)
        VALUES
          (${ownerUserId}::uuid, ${sourceKind}, ${chunk.sourcePath}, ${chunk.lineStart},
           ${chunk.lineEnd}, ${chunk.contentHash}, ${sanitizeChunkText(chunk.text)}, ${vectorLiteral}::vector,
           ${embedModelName}, ${embedModelVersion}, ${snapshot ? JSON.stringify(snapshot) : null}::jsonb)
      `.execute(scopedDb.db);
    }
  }

  async deleteFileChunks(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourcePath: string,
    sourceKind: string = "vault"
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      DELETE FROM app.memory_chunks
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND source_path = ${sourcePath}
        AND source_kind = ${sourceKind}
    `.execute(scopedDb.db);
  }

  /**
   * Delete every chunk matching one or more exact source paths of a given kind, for one owner, in
   * a single statement. Backtrack's hourly purge and its explicit delete-range route use this to
   * remove `source_kind = 'screen'` chunks by `sourcePath = "backtrack/<segment id>"` — neither
   * ever queries `app.memory_chunks` directly, keeping module isolation (#2638 plan §4.1).
   *
   * Capped at 500 paths per call so one statement can't be handed an unbounded `IN`/`= ANY` list;
   * callers with more ids batch their own calls. Returns the number of rows actually removed.
   */
  async deleteChunksForSources(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourcePaths: readonly string[],
    sourceKind: string
  ): Promise<number> {
    assertDataContextDb(scopedDb);
    if (sourcePaths.length === 0) return 0;
    if (sourcePaths.length > 500) {
      throw new Error(
        `deleteChunksForSources accepts at most 500 source paths per call, got ${sourcePaths.length}`
      );
    }
    const result = await sql`
      DELETE FROM app.memory_chunks
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND source_kind = ${sourceKind}
        AND source_path = ANY(${[...sourcePaths]}::text[])
    `.execute(scopedDb.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  async deleteAllForUser(scopedDb: DataContextDb, ownerUserId: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      DELETE FROM app.memory_chunks WHERE owner_user_id = ${ownerUserId}::uuid
    `.execute(scopedDb.db);
    await sql`
      DELETE FROM app.memory_links WHERE owner_user_id = ${ownerUserId}::uuid
    `.execute(scopedDb.db);
    // The file index records which files have been ingested and at what hash; it
    // must be wiped alongside the chunks it points at. Leaving it behind orphans
    // the index — `rebuildFromVault` (the disaster-recovery caller) re-ingests only
    // files still present in the vault, so any file deleted since the last ingest
    // would keep a stale index row forever and `purgeDeletedFiles` would have to
    // mop it up later. A full reset clears all three tables (#146).
    await sql`
      DELETE FROM app.memory_file_index WHERE owner_user_id = ${ownerUserId}::uuid
    `.execute(scopedDb.db);
  }

  async vectorSearch(
    scopedDb: DataContextDb,
    embedding: number[],
    limit: number,
    sourceKind: string = "vault"
  ): Promise<RetrievedChunk[]> {
    assertDataContextDb(scopedDb);
    const vectorLiteral = toVectorLiteral(embedding);
    const result = await sql<{
      id: string;
      source_path: string;
      line_start: number;
      line_end: number;
      text: string;
      similarity: number;
      updated_at: Date;
    }>`
      SELECT id, source_path, line_start, line_end, text, updated_at,
             1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM app.memory_chunks
      WHERE embedding IS NOT NULL
        AND owner_user_id = app.current_actor_user_id()
        AND source_kind = ${sourceKind}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `.execute(scopedDb.db);

    return result.rows.map((r) => ({
      id: r.id,
      sourcePath: r.source_path,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      text: r.text,
      similarity: r.similarity,
      updatedAt: r.updated_at
    }));
  }

  /**
   * Recent chunks for a source kind, ordered by their file's ingestion recency.
   * Used by briefings' hybrid vault retrieval (semantic ∪ recency). RLS scopes to
   * the owner via app.current_actor_user_id().
   */
  async listRecentChunks(
    scopedDb: DataContextDb,
    limit: number,
    sourceKind: string = "vault"
  ): Promise<RetrievedChunk[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      id: string;
      source_path: string;
      line_start: number;
      line_end: number;
      text: string;
      updated_at: Date;
    }>`
      SELECT c.id, c.source_path, c.line_start, c.line_end, c.text, c.updated_at
      FROM app.memory_chunks c
      JOIN app.memory_file_index fi
        ON fi.owner_user_id = c.owner_user_id
       AND fi.source_kind = c.source_kind
       AND fi.source_path = c.source_path
      WHERE c.owner_user_id = app.current_actor_user_id()
        AND c.source_kind = ${sourceKind}
      ORDER BY fi.ingested_at DESC, c.line_start ASC
      LIMIT ${limit}
    `.execute(scopedDb.db);

    return result.rows.map((r) => ({
      id: r.id,
      sourcePath: r.source_path,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      text: r.text,
      similarity: 0,
      updatedAt: r.updated_at
    }));
  }

  async replaceFileLinks(
    scopedDb: DataContextDb,
    ownerUserId: string,
    fromPath: string,
    toPaths: readonly string[]
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      DELETE FROM app.memory_links
      WHERE owner_user_id = ${ownerUserId}::uuid AND from_path = ${fromPath}
    `.execute(scopedDb.db);

    for (const toPath of toPaths) {
      await sql`
        INSERT INTO app.memory_links (owner_user_id, from_path, to_path)
        VALUES (${ownerUserId}::uuid, ${fromPath}, ${toPath})
        ON CONFLICT (owner_user_id, from_path, to_path) DO NOTHING
      `.execute(scopedDb.db);
    }
  }

  async getFileIndex(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourceKind: string,
    sourcePath: string
  ): Promise<{
    fileHash: string;
    embedModelName: string;
    managedSnapshot?: VaultIndexSnapshot;
  } | null> {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      file_hash: string;
      embed_model_name: string;
      managed_snapshot: VaultIndexSnapshot | null;
    }>`
      SELECT file_hash, embed_model_name, managed_snapshot
      FROM app.memory_file_index
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND source_kind = ${sourceKind}
        AND source_path = ${sourcePath}
    `.execute(scopedDb.db);
    const row = result.rows[0];
    return row
      ? {
          fileHash: row.file_hash,
          embedModelName: row.embed_model_name,
          ...(row.managed_snapshot ? { managedSnapshot: row.managed_snapshot } : {})
        }
      : null;
  }

  async upsertFileIndex(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourceKind: string,
    sourcePath: string,
    fileHash: string,
    chunkCount: number,
    embedModelName: string,
    embedModelVersion: string,
    snapshot: VaultIndexSnapshot | null = null
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await this.assertSnapshotAuthority(scopedDb, ownerUserId, sourceKind, sourcePath, snapshot);
    await sql`
      INSERT INTO app.memory_file_index
        (owner_user_id, source_kind, source_path, file_hash, chunk_count,
         embed_model_name, embed_model_version, managed_snapshot, ingested_at)
      VALUES
        (${ownerUserId}::uuid, ${sourceKind}, ${sourcePath}, ${fileHash}, ${chunkCount},
         ${embedModelName}, ${embedModelVersion}, ${snapshot ? JSON.stringify(snapshot) : null}::jsonb, now())
      ON CONFLICT (owner_user_id, source_kind, source_path) DO UPDATE SET
        file_hash = EXCLUDED.file_hash,
        chunk_count = EXCLUDED.chunk_count,
        embed_model_name = EXCLUDED.embed_model_name,
        embed_model_version = EXCLUDED.embed_model_version,
        managed_snapshot = EXCLUDED.managed_snapshot,
        ingested_at = now()
    `.execute(scopedDb.db);
  }

  async deleteFileIndex(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourceKind: string,
    sourcePath: string
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      DELETE FROM app.memory_file_index
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND source_kind = ${sourceKind}
        AND source_path = ${sourcePath}
    `.execute(scopedDb.db);
  }

  async listIndexedPaths(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourceKind: string
  ): Promise<string[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ source_path: string }>`
      SELECT source_path
      FROM app.memory_file_index
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND source_kind = ${sourceKind}
    `.execute(scopedDb.db);
    return result.rows.map((r) => r.source_path);
  }

  async getLatestIngestedAt(
    scopedDb: DataContextDb,
    sourceKind: "vault" | "connector" = "vault"
  ): Promise<Date | null> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ latest: Date | null }>`
      SELECT MAX(ingested_at) AS latest
      FROM app.memory_file_index
      WHERE source_kind = ${sourceKind}
    `.execute(scopedDb.db);
    return result.rows[0]?.latest ?? null;
  }

  async listRecentVaultFiles(
    scopedDb: DataContextDb,
    since: Date,
    limit: number,
    chunksPerFile: number = 5,
    sourceKind: string = "vault"
  ): Promise<VaultFileWithChunks[]> {
    assertDataContextDb(scopedDb);
    const fileRows = await sql<{
      source_path: string;
      ingested_at: Date;
      file_hash: string;
    }>`
      SELECT source_path, ingested_at, file_hash
      FROM app.memory_file_index
      WHERE owner_user_id = app.current_actor_user_id()
        AND source_kind = ${sourceKind}
        AND ingested_at >= ${since}
      ORDER BY ingested_at DESC
      LIMIT ${limit}
    `.execute(scopedDb.db);

    const results: VaultFileWithChunks[] = [];
    for (const file of fileRows.rows) {
      const chunkRows = await sql<{
        text: string;
        line_start: number;
        updated_at: Date;
      }>`
        SELECT text, line_start, updated_at
        FROM app.memory_chunks
        WHERE owner_user_id = app.current_actor_user_id()
          AND source_kind = ${sourceKind}
          AND source_path = ${file.source_path}
        ORDER BY line_start ASC
        LIMIT ${chunksPerFile}
      `.execute(scopedDb.db);

      results.push({
        sourcePath: file.source_path,
        ingestedAt: file.ingested_at,
        fileHash: file.file_hash,
        chunks: chunkRows.rows.map((c) => ({
          text: c.text,
          lineStart: c.line_start,
          updatedAt: c.updated_at
        }))
      });
    }
    return results;
  }
}
