import { sql } from "kysely";
import type { DataContextDb } from "@moss/db";
import {
  RecordingFactConflictError,
  type RecordingFactMutations
} from "./recording-fact-mutations.js";

/** Memory owns association moves and derivative state; source admission belongs to the host. */
export class RecordingFactLineage {
  constructor(private readonly mutations: RecordingFactMutations) {}

  async transfer(
    db: DataContextDb,
    owner: string,
    fromIds: readonly string[],
    replacementId: string,
    corrected: boolean
  ): Promise<void> {
    const versions = await sql<{
      fact_id: string;
      lineage_id: string;
      side: "personal" | "work";
      state: string;
      corrected: boolean;
    }>`SELECT fact_id,lineage_id,side,state,corrected FROM app.memory_recording_fact_versions
      WHERE owner_user_id = ${owner}::uuid AND fact_id = ANY(${fromIds}::uuid[])
      ORDER BY fact_id`.execute(db.db);
    const first = versions.rows[0];
    if (!first) return;
    // Resolving a mixed group must not absorb unlabelled or opposite-side facts.
    if (
      versions.rows.length !== fromIds.length ||
      versions.rows.some((row) => row.side !== first.side || row.state !== "current")
    )
      throw new RecordingFactConflictError();
    for (const id of fromIds) this.mutations.assertLive(db, owner, id);
    this.mutations.includeReplacement(db, owner, replacementId);
    const existing = await sql<{
      fact_id: string;
    }>`SELECT fact_id FROM app.memory_recording_fact_versions
      WHERE owner_user_id = ${owner}::uuid AND fact_id = ${replacementId}::uuid`.execute(db.db);
    if (existing.rows.length === 0) {
      await sql`INSERT INTO app.memory_recording_fact_versions(owner_user_id,fact_id,lineage_id,side,corrected)
        VALUES (${owner}::uuid,${replacementId}::uuid,${first.lineage_id}::uuid,${first.side},
          ${corrected || versions.rows.some((row) => row.corrected)})`.execute(db.db);
      await sql`UPDATE app.memory_facts SET recording_side = ${first.side}
        WHERE owner_user_id = ${owner}::uuid AND id = ${replacementId}::uuid`.execute(db.db);
    } else if (corrected || versions.rows.some((row) => row.corrected)) {
      await sql`UPDATE app.memory_recording_fact_versions SET corrected = true
        WHERE owner_user_id = ${owner}::uuid AND fact_id = ${replacementId}::uuid`.execute(db.db);
    }
    await sql`INSERT INTO app.memory_fact_sources(owner_user_id,fact_id,episode_id)
      SELECT owner_user_id,${replacementId}::uuid,episode_id FROM app.memory_fact_sources
      WHERE owner_user_id = ${owner}::uuid AND fact_id = ANY(${fromIds}::uuid[])
      ON CONFLICT (owner_user_id,fact_id,episode_id) DO NOTHING`.execute(db.db);
    await sql`UPDATE app.memory_recording_receipts SET fact_id = ${replacementId}::uuid,revision = revision + 1
      WHERE owner_user_id = ${owner}::uuid AND fact_id = ANY(${fromIds}::uuid[])
        AND fact_id <> ${replacementId}::uuid AND state IN ('applied','undone')`.execute(db.db);
  }

  /** Called after an owning transition, still inside its admitted transaction. */
  async synchronize(db: DataContextDb, owner: string, factIds: readonly string[]): Promise<void> {
    const managed = await sql<{
      fact_id: string;
    }>`SELECT fact_id FROM app.memory_recording_fact_versions
      WHERE owner_user_id = ${owner}::uuid AND fact_id = ANY(${factIds}::uuid[]) ORDER BY fact_id`.execute(
      db.db
    );
    if (managed.rows.length === 0) return;
    for (const row of managed.rows) this.mutations.assertLive(db, owner, row.fact_id);
    const ids = managed.rows.map((row) => row.fact_id);
    await sql`UPDATE app.memory_recording_receipts receipt SET state = 'forgotten',revision = receipt.revision + 1
      FROM app.memory_recording_fact_versions version
      WHERE version.owner_user_id = ${owner}::uuid AND version.fact_id = ANY(${ids}::uuid[])
        AND version.state <> 'current' AND receipt.owner_user_id = version.owner_user_id
        AND receipt.fact_id = version.fact_id AND receipt.state IN ('applied','undone')`.execute(
      db.db
    );
    // Do not wait on a derivative while holding graph parents (approved forget's rule).
    await sql`SELECT id FROM app.memory_search_documents WHERE owner_user_id = ${owner}::uuid
      AND ((target_kind = 'fact' AND target_id = ANY(${ids}::uuid[])) OR (target_kind = 'episode' AND target_id IN (
        SELECT episode_id FROM app.memory_recording_receipts
        WHERE owner_user_id = ${owner}::uuid AND fact_id = ANY(${ids}::uuid[])
      ))) ORDER BY id FOR UPDATE NOWAIT`.execute(db.db);
    await sql`SELECT id FROM app.memory_episodes WHERE owner_user_id = ${owner}::uuid AND id IN (
      SELECT episode_id FROM app.memory_recording_receipts
      WHERE owner_user_id = ${owner}::uuid AND fact_id = ANY(${ids}::uuid[])
    ) ORDER BY id FOR UPDATE NOWAIT`.execute(db.db);
    await sql`UPDATE app.memory_episodes episode
      SET recording_side = receipt.side,recording_active = receipt.state = 'applied'
        AND app.memory_recording_fact_eligible(receipt.owner_user_id,receipt.fact_id,receipt.side)
      FROM app.memory_recording_receipts receipt
      WHERE receipt.owner_user_id = ${owner}::uuid AND receipt.fact_id = ANY(${ids}::uuid[])
        AND episode.owner_user_id = receipt.owner_user_id AND episode.id = receipt.episode_id`.execute(
      db.db
    );
    await sql`UPDATE app.memory_search_documents document
      SET recording_side = version.side,recording_revision = version.revision,
        status = CASE WHEN app.memory_recording_fact_eligible(version.owner_user_id,version.fact_id,version.side)
          THEN 'active' ELSE 'inactive' END,updated_at = now()
      FROM app.memory_recording_fact_versions version
      WHERE version.owner_user_id = ${owner}::uuid AND version.fact_id = ANY(${ids}::uuid[])
        AND document.owner_user_id = version.owner_user_id
        AND document.target_kind = 'fact' AND document.target_id = version.fact_id`.execute(db.db);
    await sql`UPDATE app.memory_search_documents document
      SET recording_side = receipt.side,recording_revision = version.revision,
        search_text = COALESCE(fact.object_text,document.search_text),embedding = NULL,
        embed_model_name = NULL,embed_model_version = NULL,
        status = CASE WHEN app.memory_recording_target_revision(
          receipt.owner_user_id,'episode',receipt.episode_id,receipt.side) IS NOT NULL
          THEN 'active' ELSE 'inactive' END,updated_at = now()
      FROM app.memory_recording_receipts receipt
      JOIN app.memory_recording_fact_versions version
        ON version.owner_user_id = receipt.owner_user_id AND version.fact_id = receipt.fact_id
      LEFT JOIN app.memory_facts fact ON fact.owner_user_id = version.owner_user_id AND fact.id = version.fact_id
      WHERE receipt.owner_user_id = ${owner}::uuid AND receipt.fact_id = ANY(${ids}::uuid[])
        AND document.owner_user_id = receipt.owner_user_id
        AND document.target_kind = 'episode' AND document.target_id = receipt.episode_id`.execute(
      db.db
    );
  }
}
