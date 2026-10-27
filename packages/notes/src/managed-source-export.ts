import { assertDataContextDb } from "@moss/db";
import type {
  ManagedNoteActorExport,
  ManagedNoteSourceExport,
  ManagedNotesExportSection
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
  return { actors: actors.rows, sources: sources.rows };
}
