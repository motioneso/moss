import { sql } from "kysely";
import type { DataContextDb } from "@moss/db";
import type { MemorySourceSummary } from "./graph-types.js";
import { type SourceRow, mapSource } from "./graph-repository-utils.js";

export async function listMemoryFactSources(
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
