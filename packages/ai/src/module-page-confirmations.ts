import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import type { ActionAuditInputSummary } from "@moss/shared";

export interface CreateModulePageConfirmationInput {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly toolName: string;
  readonly permissionId: string;
  readonly risk: "write" | "outbound" | "destructive";
  readonly inputSummary: Record<string, unknown>;
  /** SHA-256 of canonical, validated tool input; never the raw input itself. */
  readonly inputDigest: Buffer;
  readonly requestId: string;
}

export interface ConsumeModulePageConfirmationInput {
  readonly id: string;
  readonly moduleId: string;
  readonly toolName: string;
  readonly inputDigest: Buffer;
}

/** Create an owner-scoped page decision with a two-minute database deadline. */
export async function createModulePageConfirmation(
  scopedDb: DataContextDb,
  input: CreateModulePageConfirmationInput
): Promise<{ id: string; expiresAt: Date }> {
  assertDataContextDb(scopedDb);
  if (input.inputDigest.length !== 32) throw new Error("Expected a SHA-256 input digest");
  const row = await scopedDb.db
    .insertInto("app.ai_assistant_action_requests")
    .values({
      id: randomUUID(),
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      origin: "module_page",
      input_digest: input.inputDigest,
      chat_thread_id: null,
      chat_session_id: null,
      expires_at: sql<Date>`clock_timestamp() + interval '2 minutes'`,
      tool_module_id: input.moduleId,
      tool_module_name: input.moduleName,
      tool_name: input.toolName,
      permission_id: input.permissionId,
      risk: input.risk,
      status: "pending",
      input_summary: input.inputSummary,
      request_id: input.requestId,
      resolved_at: null
    })
    .returning(["id", "expires_at as expiresAt"])
    .executeTakeFirstOrThrow();
  // The page-row CHECK requires a deadline; preserve a non-null public contract.
  if (!row.expiresAt) throw new Error("Module page confirmation is missing its deadline");
  return { id: row.id, expiresAt: row.expiresAt };
}

/** Atomically claim exactly one still-pending decision for this actor and validated input. */
export async function consumeModulePageConfirmation(
  scopedDb: DataContextDb,
  input: ConsumeModulePageConfirmationInput
): Promise<boolean> {
  assertDataContextDb(scopedDb);
  if (!isUuid(input.id) || input.inputDigest.length !== 32) return false;
  const row = await scopedDb.db
    .updateTable("app.ai_assistant_action_requests")
    .set({
      status: "confirmed",
      resolved_at: sql<Date>`clock_timestamp()`,
      updated_at: sql<Date>`clock_timestamp()`
    })
    .where("id", "=", input.id)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("origin", "=", "module_page")
    .where("tool_module_id", "=", input.moduleId)
    .where("tool_name", "=", input.toolName)
    .where("input_digest", "=", input.inputDigest)
    .where("status", "=", "pending")
    .where("expires_at", ">", sql<Date>`clock_timestamp()`)
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

export interface RecordModulePageActivityInput {
  readonly moduleId: string;
  readonly toolName: string;
  readonly actionFamilyId: string | null;
  readonly actionKind: "write" | "outbound" | "destructive";
  /** auto: ran on the click; confirmed: ran after the host dialog. */
  readonly approvalMode: "auto" | "confirmed";
  readonly outcome: "success" | "failed";
  readonly errorClass: string | null;
  /** Key names only, never values. */
  readonly inputSummary: ActionAuditInputSummary;
  readonly durationMs: number;
  readonly requestId: string | null;
}

/** Record one executed page write on the activity log. The owner is the transaction actor. */
export async function recordModulePageActivity(
  scopedDb: DataContextDb,
  input: RecordModulePageActivityInput
): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .insertInto("app.moss_action_audit_log")
    .values({
      id: randomUUID(),
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      tool_module_id: input.moduleId,
      tool_name: input.toolName,
      action_family_id: input.actionFamilyId,
      action_kind: input.actionKind,
      approval_mode: input.approvalMode,
      outcome: input.outcome,
      error_class: input.errorClass,
      request_id: input.requestId,
      chat_session_id: null,
      turn_id: null,
      source_surface: "module_page",
      input_summary: input.inputSummary,
      duration_ms: input.durationMs
    })
    .execute();
}
