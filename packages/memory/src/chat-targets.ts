import { createHash } from "node:crypto";
import { sql } from "kysely";

import { assertDataContextDb, isUuid } from "@moss/db";
import type { RouteChatTargetResolver } from "@moss/module-sdk";

import { candidateLabel } from "./candidate-labels.js";

interface FactLabelRow {
  readonly id: string;
  readonly subject_entity_id: string;
  readonly subject_name: string | null;
  readonly object_entity_id: string | null;
  readonly predicate: string;
  readonly object_text: string | null;
  readonly object_name: string | null;
}

export function factLabel(row: FactLabelRow): string {
  const subject = row.subject_name?.trim() || "Saved subject";
  const object = row.object_text ?? row.object_name ?? (row.object_entity_id ? "saved item" : null);
  return [subject, row.predicate, object].filter(Boolean).join(": ");
}

function approvalTarget(label: string, identity: unknown) {
  return { label, version: createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
}

/** The actor-scoped fact being deleted or superseded, without its source excerpts. */
export const memoryFactTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const result = await sql<FactLabelRow>`
    SELECT f.id, f.subject_entity_id, s.name AS subject_name,
      f.predicate, f.object_text, f.object_entity_id, e.name AS object_name
    FROM app.memory_facts f
    LEFT JOIN app.memory_entities s ON s.id = f.subject_entity_id
      AND s.owner_user_id = app.current_actor_user_id()
    LEFT JOIN app.memory_entities e ON e.id = f.object_entity_id
      AND e.owner_user_id = app.current_actor_user_id()
    WHERE f.id = ${id}::uuid
      AND f.owner_user_id = app.current_actor_user_id()
  `.execute(db.db);
  const row = result.rows[0];
  return row ? approvalTarget(factLabel(row), row) : null;
};

/** Confirm/correct can supersede every conflicting fact, so the preview names the whole set. */
export const memoryFactResolutionTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const result = await sql<FactLabelRow>`
    SELECT f.id, f.subject_entity_id, s.name AS subject_name,
      f.predicate, f.object_text, f.object_entity_id, e.name AS object_name
    FROM app.memory_facts f
    LEFT JOIN app.memory_entities s ON s.id = f.subject_entity_id
      AND s.owner_user_id = app.current_actor_user_id()
    LEFT JOIN app.memory_entities e ON e.id = f.object_entity_id
      AND e.owner_user_id = app.current_actor_user_id()
    WHERE f.owner_user_id = app.current_actor_user_id()
      AND (f.id = ${id}::uuid
        OR f.conflict_group_id = (
          SELECT conflict_group_id FROM app.memory_facts
          WHERE id = ${id}::uuid AND owner_user_id = app.current_actor_user_id()
        ))
    ORDER BY f.id
  `.execute(db.db);
  const selected = result.rows.find((row) => row.id === id);
  if (!selected) return null;
  const others = result.rows.filter((row) => row.id !== id).map((row) => factLabel(row));
  return approvalTarget(
    `Selected memory: ${factLabel(selected)}` +
      (others.length > 0 ? `; other affected memories: ${others.join("; ")}` : ""),
    result.rows
  );
};

/** The actor-scoped entity being deleted. */
export const memoryEntityTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const result = await sql<{
    id: string;
    name: string;
    summary: string;
    status: string;
    updated_at: string;
  }>`
    SELECT id, kind, name, summary, status, importance, pinned, created_at, updated_at FROM app.memory_entities
    WHERE id = ${id}::uuid AND owner_user_id = app.current_actor_user_id()
  `.execute(db.db);
  const row = result.rows[0];
  return row ? approvalTarget(row.name, row) : null;
};

/** The actor's pending suggestion, labelled with the full text the decision applies to. */
export const memoryCandidateTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const result = await sql<{ id: string; payload_json: unknown }>`
    SELECT id, payload_json FROM app.memory_candidates
    WHERE id = ${id}::uuid
      AND owner_user_id = app.current_actor_user_id()
      AND status = 'pending'
  `.execute(db.db);
  const row = result.rows[0];
  if (!row) return null;
  return approvalTarget(candidateLabel(row.payload_json as Record<string, unknown> | null), row);
};
