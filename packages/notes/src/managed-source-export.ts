import { assertDataContextDb } from "@moss/db";
import type {
  ManagedNoteActorExport,
  ManagedNoteSourceExport,
  ManagedNotesExportSection,
  ManagedNoteBindingExport,
  ManagedNoteContributionExport,
  ManagedNoteProposalExport,
  ManagedNoteOperationExport
} from "@moss/shared";
import { sql } from "kysely";

/** Both runtime roles export only rows visible through their ordinary owner RLS context. */
export async function collectManagedNotesExportSection(
  db: unknown
): Promise<ManagedNotesExportSection> {
  assertDataContextDb(db);
  const actors = await sql<ManagedNoteActorExport>`
    select owner_user_id as "ownerUserId",generation,state,operation_id as "operationId"
    from app.notes_managed_actors order by owner_user_id
  `.execute(db.db);
  const sources = await sql<ManagedNoteSourceExport>`
    select owner_user_id as "ownerUserId",source_module_id as "sourceModuleId",
      source_id as "sourceId",generation,state,operation_id as "operationId"
    from app.notes_managed_sources order by source_module_id,source_id
  `.execute(db.db);
  const bindings = await sql<ManagedNoteBindingExport>`
    select destination_id as "destinationId",side,revision
    from app.notes_destination_bindings order by destination_id
  `.execute(db.db);
  const contributions = await sql<ManagedNoteContributionExport>`
    select receipt_id as "receiptId",source_module_id as "sourceModuleId",source_id as "sourceId",
      source_version as "sourceVersion",source_generation as "sourceGeneration",item_key as "itemKey",
      revision,side,state,destination,prose as text,block_bytes as "blockBytes",operation_id as "operationId",cleanup_operation_id as "cleanupOperationId"
    from app.notes_recording_contributions order by receipt_id
  `.execute(db.db);
  const proposals = await sql<ManagedNoteProposalExport>`
    select proposal_id as "proposalId",source_module_id as "sourceModuleId",source_id as "sourceId",payload
    from app.notes_contribution_proposals order by proposal_id
  `.execute(db.db);
  const operations = await sql<ManagedNoteOperationExport>`
    select operation_id as "operationId",receipt_id as "receiptId",source_module_id as "sourceModuleId",
      source_id as "sourceId",state,destination_ids as "destinationIds",payload
    from app.notes_contribution_operations order by operation_id
  `.execute(db.db);
  return {
    actors: actors.rows,
    sources: sources.rows,
    bindings: bindings.rows,
    contributions: contributions.rows,
    proposals: proposals.rows,
    operations: operations.rows
  };
}
