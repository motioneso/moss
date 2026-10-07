import { createHash } from "node:crypto";
import { sql } from "kysely";

import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";

import { factLabel } from "./chat-targets.js";
import { MemoryGraphRepository } from "./graph-repository.js";

interface ForgetRow {
  id: string;
  subject_entity_id: string;
  subject_name: string | null;
  object_entity_id: string | null;
  predicate: string;
  object_text: string | null;
  object_name: string | null;
  row_version: string;
  subject_version: string | null;
  object_version: string | null;
}

export interface MemoryForgetTarget {
  readonly label: string;
  readonly version: string;
}

export interface MemoryForgetToolService {
  forget(factId: string, ctx: ToolContext): Promise<{ deleted: true }>;
}

/** Owner-scoped approval identity without source excerpts; every lifecycle status is supported. */
export class MemoryForgetService {
  async target(
    db: DataContextDb,
    ownerUserId: string,
    factId: string
  ): Promise<MemoryForgetTarget | null> {
    const row = await this.readRow(db, ownerUserId, factId);
    return row ? this.toTarget(row) : null;
  }

  /** Called in one actor transaction: hold displayed entity names and conditionally delete the fact version. */
  async forgetApproved(
    db: DataContextDb,
    ownerUserId: string,
    factId: string,
    version: string
  ): Promise<boolean> {
    const initial = await this.readRow(db, ownerUserId, factId);
    if (!initial) return false;
    const entityIds = [initial.subject_entity_id, initial.object_entity_id].filter(
      (id): id is string => id !== null
    );
    await sql`
      SELECT id FROM app.memory_entities
      WHERE owner_user_id = ${ownerUserId}::uuid AND id = ANY(${entityIds}::uuid[])
      ORDER BY id FOR SHARE
    `.execute(db.db);
    const current = await this.readRow(db, ownerUserId, factId);
    if (!current || this.toTarget(current).version !== version) return false;
    // PostgreSQL rechecks xmin after a concurrent update; no changed row can slip between
    // the final label check and the deletion. A failed claim never changes the search index.
    const deleted = await sql<{ id: string }>`
      DELETE FROM app.memory_facts
      WHERE owner_user_id = ${ownerUserId}::uuid AND id = ${factId}::uuid
        AND xmin::text = ${current.row_version}
      RETURNING id
    `.execute(db.db);
    if (deleted.rows.length === 0) return false;
    // Other deletion paths lock the document first; edits lock the fact first. Never wait
    // on a document while holding this fact: contention aborts and rolls back the deletion.
    await sql`
      SELECT id FROM app.memory_search_documents
      WHERE owner_user_id = ${ownerUserId}::uuid AND target_kind = 'fact' AND target_id = ${factId}::uuid
      FOR UPDATE NOWAIT
    `.execute(db.db);
    await new MemoryGraphRepository().deactivateSearchDocument(db, ownerUserId, "fact", factId);
    return true;
  }

  private toTarget(row: ForgetRow): MemoryForgetTarget {
    return {
      label: factLabel(row),
      version: createHash("sha256").update(JSON.stringify(row)).digest("hex")
    };
  }

  private async readRow(
    db: DataContextDb,
    ownerUserId: string,
    factId: string
  ): Promise<ForgetRow | undefined> {
    assertDataContextDb(db);
    if (!isUuid(factId)) return undefined;
    const result = await sql<ForgetRow>`
      SELECT f.id, f.subject_entity_id, s.name AS subject_name,
        f.predicate, f.object_text, f.object_entity_id, e.name AS object_name,
        f.xmin::text AS row_version, s.xmin::text AS subject_version, e.xmin::text AS object_version
      FROM app.memory_facts f
      LEFT JOIN app.memory_entities s ON s.id = f.subject_entity_id AND s.owner_user_id = ${ownerUserId}::uuid
      LEFT JOIN app.memory_entities e ON e.id = f.object_entity_id AND e.owner_user_id = ${ownerUserId}::uuid
      WHERE f.id = ${factId}::uuid AND f.owner_user_id = ${ownerUserId}::uuid
    `.execute(db.db);
    return result.rows[0];
  }
}
