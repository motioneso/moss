import { randomUUID } from "node:crypto";

import type { AccessContext, DataContextRunner } from "@moss/db";
import type { ActionAuditInputSummary } from "@moss/shared";

import type { AiRepository, InsertAuditLogInput } from "../repository.js";
import type { ExecutableTool } from "./run-tool-handler.js";
import type { SessionTokenRegistry } from "./session-tokens.js";

/** The gateway services the audit writer needs: runner, repository, turn registry. */
export interface GatewayAuditDeps {
  readonly runner: DataContextRunner;
  readonly repository: AiRepository;
  readonly tokens: SessionTokenRegistry;
}

export async function recordGatewayAuditRaw(
  deps: GatewayAuditDeps,
  access: AccessContext,
  fields: {
    toolModuleId: string;
    toolName: string;
    actionFamilyId: string | null;
    actionKind: "write" | "outbound" | "destructive";
  },
  opts: {
    approvalMode: InsertAuditLogInput["approvalMode"];
    outcome: InsertAuditLogInput["outcome"];
    durationMs: number | null;
    errorClass?: string | null;
    chatSessionId?: string;
    inputSummary?: ActionAuditInputSummary | null;
    /** #2956: captured at tool-call arrival; survives an approval hold. */
    turnId?: string;
  }
): Promise<void> {
  // #2956: capture the turn BEFORE any await. These writers are invoked
  // fire-and-forget (`void recordGatewayAudit(...)`), so the body starts now —
  // but the write below lands later. An explicit id (an approval hold captured
  // it at arrival, before the hold) wins; otherwise the live turn is read.
  // Either way the id stays in a local; it never enters the context handed
  // to module tools.
  const turnId = opts.turnId ?? deps.tokens.readCurrentTurnId(opts.chatSessionId);
  try {
    await deps.runner.withDataContext(access, (scopedDb) =>
      deps.repository.insertActionAuditLog(scopedDb, {
        id: randomUUID(),
        ownerUserId: access.actorUserId,
        toolModuleId: fields.toolModuleId,
        toolName: fields.toolName,
        actionFamilyId: fields.actionFamilyId,
        actionKind: fields.actionKind,
        approvalMode: opts.approvalMode,
        outcome: opts.outcome,
        errorClass: opts.errorClass ?? null,
        requestId: access.requestId ?? null,
        chatSessionId: opts.chatSessionId ?? null,
        ...(turnId ? { turnId } : {}),
        sourceSurface: "chat",
        inputSummary: opts.inputSummary ?? null,
        durationMs: opts.durationMs
      })
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "audit_log_write_failed",
        toolName: fields.toolName,
        toolModuleId: fields.toolModuleId,
        approvalMode: opts.approvalMode,
        outcome: opts.outcome
      })
    );
  }
}

export async function recordGatewayAudit(
  deps: GatewayAuditDeps,
  access: AccessContext,
  found: ExecutableTool,
  opts: {
    approvalMode: InsertAuditLogInput["approvalMode"];
    outcome: InsertAuditLogInput["outcome"];
    durationMs: number | null;
    errorClass?: string | null;
    chatSessionId?: string;
    /** #2956: captured at tool-call arrival; survives an approval hold. */
    turnId?: string;
  }
): Promise<void> {
  return recordGatewayAuditRaw(
    deps,
    access,
    {
      toolModuleId: found.dto.moduleId,
      toolName: found.dto.name,
      actionFamilyId: found.tool.actionFamilyId ?? null,
      actionKind: found.tool.risk as "write" | "outbound" | "destructive"
    },
    opts
  );
}
