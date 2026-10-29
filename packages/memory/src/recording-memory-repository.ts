import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { RecordingMemoryReceipt, RecordingMemorySource } from "@moss/shared";
import type { RecordingFactSourceSnapshot } from "./recording-fact-authority.js";
import { RecordingMemoryUnavailableError } from "./recording-fact-identity.js";

export interface RecordingMemoryRow {
  readonly receipt_id: string;
  readonly source_module_id: "meetings";
  readonly source_id: string;
  readonly source_version: number;
  readonly item_key: string;
  readonly source_generation: number;
  readonly revision: number;
  readonly side: "personal" | "work";
  readonly state: "pending" | "applied" | "undone" | "forgotten";
  readonly fact_id: string | null;
  readonly episode_id: string;
  readonly fact_text: string | null;
  readonly fact_revision: string | null;
  readonly fact_state: "current" | "superseded" | "forgotten" | null;
  readonly fact_status: string | null;
  readonly corrected: boolean | null;
}

export interface RecordingMemoryProposalRow {
  readonly proposal_id: string;
  readonly request_id: string;
  readonly input_digest: string;
  readonly receipt_id: string;
  readonly kind: "apply" | "change" | "undo" | "restore" | "reconcile_side";
  readonly expected_receipt_revision: number;
  readonly expected_fact_id: string | null;
  readonly expected_fact_revision: string | null;
  readonly actor_generation: number;
  readonly source_generation: number;
  readonly side: "personal" | "work";
  readonly proposed_text: string | null;
  readonly state: "prepared" | "applied";
  readonly publication_snapshot: RecordingFactSourceSnapshot;
  readonly before: RecordingMemoryReceipt;
}

export class RecordingMemoryRepository {
  async receipt(
    db: DataContextDb,
    owner: string,
    id: string,
    lock = false
  ): Promise<RecordingMemoryRow> {
    assertDataContextDb(db);
    const locking = lock ? sql`FOR UPDATE OF receipt NOWAIT` : sql``;
    const result = await sql<RecordingMemoryRow>`
      SELECT receipt.*,fact.object_text AS fact_text,fact.status AS fact_status,
        version.revision::text AS fact_revision,version.state AS fact_state,version.corrected
      FROM app.memory_recording_receipts receipt
      LEFT JOIN app.memory_recording_fact_versions version
        ON version.owner_user_id = receipt.owner_user_id AND version.fact_id = receipt.fact_id
      LEFT JOIN app.memory_facts fact
        ON fact.owner_user_id = receipt.owner_user_id AND fact.id = receipt.fact_id
      WHERE receipt.owner_user_id = ${owner}::uuid AND receipt.receipt_id = ${id}
      ${locking}
    `.execute(db.db);
    const row = result.rows[0];
    if (!row) throw new RecordingMemoryUnavailableError();
    return row;
  }

  async findReceipt(
    db: DataContextDb,
    owner: string,
    id: string
  ): Promise<RecordingMemoryRow | null> {
    const exists = await sql`SELECT receipt_id FROM app.memory_recording_receipts
      WHERE owner_user_id = ${owner}::uuid AND receipt_id = ${id}`.execute(db.db);
    return exists.rows.length ? this.receipt(db, owner, id) : null;
  }

  async reserve(
    db: DataContextDb,
    owner: string,
    id: string,
    source: RecordingMemorySource,
    generation: number,
    side: "personal" | "work",
    episodeId: string
  ): Promise<RecordingMemoryRow> {
    const existing = await this.findReceipt(db, owner, id);
    if (existing) return existing;
    const count = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM app.memory_recording_receipts
      WHERE owner_user_id = ${owner}::uuid AND source_module_id = ${source.sourceModuleId}
        AND source_id = ${source.sourceId}::uuid AND source_version = ${source.sourceVersion}`.execute(
      db.db
    );
    if ((count.rows[0]?.count ?? 20) >= 20) throw new RecordingMemoryUnavailableError();
    await sql`INSERT INTO app.memory_recording_receipts(owner_user_id,receipt_id,source_module_id,
      source_id,source_version,item_key,source_generation,side,state,episode_id)
      VALUES (${owner}::uuid,${id},${source.sourceModuleId},${source.sourceId}::uuid,
        ${source.sourceVersion},${source.itemKey},${generation},${side},'pending',${episodeId}::uuid)`.execute(
      db.db
    );
    return this.receipt(db, owner, id);
  }

  async proposal(
    db: DataContextDb,
    owner: string,
    id: string
  ): Promise<RecordingMemoryProposalRow> {
    const result =
      await sql<RecordingMemoryProposalRow>`SELECT * FROM app.memory_recording_proposals
      WHERE owner_user_id = ${owner}::uuid AND proposal_id = ${id}::uuid`.execute(db.db);
    const row = result.rows[0];
    if (!row) throw new RecordingMemoryUnavailableError();
    return row;
  }

  async findRequest(
    db: DataContextDb,
    owner: string,
    requestId: string
  ): Promise<RecordingMemoryProposalRow | null> {
    const result =
      await sql<RecordingMemoryProposalRow>`SELECT * FROM app.memory_recording_proposals
      WHERE owner_user_id = ${owner}::uuid AND request_id = ${requestId}`.execute(db.db);
    return result.rows[0] ?? null;
  }

  async saveProposal(
    db: DataContextDb,
    owner: string,
    row: RecordingMemoryProposalRow
  ): Promise<void> {
    await sql`INSERT INTO app.memory_recording_proposals(owner_user_id,proposal_id,request_id,input_digest,receipt_id,
      kind,expected_receipt_revision,expected_fact_id,expected_fact_revision,actor_generation,
      source_generation,side,proposed_text,publication_snapshot,before)
      VALUES (${owner}::uuid,${row.proposal_id}::uuid,${row.request_id},${row.input_digest},${row.receipt_id},${row.kind},
        ${row.expected_receipt_revision},${row.expected_fact_id}::uuid,${row.expected_fact_revision}::bigint,
        ${row.actor_generation},${row.source_generation},${row.side},${row.proposed_text},
        ${JSON.stringify(row.publication_snapshot)}::jsonb,${JSON.stringify(row.before)}::jsonb)`.execute(
      db.db
    );
  }
}

export function recordingSource(row: RecordingMemoryRow): RecordingMemorySource {
  return {
    sourceModuleId: row.source_module_id,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    itemKey: row.item_key
  };
}

export function recordingReceipt(row: RecordingMemoryRow): RecordingMemoryReceipt {
  const terminal = row.fact_id !== null && row.fact_state !== "current";
  return {
    id: row.receipt_id,
    source: recordingSource(row),
    revision: row.revision,
    side: row.side,
    state: terminal ? "forgotten" : row.state,
    fact:
      row.fact_id && row.fact_revision && row.fact_text !== null
        ? {
            id: row.fact_id,
            text: row.fact_text,
            revision: row.fact_revision,
            status:
              row.fact_state === "current" &&
              ["active", "stale", "conflicting"].includes(row.fact_status ?? "") &&
              row.state === "applied"
                ? "active"
                : "inactive",
            corrected: row.corrected ?? false
          }
        : null
  };
}
