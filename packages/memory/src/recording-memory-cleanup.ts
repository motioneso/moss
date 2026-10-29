import { sql } from "kysely";
import type { AccessContext, DataContextDb, ManagedSourceKey } from "@moss/db";

/** Structural host seam; Memory does not import the lifecycle-owning module. */
export interface RecordingMemoryCleanupOperation {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly state: "deleting" | "sealed";
  readonly source: ManagedSourceKey | null;
}
export interface RecordingMemoryCleanupAuthority {
  assertSealedScoped(db: DataContextDb, operation: RecordingMemoryCleanupOperation): Promise<void>;
  withCleanup<T>(
    access: AccessContext,
    operation: RecordingMemoryCleanupOperation,
    work: (db: DataContextDb) => Promise<T>
  ): Promise<T>;
}

/** Removal performs no provider work and never regenerates corrected or retired facts. */
export class RecordingMemoryCleanupService {
  constructor(private readonly authority: RecordingMemoryCleanupAuthority) {}

  async cleanup(
    access: AccessContext,
    operation: RecordingMemoryCleanupOperation
  ): Promise<"complete" | "pending"> {
    return this.authority.withCleanup(access, operation, async (db) => {
      const owner = operation.ownerUserId;
      const receipts = await sql<{
        receipt_id: string;
        episode_id: string;
        fact_id: string | null;
      }>`
        select receipt_id,episode_id,fact_id from app.memory_recording_receipts
        where ${this.sourcePredicate(operation)} and cleanup_operation_id is distinct from ${operation.operationId}::uuid
        order by receipt_id limit 20`.execute(db.db);
      if (!receipts.rows.length) return "complete";
      const receiptIds = receipts.rows.map((row) => row.receipt_id);
      const episodes = receipts.rows.map((row) => row.episode_id);
      const affected = await sql<{ fact_id: string }>`
        select fact_id from app.memory_recording_receipts
          where owner_user_id = ${owner}::uuid and receipt_id = any(${receiptIds}::text[]) and fact_id is not null
        union select fact_id from app.memory_fact_sources
          where owner_user_id = ${owner}::uuid and episode_id = any(${episodes}::uuid[])`.execute(
        db.db
      );
      const facts = affected.rows.map((row) => row.fact_id).sort();
      // Lock graph parents before facts and receipts, matching ordinary managed mutations.
      await sql`select id from app.memory_entities where owner_user_id = ${owner}::uuid and id in (
        select subject_entity_id from app.memory_facts where owner_user_id = ${owner}::uuid and id = any(${facts}::uuid[])
        union select object_entity_id from app.memory_facts where owner_user_id = ${owner}::uuid and id = any(${facts}::uuid[])
      ) order by id for share nowait`.execute(db.db);
      await sql`select id from app.memory_conflict_groups where owner_user_id = ${owner}::uuid and id in (
        select conflict_group_id from app.memory_facts where owner_user_id = ${owner}::uuid and id = any(${facts}::uuid[])
      ) order by id for update nowait`.execute(db.db);
      if (facts.length)
        await sql`select id from app.memory_facts
        where owner_user_id = ${owner}::uuid and id = any(${facts}::uuid[]) order by id for update nowait`.execute(
          db.db
        );
      await sql`select fact_id from app.memory_recording_fact_versions where owner_user_id = ${owner}::uuid
        and fact_id = any(${facts}::uuid[]) order by fact_id for update nowait`.execute(db.db);
      await sql`select receipt_id from app.memory_recording_receipts where owner_user_id = ${owner}::uuid
        and receipt_id = any(${receiptIds}::text[]) order by receipt_id for update nowait`.execute(
        db.db
      );
      await sql`select id from app.memory_search_documents where owner_user_id = ${owner}::uuid
        and ((target_kind = 'episode' and target_id = any(${episodes}::uuid[]))
          or (target_kind = 'fact' and target_id = any(${facts}::uuid[]))) order by id for update nowait`.execute(
        db.db
      );
      await sql`update app.memory_recording_receipts set state = 'forgotten',revision = revision + 1,cleanup_operation_id = ${operation.operationId}::uuid
        where owner_user_id = ${owner}::uuid and receipt_id = any(${receiptIds}::text[])`.execute(
        db.db
      );
      await sql`delete from app.memory_search_documents where owner_user_id = ${owner}::uuid
        and target_kind = 'episode' and target_id = any(${episodes}::uuid[])`.execute(db.db);
      await sql`delete from app.memory_fact_sources where owner_user_id = ${owner}::uuid
        and episode_id = any(${episodes}::uuid[])`.execute(db.db);
      await sql`delete from app.memory_episodes where owner_user_id = ${owner}::uuid
        and id = any(${episodes}::uuid[])`.execute(db.db);
      // Forgotten facts no longer have a live graph row, but can retain inactive search text.
      await sql`delete from app.memory_search_documents document
        using app.memory_recording_fact_versions version
        where version.owner_user_id = ${owner}::uuid and version.fact_id = any(${facts}::uuid[])
          and version.state <> 'current' and document.owner_user_id = version.owner_user_id
          and document.target_kind = 'fact' and document.target_id = version.fact_id`.execute(
        db.db
      );
      // Another recording's surviving association retains its current text and side.
      const unsupported = await sql<{ id: string }>`select fact.id from app.memory_facts fact
        join app.memory_recording_fact_versions version on version.owner_user_id = fact.owner_user_id and version.fact_id = fact.id
        where fact.owner_user_id = ${owner}::uuid and fact.id = any(${facts}::uuid[])
          and not exists(select 1 from app.memory_recording_receipts receipt
            where receipt.owner_user_id = fact.owner_user_id and receipt.fact_id = fact.id and receipt.state in ('applied','undone'))
          and not exists(select 1 from app.memory_fact_sources source
            where source.owner_user_id = fact.owner_user_id and source.fact_id = fact.id)`.execute(
        db.db
      );
      const retired = unsupported.rows.map((row) => row.id);
      if (retired.length) {
        await sql`delete from app.memory_search_documents where owner_user_id = ${owner}::uuid
          and target_kind = 'fact' and target_id = any(${retired}::uuid[])`.execute(db.db);
        // The owning Memory trigger preserves durable forgotten/superseded retirement.
        await sql`delete from app.memory_facts where owner_user_id = ${owner}::uuid and id = any(${retired}::uuid[])`.execute(
          db.db
        );
      }
      await sql`update app.memory_facts fact set status = 'rejected',updated_at = now()
        where fact.owner_user_id = ${owner}::uuid and fact.id = any(${facts}::uuid[])
          and fact.status in ('active','conflicting','stale')
          and not exists(select 1 from app.memory_recording_receipts receipt
            where receipt.owner_user_id = fact.owner_user_id and receipt.fact_id = fact.id and receipt.state = 'applied')`.execute(
        db.db
      );
      await sql`update app.memory_search_documents document set
          status = case when app.memory_recording_fact_eligible(version.owner_user_id,version.fact_id,version.side)
            then 'active' else 'inactive' end,recording_revision = version.revision,updated_at = now()
        from app.memory_recording_fact_versions version
        where version.owner_user_id = ${owner}::uuid and version.fact_id = any(${facts}::uuid[])
          and document.owner_user_id = version.owner_user_id and document.target_kind = 'fact'
          and document.target_id = version.fact_id`.execute(db.db);
      return (await this.remainingScoped(db, operation)) ? "pending" : "complete";
    });
  }

  async assertCompleteScoped(
    db: DataContextDb,
    operation: RecordingMemoryCleanupOperation
  ): Promise<void> {
    if (await this.remainingScoped(db, operation))
      throw new Error("Recording Memory cleanup is incomplete");
  }

  async retireSourceScoped(
    db: DataContextDb,
    operation: RecordingMemoryCleanupOperation
  ): Promise<void> {
    if (!operation.source) throw new Error("Source cleanup requires a source");
    await this.authority.assertSealedScoped(db, operation);
    await this.assertCompleteScoped(db, operation);
    await sql`delete from app.memory_recording_receipts where ${this.sourcePredicate(operation)}`.execute(
      db.db
    );
  }

  private sourcePredicate(operation: RecordingMemoryCleanupOperation) {
    return operation.source
      ? sql`owner_user_id = ${operation.ownerUserId}::uuid and source_module_id = ${operation.source.sourceModuleId}
          and source_id = ${operation.source.sourceId}::uuid`
      : sql`owner_user_id = ${operation.ownerUserId}::uuid`;
  }

  private async remainingScoped(
    db: DataContextDb,
    operation: RecordingMemoryCleanupOperation
  ): Promise<boolean> {
    return (
      await sql<{ pending: boolean }>`select exists(select 1 from app.memory_recording_receipts
      where ${this.sourcePredicate(operation)} and cleanup_operation_id is distinct from ${operation.operationId}::uuid) as pending`.execute(
        db.db
      )
    ).rows[0]!.pending;
  }
}
