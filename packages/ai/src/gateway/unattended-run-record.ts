import type { ToolContext } from "@moss/module-sdk";

import { emitActionResultRecord } from "./action-result-record.js";
import { recordGatewayAudit, type GatewayAuditDeps } from "./gateway-audit.js";
import { gatewayFailureReason } from "./native-tool-guard.js";
import { liveStreamResult } from "./output-validation.js";
import type { ExecutableTool, RunHandlerOutcome } from "./run-tool-handler.js";
import type { SessionNotifier } from "./types.js";

/** Report the completed run separately from permission, retaining its pre-dispatch title. */
export function recordUnattendedRun(
  deps: GatewayAuditDeps & { readonly notifier: SessionNotifier },
  found: ExecutableTool,
  ctx: ToolContext,
  approvalMode: "yolo" | "auto",
  completed: RunHandlerOutcome,
  summary: string | undefined
): void {
  const { response: result, audit } = completed;
  emitActionResultRecord(deps.notifier, ctx.chatSessionId, {
    actionRequestId: ctx.requestId,
    ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
    toolName: found.dto.name,
    outcome: audit.errorClass === null ? "executed" : "error",
    decidedBy: "policy",
    ...(summary ? { summary } : {}),
    holdDurationMs: null,
    ...(result.ok
      ? { result: liveStreamResult(found.tool, result) }
      : { reason: gatewayFailureReason(result) }),
    ...(result.ok && audit.outcome === "success" && found.tool.affectsQueryKeys
      ? { affectsQueryKeys: found.tool.affectsQueryKeys }
      : {}),
    ...(result.ok && audit.outcome === "success" && found.tool.risk !== "read"
      ? { affectsModules: found.resolution?.affectsModules ?? [found.dto.moduleId] }
      : {})
  });
  void recordGatewayAudit(deps, { actorUserId: ctx.actorUserId, requestId: ctx.requestId }, found, {
    approvalMode,
    ...audit,
    chatSessionId: ctx.chatSessionId
  });
}
