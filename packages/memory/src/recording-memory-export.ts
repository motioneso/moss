import { sql } from "kysely";
import { assertDataContextDb } from "@moss/db";
import type {
  RecordingMemoryExportSection,
  RecordingMemoryVersionExport,
  RecordingMemoryReceiptExport,
  RecordingMemoryProposalExport
} from "@moss/shared";

/** The owning module collects explicit owner-scoped fields for Settings and export workers. */
export async function collectRecordingMemoryExport(
  db: unknown,
  owner: string
): Promise<RecordingMemoryExportSection> {
  assertDataContextDb(db);
  const versions =
    await sql<RecordingMemoryVersionExport>`SELECT owner_user_id::text AS "ownerUserId",
    fact_id::text AS "factId",lineage_id::text AS "lineageId",revision::text AS revision,side,state,
    corrected,replacement_fact_id::text AS "replacementFactId"
    FROM app.memory_recording_fact_versions WHERE owner_user_id = ${owner}::uuid ORDER BY fact_id`.execute(
      db.db
    );
  const receipts =
    await sql<RecordingMemoryReceiptExport>`SELECT owner_user_id::text AS "ownerUserId",
    receipt_id AS "receiptId",source_module_id AS "sourceModuleId",source_id::text AS "sourceId",
    source_version AS "sourceVersion",item_key AS "itemKey",source_generation AS "sourceGeneration",revision,
    side,state,fact_id::text AS "factId",episode_id::text AS "episodeId"
    FROM app.memory_recording_receipts WHERE owner_user_id = ${owner}::uuid ORDER BY receipt_id`.execute(
      db.db
    );
  const proposals =
    await sql<RecordingMemoryProposalExport>`SELECT owner_user_id::text AS "ownerUserId",
    proposal_id::text AS "proposalId",request_id AS "requestId",receipt_id AS "receiptId",kind,
    expected_receipt_revision AS "expectedReceiptRevision",expected_fact_id::text AS "expectedFactId",
    expected_fact_revision::text AS "expectedFactRevision",actor_generation AS "actorGeneration",
    source_generation AS "sourceGeneration",side,proposed_text AS "proposedText",state,
    publication_snapshot AS "publicationSnapshot",before,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
    FROM app.memory_recording_proposals WHERE owner_user_id = ${owner}::uuid ORDER BY created_at,proposal_id`.execute(
      db.db
    );
  return { factVersions: versions.rows, receipts: receipts.rows, proposals: proposals.rows };
}
