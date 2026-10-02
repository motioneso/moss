import { sql } from "kysely";

import { assertDataContextDb, withSavepoint } from "@moss/db";
import type { DataContextDb } from "@moss/db";

/** Hard cap on one review read. Callers may ask for fewer. */
export const SHADOW_RECORD_REVIEW_LIMIT = 200;

export type ShadowDecision =
  | "would_handle"
  | "declined"
  | "none"
  | "needs_earlier_conversation"
  | "pending"
  | "cancelled"
  | "failed";

export type ShadowComparisonStatus =
  | "pending"
  | "match"
  | "mismatch"
  | "no_model_tool"
  | "unobserved"
  | "cancelled";

export type ShadowArgumentAgreement = "match" | "mismatch" | "unavailable";

export interface OpenShadowRecordInput {
  /** Server-issued turn identifier. The model's first tool attempt correlates by this. */
  readonly turnId: string;
  /** Private chats bypass the gate; a record is never written for one. */
  readonly incognito: boolean;
  /** The accepted original text. Private data: never logged or put in a job payload. */
  readonly messageText: string;
  readonly classifierConfigId: string;
  readonly classifierConfigVersion: string;
  readonly thresholdVersion: string;
}

export interface CompleteShadowRecordInput {
  readonly turnId: string;
  readonly decision: Exclude<ShadowDecision, "pending">;
  readonly reason?: string;
  readonly moduleId?: string;
  readonly toolName?: string;
  readonly confidence?: number;
  readonly margin?: number;
  readonly connectionId?: string;
  readonly preparationVersion?: string;
  readonly riskVersion?: string;
  readonly latencyMs?: number;
}

export type ModelToolObservation =
  | {
      readonly kind: "tool";
      readonly toolId: string;
      readonly argumentAgreement?: ShadowArgumentAgreement;
    }
  | { readonly kind: "no_model_tool" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unobserved" };

export interface ShadowRecordRow {
  readonly id: string;
  readonly turnId: string;
  readonly messageText: string;
  readonly decision: ShadowDecision;
  readonly reason: string | null;
  readonly moduleId: string | null;
  readonly toolName: string | null;
  readonly confidence: number | null;
  readonly margin: number | null;
  readonly connectionId: string | null;
  readonly latencyMs: number | null;
  readonly comparisonStatus: ShadowComparisonStatus;
  readonly modelToolId: string | null;
  readonly argumentAgreement: ShadowArgumentAgreement | null;
  readonly createdAt: Date;
}

export interface ClassifierShadowRepositoryOptions {
  /** Called with the operation name only, never with message text or error detail. */
  readonly onWriteFailure?: (operation: string) => void;
}

interface StoredRow {
  readonly id: string;
  readonly turn_id: string;
  readonly message_text: string;
  readonly decision: string;
  readonly reason: string | null;
  readonly module_id: string | null;
  readonly tool_name: string | null;
  readonly confidence: number | null;
  readonly margin: number | null;
  readonly connection_id: string | null;
  readonly latency_ms: number | null;
  readonly comparison_status: string;
  readonly model_tool_id: string | null;
  readonly argument_agreement: string | null;
  readonly created_at: Date;
}

/** Identity used to compare the gate's pick with the model's first tool attempt. */
export function normalizeToolIdentity(moduleId: string, toolName: string): string {
  return `${moduleId}.${toolName}`.toLowerCase();
}

/**
 * Only a hypothetical handled decision can agree or disagree with the model. A pending decision
 * waits, and every other decision is not comparable, so none/failed/cancelled never read as a
 * mismatch.
 */
export function resolveComparison(
  decision: ShadowDecision,
  gateToolId: string | null,
  modelToolId: string | null
): ShadowComparisonStatus {
  if (modelToolId === null) return "pending";
  if (decision === "pending") return "pending";
  if (decision !== "would_handle" || gateToolId === null) return "unobserved";
  return modelToolId === gateToolId ? "match" : "mismatch";
}

/**
 * Owner-only shadow decision records (#2868). Every method runs under the caller's actor data
 * context, so row-level security scopes it to that actor. Writes never throw: a storage failure
 * must not stop the default turn, so each write runs in a savepoint and reports failure as `false`.
 */
export class ClassifierShadowRepository {
  readonly #onWriteFailure: ((operation: string) => void) | undefined;

  constructor(options: ClassifierShadowRepositoryOptions = {}) {
    this.#onWriteFailure = options.onWriteFailure;
  }

  async open(scopedDb: DataContextDb, input: OpenShadowRecordInput): Promise<boolean> {
    if (input.incognito) return false;
    return this.#guarded("open", scopedDb, async () => {
      await sql`
        INSERT INTO app.chat_classifier_shadow_records (
          owner_user_id, turn_id, message_text, gate_mode,
          classifier_config_id, classifier_config_version, threshold_version
        )
        VALUES (
          app.current_actor_user_id(), ${input.turnId}, ${input.messageText}, 'shadow',
          ${input.classifierConfigId}, ${input.classifierConfigVersion}, ${input.thresholdVersion}
        )
        ON CONFLICT (owner_user_id, turn_id) DO NOTHING
      `.execute(scopedDb.db);
    });
  }

  async complete(scopedDb: DataContextDb, input: CompleteShadowRecordInput): Promise<boolean> {
    return this.#guarded("complete", scopedDb, async () => {
      const gateToolId =
        input.moduleId !== undefined && input.toolName !== undefined
          ? normalizeToolIdentity(input.moduleId, input.toolName)
          : null;
      const current = await this.#lockTurn(scopedDb, input.turnId);
      if (!current) return;
      const comparison = resolveComparison(input.decision, gateToolId, current.model_tool_id);
      await sql`
        UPDATE app.chat_classifier_shadow_records
        SET decision = ${input.decision},
            reason = ${input.reason ?? null},
            module_id = ${input.moduleId ?? null},
            tool_name = ${input.toolName ?? null},
            confidence = ${input.confidence ?? null},
            margin = ${input.margin ?? null},
            connection_id = ${input.connectionId ?? null}::uuid,
            preparation_version = ${input.preparationVersion ?? null},
            risk_version = ${input.riskVersion ?? null},
            latency_ms = ${input.latencyMs ?? null},
            comparison_status = ${
              current.model_tool_id !== null ? comparison : current.comparison_status
            },
            argument_agreement = ${
              current.model_tool_id !== null && comparison !== "match"
                ? null
                : current.argument_agreement
            },
            updated_at = now()
        WHERE id = ${current.id}::uuid
      `.execute(scopedDb.db);
    });
  }

  async observeModelTool(
    scopedDb: DataContextDb,
    turnId: string,
    observation: ModelToolObservation
  ): Promise<boolean> {
    return this.#guarded("observe", scopedDb, async () => {
      const current = await this.#lockTurn(scopedDb, turnId);
      if (!current) return;
      // Only the model's first tool call counts; the row lock makes this check race-free.
      if (observation.kind === "tool" && current.model_tool_id !== null) return;
      const gateToolId =
        current.module_id !== null && current.tool_name !== null
          ? normalizeToolIdentity(current.module_id, current.tool_name)
          : null;
      const decision = current.decision as ShadowDecision;
      let status: ShadowComparisonStatus;
      let modelToolId: string | null = null;
      let agreement: ShadowArgumentAgreement | null = null;
      switch (observation.kind) {
        case "tool":
          modelToolId = observation.toolId.toLowerCase();
          status = resolveComparison(decision, gateToolId, modelToolId);
          // Kept as reported even while the decision is pending; complete() clears it unless the
          // final comparison is a match.
          agreement = observation.argumentAgreement ?? "unavailable";
          if (status === "mismatch") agreement = null;
          break;
        case "no_model_tool":
          status = "no_model_tool";
          break;
        case "cancelled":
          status = "cancelled";
          break;
        case "unobserved":
          status = "unobserved";
          break;
      }
      await sql`
        UPDATE app.chat_classifier_shadow_records
        SET comparison_status = ${status},
            model_tool_id = ${modelToolId},
            argument_agreement = ${agreement},
            updated_at = now()
        WHERE id = ${current.id}::uuid
      `.execute(scopedDb.db);
    });
  }

  /** The actor's own records, newest first. Row-level security supplies the owner filter. */
  async listForOwner(
    scopedDb: DataContextDb,
    options: { readonly limit?: number } = {}
  ): Promise<ShadowRecordRow[]> {
    assertDataContextDb(scopedDb);
    const limit = Math.min(
      Math.max(Math.trunc(options.limit ?? SHADOW_RECORD_REVIEW_LIMIT), 1),
      SHADOW_RECORD_REVIEW_LIMIT
    );
    const result = await sql<StoredRow>`
      SELECT id, turn_id, message_text, decision, reason, module_id, tool_name, confidence,
             margin, connection_id, latency_ms, comparison_status, model_tool_id,
             argument_agreement, created_at
      FROM app.chat_classifier_shadow_records
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `.execute(scopedDb.db);
    return result.rows.map(mapRow);
  }

  /**
   * Deletes the caller's own records on request (#2908). Row-level security supplies the owner
   * filter from the actor data context — no owner id and no admin path — so the count is always
   * the calling actor's own rows and cannot be widened by a caller.
   */
  async deleteForOwner(scopedDb: DataContextDb): Promise<number> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.chat_classifier_shadow_records")
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async #lockTurn(
    scopedDb: DataContextDb,
    turnId: string
  ): Promise<
    | {
        id: string;
        decision: string;
        module_id: string | null;
        tool_name: string | null;
        comparison_status: string;
        model_tool_id: string | null;
        argument_agreement: string | null;
      }
    | undefined
  > {
    const result = await sql<{
      id: string;
      decision: string;
      module_id: string | null;
      tool_name: string | null;
      comparison_status: string;
      model_tool_id: string | null;
      argument_agreement: string | null;
    }>`
      SELECT id, decision, module_id, tool_name, comparison_status, model_tool_id,
             argument_agreement
      FROM app.chat_classifier_shadow_records
      WHERE turn_id = ${turnId}
      FOR UPDATE
    `.execute(scopedDb.db);
    return result.rows[0];
  }

  async #guarded(
    operation: string,
    scopedDb: DataContextDb,
    work: () => Promise<void>
  ): Promise<boolean> {
    try {
      assertDataContextDb(scopedDb);
      await withSavepoint(scopedDb, work);
      return true;
    } catch {
      this.#onWriteFailure?.(operation);
      return false;
    }
  }
}

function mapRow(row: StoredRow): ShadowRecordRow {
  return {
    id: row.id,
    turnId: row.turn_id,
    messageText: row.message_text,
    decision: row.decision as ShadowDecision,
    reason: row.reason,
    moduleId: row.module_id,
    toolName: row.tool_name,
    confidence: row.confidence,
    margin: row.margin,
    connectionId: row.connection_id,
    latencyMs: row.latency_ms,
    comparisonStatus: row.comparison_status as ShadowComparisonStatus,
    modelToolId: row.model_tool_id,
    argumentAgreement: row.argument_agreement as ShadowArgumentAgreement | null,
    createdAt: row.created_at
  };
}
