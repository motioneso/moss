import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { DataContextDb } from "@moss/db";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { MemoryGraphRepository } from "./graph-repository.js";
import { toVectorLiteral } from "./graph-repository-utils.js";
import type { RecordingFactMutations } from "./recording-fact-mutations.js";
import type { RecordingFactLineage } from "./recording-fact-lineage.js";
import { RecordingMemoryConflictError } from "./recording-fact-identity.js";
import type {
  RecordingMemoryProposalRow,
  RecordingMemoryRow
} from "./recording-memory-repository.js";
import type { RecordingMemoryResult } from "@moss/shared";

export class RecordingMemoryTransitions {
  constructor(
    private readonly mutations: RecordingFactMutations,
    private readonly lineage: RecordingFactLineage
  ) {}

  async apply(
    db: DataContextDb,
    owner: string,
    receipt: RecordingMemoryRow,
    proposal: RecordingMemoryProposalRow,
    embedding: number[] | null,
    provider: EmbeddingProvider
  ): Promise<RecordingMemoryResult["status"]> {
    if (proposal.kind === "apply" && receipt.state !== "pending") return "unchanged";
    if (proposal.kind === "undo") {
      if (receipt.state === "undone") return "unchanged";
      if (receipt.state !== "applied" || !receipt.fact_id) throw new RecordingMemoryConflictError();
      await this.updateReceipt(
        db,
        owner,
        receipt,
        "undone",
        proposal.side,
        proposal.source_generation,
        receipt.fact_id
      );
      await this.rejectUnsupported(db, owner, receipt.fact_id);
      await this.lineage.synchronize(db, owner, [receipt.fact_id]);
      return "undone";
    }
    if (proposal.kind === "restore") {
      if (receipt.state !== "undone" || !receipt.fact_id) throw new RecordingMemoryConflictError();
      await this.updateReceipt(
        db,
        owner,
        receipt,
        "applied",
        proposal.side,
        proposal.source_generation,
        receipt.fact_id
      );
      const restored = await sql`UPDATE app.memory_facts SET status = 'active',updated_at = now()
        WHERE owner_user_id = ${owner}::uuid AND id = ${receipt.fact_id}::uuid
          AND conflict_group_id IS NULL AND status IN ('active','stale','rejected')`.execute(db.db);
      if (restored.numAffectedRows !== 1n) throw new RecordingMemoryConflictError();
      await this.lineage.synchronize(db, owner, [receipt.fact_id]);
      await this.writeEmbedding(
        db,
        owner,
        receipt.fact_id,
        receipt.fact_text!,
        embedding,
        provider
      );
      return "applied";
    }
    if (proposal.kind === "reconcile_side" && receipt.fact_id) {
      const other = await sql<{
        count: number;
      }>`SELECT count(*)::int AS count FROM app.memory_recording_receipts
        WHERE owner_user_id = ${owner}::uuid AND fact_id = ${receipt.fact_id}::uuid
          AND receipt_id <> ${receipt.receipt_id} AND state IN ('applied','undone')`.execute(db.db);
      if (other.rows[0]?.count === 0) {
        await sql`UPDATE app.memory_recording_fact_versions SET side = ${proposal.side}
          WHERE owner_user_id = ${owner}::uuid AND fact_id = ${receipt.fact_id}::uuid AND state = 'current'`.execute(
          db.db
        );
        await sql`UPDATE app.memory_facts SET recording_side = ${proposal.side},updated_at = now()
          WHERE owner_user_id = ${owner}::uuid AND id = ${receipt.fact_id}::uuid`.execute(db.db);
        await this.updateReceipt(
          db,
          owner,
          receipt,
          receipt.state,
          proposal.side,
          proposal.source_generation,
          receipt.fact_id
        );
        await this.lineage.synchronize(db, owner, [receipt.fact_id]);
        await this.writeEmbedding(
          db,
          owner,
          receipt.fact_id,
          receipt.fact_text!,
          embedding,
          provider
        );
        return "applied";
      }
    }
    const text = proposal.proposed_text ?? receipt.fact_text;
    if (text === null) throw new RecordingMemoryConflictError();
    const created = await this.createFact(db, owner, receipt, proposal, text);
    await this.updateReceipt(
      db,
      owner,
      receipt,
      receipt.state === "undone" ? "undone" : "applied",
      proposal.side,
      proposal.source_generation,
      created
    );
    if (receipt.fact_id) {
      await sql`DELETE FROM app.memory_fact_sources WHERE owner_user_id = ${owner}::uuid
        AND fact_id = ${receipt.fact_id}::uuid AND episode_id = ${receipt.episode_id}::uuid`.execute(
        db.db
      );
      const remaining = await sql<{
        count: number;
      }>`SELECT count(*)::int AS count FROM app.memory_recording_receipts
        WHERE owner_user_id = ${owner}::uuid AND fact_id = ${receipt.fact_id}::uuid
          AND state IN ('applied','undone')`.execute(db.db);
      if (remaining.rows[0]?.count === 0) {
        await sql`UPDATE app.memory_facts SET status = 'superseded',superseded_by_fact_id = ${created}::uuid,
          valid_to = now(),updated_at = now()
          WHERE owner_user_id = ${owner}::uuid AND id = ${receipt.fact_id}::uuid`.execute(db.db);
      } else {
        await this.rejectUnsupported(db, owner, receipt.fact_id);
      }
    }
    await this.lineage.synchronize(db, owner, [
      created,
      ...(receipt.fact_id ? [receipt.fact_id] : [])
    ]);
    await this.writeEmbedding(db, owner, created, text, embedding, provider);
    return "applied";
  }

  private async createFact(
    db: DataContextDb,
    owner: string,
    receipt: RecordingMemoryRow,
    proposal: RecordingMemoryProposalRow,
    text: string
  ): Promise<string> {
    const id = randomUUID();
    this.mutations.includeReplacement(db, owner, id);
    const self = await new MemoryGraphRepository().ensureSelfEntity(db, owner);
    const existing = receipt.fact_id
      ? await sql<{ lineage_id: string; corrected: boolean }>`
      SELECT lineage_id,corrected FROM app.memory_recording_fact_versions
      WHERE owner_user_id = ${owner}::uuid AND fact_id = ${receipt.fact_id}::uuid`.execute(db.db)
      : null;
    await sql`INSERT INTO app.memory_recording_fact_versions(owner_user_id,fact_id,lineage_id,side,corrected)
      VALUES (${owner}::uuid,${id}::uuid,${existing?.rows[0]?.lineage_id ?? id}::uuid,${proposal.side},
        ${proposal.kind === "change" || (existing?.rows[0]?.corrected ?? false)})`.execute(db.db);
    await sql`INSERT INTO app.memory_episodes(id,owner_user_id,source_kind,source_ref,source_label,excerpt,
      recording_side,recording_active)
      VALUES (${receipt.episode_id}::uuid,${owner}::uuid,'note',
        ${`recording:${receipt.source_id}:${receipt.source_version}:${receipt.item_key}`},'Recording',${text},
        ${proposal.side},${receipt.state !== "undone"})
      ON CONFLICT(owner_user_id,id) DO NOTHING`.execute(db.db);
    await sql`INSERT INTO app.memory_facts(id,owner_user_id,subject_entity_id,predicate,object_text,
      recording_side,status,confidence,provenance)
      VALUES (${id}::uuid,${owner}::uuid,${self.id}::uuid,'related_to',${text},${proposal.side},
        ${receipt.state === "undone" ? "rejected" : "active"},0.8,
        ${proposal.kind === "change" ? "confirmed" : "inferred"})`.execute(db.db);
    await sql`INSERT INTO app.memory_fact_sources(owner_user_id,fact_id,episode_id)
      VALUES (${owner}::uuid,${id}::uuid,${receipt.episode_id}::uuid)`.execute(db.db);
    await sql`INSERT INTO app.memory_search_documents(owner_user_id,target_kind,target_id,search_text,status,
      recording_side,recording_revision)
      SELECT ${owner}::uuid,kind,target,${text},'inactive',${proposal.side},version.revision
      FROM app.memory_recording_fact_versions version,
        (VALUES ('fact',${id}::uuid),('episode',${receipt.episode_id}::uuid)) AS targets(kind,target)
      WHERE version.owner_user_id = ${owner}::uuid AND version.fact_id = ${id}::uuid
      ON CONFLICT(owner_user_id,target_kind,target_id) DO UPDATE
        SET search_text = excluded.search_text,status = 'inactive',recording_side = excluded.recording_side,
          recording_revision = excluded.recording_revision,embedding = NULL,embed_model_name = NULL,embed_model_version = NULL`.execute(
      db.db
    );
    return id;
  }

  private async updateReceipt(
    db: DataContextDb,
    owner: string,
    receipt: RecordingMemoryRow,
    state: RecordingMemoryRow["state"],
    side: "personal" | "work",
    generation: number,
    factId: string
  ): Promise<void> {
    await sql`UPDATE app.memory_recording_receipts SET state = ${state},side = ${side},
      source_generation = ${generation},fact_id = ${factId}::uuid,revision = revision + 1
      WHERE owner_user_id = ${owner}::uuid AND receipt_id = ${receipt.receipt_id}`.execute(db.db);
  }

  private async rejectUnsupported(db: DataContextDb, owner: string, factId: string): Promise<void> {
    await sql`UPDATE app.memory_facts fact SET updated_at = now(),
      status = CASE WHEN EXISTS (SELECT 1 FROM app.memory_recording_receipts receipt
        WHERE receipt.owner_user_id = fact.owner_user_id AND receipt.fact_id = fact.id AND receipt.state = 'applied')
        THEN fact.status ELSE 'rejected' END
      WHERE fact.owner_user_id = ${owner}::uuid AND fact.id = ${factId}::uuid`.execute(db.db);
  }

  private async writeEmbedding(
    db: DataContextDb,
    owner: string,
    factId: string,
    text: string,
    embedding: number[] | null,
    provider: EmbeddingProvider
  ): Promise<void> {
    if (!embedding) return;
    await sql`UPDATE app.memory_search_documents SET search_text = ${text},embedding = ${toVectorLiteral(embedding)}::vector,
      embed_model_name = ${provider.modelName},embed_model_version = ${provider.modelVersion}
      WHERE owner_user_id = ${owner}::uuid AND target_kind = 'fact' AND target_id = ${factId}::uuid
        AND status = 'active'`.execute(db.db);
  }
}
