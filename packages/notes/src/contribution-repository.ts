import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { RecordingNoteSource } from "@moss/shared";
import { sql } from "kysely";
import {
  NoteContributionConflictError,
  NoteContributionUnavailableError,
  type ContributionOperationRow,
  type ContributionProposalRow,
  type ContributionReceiptRow,
  type NoteDestinationBinding
} from "./contribution-state.js";

export class RecordingContributionRepository {
  async available(db: DataContextDb, destinationId: string): Promise<boolean> {
    assertDataContextDb(db);
    const result = await sql<{ available: boolean }>`
      select app.notes_destination_available(${destinationId}) as available
    `.execute(db.db);
    return result.rows[0]?.available === true;
  }

  async binding(db: DataContextDb, destinationId: string): Promise<NoteDestinationBinding | null> {
    assertDataContextDb(db);
    const result = await sql<NoteDestinationBinding>`
      select destination_id as "destinationId",side,revision
      from app.notes_destination_bindings where destination_id=${destinationId}
    `.execute(db.db);
    return result.rows[0] ?? null;
  }

  /** Called only while holding the canonical destination lock, after disclosed binding consent. */
  async claim(
    db: DataContextDb,
    destinationId: string,
    side: "personal" | "work"
  ): Promise<NoteDestinationBinding> {
    assertDataContextDb(db);
    await sql`
      insert into app.notes_destination_bindings(destination_id,side)
      values (${destinationId},${side}) on conflict(destination_id) do nothing
    `.execute(db.db);
    const binding = await this.binding(db, destinationId);
    if (!binding) throw new NoteContributionUnavailableError();
    if (binding.side !== side) throw new NoteContributionConflictError();
    return binding;
  }

  async invalidateBinding(db: DataContextDb, destinationId: string): Promise<void> {
    assertDataContextDb(db);
    await sql`update app.notes_destination_bindings set revision=revision+1
      where destination_id=${destinationId}`.execute(db.db);
  }

  async receipt(db: DataContextDb, id: string): Promise<ContributionReceiptRow | null> {
    assertDataContextDb(db);
    const result = await sql<Omit<ContributionReceiptRow, "block"> & { blockBytes: string }>`
      select receipt_id as id,source_generation as "sourceGeneration",
        jsonb_build_object('sourceModuleId',source_module_id,'sourceId',source_id,
          'sourceVersion',source_version,'itemKey',item_key) as source,
        revision,side,state,destination,prose as text,block_bytes as "blockBytes",
        operation_id as "operationId"
      from app.notes_recording_contributions where receipt_id=${id}
    `.execute(db.db);
    const row = result.rows[0];
    if (!row) return null;
    const { blockBytes, ...rest } = row;
    return { ...rest, block: { id: row.id, bytes: blockBytes } };
  }

  async insertReceipt(db: DataContextDb, row: ContributionReceiptRow): Promise<void> {
    assertDataContextDb(db);
    const result = await sql<{ id: string }>`
      insert into app.notes_recording_contributions
        (receipt_id,source_module_id,source_id,source_version,source_generation,item_key,revision,side,state,
         destination_id,destination,prose,block_bytes,operation_id)
      values (${row.id},${row.source.sourceModuleId},${row.source.sourceId}::uuid,
        ${row.source.sourceVersion},${row.sourceGeneration},${row.source.itemKey},${row.revision},${row.side},${row.state},
        ${row.destination.id},${JSON.stringify(row.destination)}::jsonb,
        ${row.text},${row.block.bytes},${row.operationId}::uuid)
      on conflict do nothing returning receipt_id as id
    `.execute(db.db);
    if (!result.rows.length) throw new NoteContributionConflictError();
  }

  async updateReceipt(
    db: DataContextDb,
    beforeRevision: number,
    row: ContributionReceiptRow
  ): Promise<void> {
    assertDataContextDb(db);
    const result = await sql<{ id: string }>`
      update app.notes_recording_contributions set revision=${row.revision},side=${row.side},
        source_generation=${row.sourceGeneration},
        state=${row.state},destination_id=${row.destination.id},
        destination=${JSON.stringify(row.destination)}::jsonb,prose=${row.text},
        block_bytes=${row.block.bytes},operation_id=${row.operationId}::uuid
      where receipt_id=${row.id} and revision=${beforeRevision} returning receipt_id as id
    `.execute(db.db);
    if (!result.rows.length) throw new NoteContributionConflictError();
  }

  async proposal(db: DataContextDb, id: string): Promise<ContributionProposalRow | null> {
    assertDataContextDb(db);
    const result = await sql<{ payload: ContributionProposalRow }>`
      select payload from app.notes_contribution_proposals where proposal_id=${id}::uuid
    `.execute(db.db);
    return result.rows[0]?.payload ?? null;
  }

  async saveProposal(db: DataContextDb, proposal: ContributionProposalRow): Promise<void> {
    assertDataContextDb(db);
    const source = proposal.review.source;
    await sql`
      insert into app.notes_contribution_proposals(proposal_id,source_module_id,source_id,payload)
      values (${proposal.id}::uuid,${source.sourceModuleId},${source.sourceId}::uuid,
        ${JSON.stringify(proposal)}::jsonb) on conflict do nothing
    `.execute(db.db);
    const stored = await this.proposal(db, proposal.id);
    if (!stored || stored.digest !== proposal.digest) throw new NoteContributionConflictError();
  }

  async operation(db: DataContextDb, id: string): Promise<ContributionOperationRow | null> {
    assertDataContextDb(db);
    const result = await sql<{ payload: ContributionOperationRow }>`
      select payload from app.notes_contribution_operations where operation_id=${id}::uuid
    `.execute(db.db);
    return result.rows[0]?.payload ?? null;
  }

  async pendingSource(db: DataContextDb, source: RecordingNoteSource): Promise<boolean> {
    assertDataContextDb(db);
    const result = await sql<{ pending: boolean }>`
      select exists(select 1 from app.notes_contribution_operations
        where source_module_id=${source.sourceModuleId} and source_id=${source.sourceId}::uuid
          and state in ('pending','conflict')) as pending
    `.execute(db.db);
    return result.rows[0]!.pending;
  }

  async activeItemCount(db: DataContextDb, source: RecordingNoteSource): Promise<number> {
    assertDataContextDb(db);
    const result = await sql<{ count: number }>`
      select count(*)::int as count from app.notes_recording_contributions
      where source_module_id=${source.sourceModuleId} and source_id=${source.sourceId}::uuid
        and state <> 'undone'
    `.execute(db.db);
    return result.rows[0]!.count;
  }

  async insertOperation(db: DataContextDb, operation: ContributionOperationRow): Promise<void> {
    assertDataContextDb(db);
    await sql`
      insert into app.notes_contribution_operations(operation_id,receipt_id,source_module_id,
        source_id,state,destination_ids,payload)
      values (${operation.id}::uuid,${operation.receiptId},${operation.source.sourceModuleId},
        ${operation.source.sourceId}::uuid,${operation.state},${[...new Set(operation.legs.map(({ destination }) => destination.id))]}::text[],${JSON.stringify(operation)}::jsonb)
    `.execute(db.db);
  }

  /** Receipt locks are acquired only after actor/source/destination admission. */
  async lockOperation(db: DataContextDb, id: string): Promise<ContributionOperationRow> {
    assertDataContextDb(db);
    const result = await sql<{ payload: ContributionOperationRow }>`
      select payload from app.notes_contribution_operations where operation_id=${id}::uuid
      for update
    `.execute(db.db);
    if (!result.rows[0]) throw new NoteContributionUnavailableError();
    return result.rows[0].payload;
  }

  async saveOperation(db: DataContextDb, operation: ContributionOperationRow): Promise<void> {
    assertDataContextDb(db);
    await sql`update app.notes_contribution_operations set state=${operation.state},
      payload=${JSON.stringify(operation)}::jsonb where operation_id=${operation.id}::uuid`.execute(
      db.db
    );
  }
}
