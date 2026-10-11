import type { ToolContext } from "@moss/module-sdk";
import { emitActionResultRecord } from "./action-result-record.js";
import { renderAndCap } from "./output-validation.js";
import type { GatewayToolResponse, SessionNotifier } from "./types.js";

/** Validation did no work: keep the route-style 400 result without granting or approving a write. */
export function inputValidationFailure(title: string, message: string) {
  const data = { ok: false, status: 400, body: { code: "invalid_input", error: message } };
  return {
    failure: {
      ok: true,
      data: renderAndCap(undefined, { data }),
      structuredData: data
    } satisfies GatewayToolResponse,
    reason: "invalid_input" as const,
    validationTitle: title
  };
}

/** No private validation values are persisted in the terminal outcome. */
export function emitInputValidationFailure(
  notifier: SessionNotifier,
  ctx: ToolContext,
  toolName: string,
  title: string
): void {
  emitActionResultRecord(notifier, ctx.chatSessionId, {
    actionRequestId: ctx.requestId,
    ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
    toolName,
    outcome: "error",
    decidedBy: "policy",
    holdDurationMs: null,
    summary: title,
    reason: "invalid_input"
  });
}
