import { freezeSnapshot } from "./per-call-resolution.js";
import { exactArgumentText } from "./pending-presentation.js";
import { randomUUID } from "node:crypto";
import type { AccessContext, DataContextDb } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { summarizeAssistantToolInput } from "../assistant-tools.js";
import type { AssistantToolGatewayDependencies } from "./gateway.js";
import { actionHoldDurationMs } from "./action-result-record.js";
import { isConversationTainted } from "./conversation-policy.js";
import { awaitActionResolution, emitPendingActionRequest } from "./action-request-lifecycle.js";
import { nativePolicyOutcomeTitle } from "./native-policy-outcome-title.js";
import { LAUNCH_REPLAY_REFUSAL } from "./session-tokens.js";
import {
  CONTEXT_ADMISSION_UNAVAILABLE,
  recordContextAdmission,
  runAutomaticAction
} from "./content-admission.js";
import {
  approvalRefusalReason,
  nativeToolRisk,
  nativeToolSummary,
  nativeYoloCanAutoAllow,
  safeNativeToolName
} from "./native-tool-guard.js";
import {
  emitNativePermissionResult,
  NATIVE_READONLY_AUTO_ALLOW,
  NATIVE_TOOL_MODULE_ID,
  NATIVE_TOOL_MODULE_NAME,
  type NativeToolPermissionRequest,
  type NativeToolPermissionResponse
} from "./native-tool-permission.js";

export async function requestNativeToolPermission(
  deps: AssistantToolGatewayDependencies,
  token: string,
  request: NativeToolPermissionRequest
): Promise<NativeToolPermissionResponse> {
  const { actorUserId, chatSessionId, threadId } = deps.tokens.verify(token);
  if (deps.tokens.isInLaunchReplay(token))
    return { decision: "deny", reason: LAUNCH_REPLAY_REFUSAL };
  const toolName = safeNativeToolName(request.toolName);
  const outcomeTitle = nativePolicyOutcomeTitle(toolName);
  if (toolName.startsWith("mcp__jarvis__") && toolName.length > "mcp__jarvis__".length) {
    return { decision: "allow", reason: "First-party Moss MCP transport." };
  }
  // #1158: read-only meta-tools return before any DB/timezone work — this is the hot path
  // (every conversation's first jarvis tool use goes through ToolSearch).
  if (NATIVE_READONLY_AUTO_ALLOW.has(toolName)) {
    return { decision: "allow", reason: "Read-only native tool." };
  }
  const input = freezeSnapshot(request.toolInput);
  if (exactArgumentText(input) === null)
    return { decision: "deny", reason: "Complete native tool details are unavailable." };
  const requestId = `native_${randomUUID()}`;
  const access: AccessContext = { actorUserId, requestId };
  const ctx: ToolContext = {
    actorUserId,
    requestId,
    chatSessionId,
    ...(threadId ? { threadId } : {}),
    localTimezone: (await deps.resolveLocalTimezone?.(actorUserId)) ?? undefined
  };

  const yoloGranted =
    (await nativeYoloCanAutoAllow(toolName, input, request.workingDirectory)) &&
    (await (async () => {
      try {
        return (await deps.yoloMode?.(ctx)) === true;
      } catch {
        return false;
      }
    })()) &&
    !(await isConversationTainted(deps.provenance, ctx));

  if (yoloGranted) {
    // Reserve the permission decision and create its pending record. A final grant is only
    // truthful after admission succeeds; the native operation itself remains unobserved.
    const automatic = await runAutomaticAction(deps.provenance, ctx, () =>
      deps.runner.withDataContext(access, async (scopedDb: DataContextDb) => {
        const pending = await deps.repository.createPendingAssistantAction(scopedDb, {
          chatThreadId: ctx.threadId,
          chatSessionId: ctx.chatSessionId,
          expiresAt: new Date(Date.now() + deps.confirmTimeoutMs),
          toolModuleId: NATIVE_TOOL_MODULE_ID,
          toolModuleName: NATIVE_TOOL_MODULE_NAME,
          toolName,
          permissionId: `${NATIVE_TOOL_MODULE_ID}.${toolName}`,
          risk: nativeToolRisk(toolName),
          inputSummary: summarizeAssistantToolInput(input),
          requestId
        });
        return pending;
      })
    );
    if (automatic.kind === "failed")
      return { decision: "deny", reason: CONTEXT_ADMISSION_UNAVAILABLE };
    if (automatic.kind === "ran") {
      const admitted = await admitNativeResult(deps, ctx);
      let resolved = false;
      try {
        resolved = Boolean(
          await deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
            deps.repository.resolveAssistantAction(scopedDb, automatic.value.id, {
              status: admitted ? "confirmed" : "cancelled"
            })
          )
        );
      } catch {
        /* An uncertain pending row must never be presented as a grant. */
      }
      if (!admitted || !resolved) {
        emitNativePermissionResult(deps.notifier, chatSessionId, {
          actionRequestId: automatic.value.id,
          ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
          toolName,
          outcome: "denied",
          decidedBy: "policy",
          ...(outcomeTitle ? { summary: outcomeTitle } : {}),
          holdDurationMs: null,
          reason: CONTEXT_ADMISSION_UNAVAILABLE
        });
        return { decision: "deny", reason: CONTEXT_ADMISSION_UNAVAILABLE };
      }
      return { decision: "allow", reason: "Allowed by YOLO." };
    }
  }

  const action = await deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
    deps.repository.createPendingAssistantAction(scopedDb, {
      chatThreadId: ctx.threadId,
      chatSessionId: ctx.chatSessionId,
      expiresAt: new Date(Date.now() + deps.confirmTimeoutMs),
      toolModuleId: NATIVE_TOOL_MODULE_ID,
      toolModuleName: NATIVE_TOOL_MODULE_NAME,
      toolName,
      permissionId: `${NATIVE_TOOL_MODULE_ID}.${toolName}`,
      risk: nativeToolRisk(toolName),
      inputSummary: summarizeAssistantToolInput(input),
      requestId
    })
  );
  const pendingResolution = awaitActionResolution(deps, access, action.id);

  emitPendingActionRequest(deps, actorUserId, chatSessionId, action, {
    kind: "action_request",
    nativePermission: true,
    actionRequestId: action.id,
    ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
    toolName,
    outsideContentNotice: await isConversationTainted(deps.provenance, ctx),
    summary: nativeToolSummary(toolName, input)
  });
  const holdStartedAt = Date.now();

  // #2149: markDone (in the finally below) unblocks resolveAndAwaitCompletion, which the
  // Approve/Deny HTTP route awaits before responding. This path has no handler to run — it
  // only grants a permission decision — but it still shares the wake-up mechanism with
  // confirmAndRun, so it must report back the same way or an Approve of a native tool would
  // hang waiting for a markDone that never comes.
  try {
    const outcome = await pendingResolution;
    const holdDurationMs = actionHoldDurationMs(holdStartedAt);
    if (outcome !== "confirmed") {
      emitNativePermissionResult(deps.notifier, chatSessionId, {
        actionRequestId: action.id,
        ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
        toolName,
        outcome: "denied",
        decidedBy:
          outcome === "timeout" ? "timeout" : outcome === "cancelled" ? "cancelled" : "person",
        holdDurationMs,
        reason:
          outcome === "timeout"
            ? "Action timed out."
            : outcome === "cancelled"
              ? "Action cancelled."
              : "You declined this action."
      });
      return { decision: "deny", reason: approvalRefusalReason(outcome) };
    }

    if (!(await admitNativeResult(deps, ctx))) {
      emitNativePermissionResult(deps.notifier, chatSessionId, {
        actionRequestId: action.id,
        ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
        toolName,
        outcome: "denied",
        decidedBy: "policy",
        ...(outcomeTitle ? { summary: outcomeTitle } : {}),
        holdDurationMs,
        reason: CONTEXT_ADMISSION_UNAVAILABLE
      });
      return { decision: "deny", reason: CONTEXT_ADMISSION_UNAVAILABLE };
    }
    // #1661: "allowed", not "executed". This method decides a native tool's PERMISSION and returns
    // `decision: "allow"` — the tool then runs outside the gateway's sight, so nothing here ever
    // learns whether it worked. Saying "executed" told the user the action completed on the
    // strength of their own click. The YOLO branch above already got this right and says why
    // (#1085 F4: observe the grant, never fire-and-forget a fictional success); this sibling
    // branch, forty lines down and doing the identical thing, was missed.
    emitNativePermissionResult(deps.notifier, chatSessionId, {
      actionRequestId: action.id,
      ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
      toolName,
      outcome: "allowed",
      decidedBy: "person",
      holdDurationMs
    });
    return { decision: "allow", reason: "Approved by user." };
  } finally {
    deps.confirmations.markDone(action.id);
  }
}

async function admitNativeResult(
  deps: AssistantToolGatewayDependencies,
  ctx: ToolContext
): Promise<boolean> {
  try {
    // Native result delivery is outside the server's observation. Conservatively mark before
    // granting, including approved non-vault reads, web, shell and delegated-agent output.
    await recordContextAdmission(deps.provenance, ctx, "native_tool_result");
    return true;
  } catch {
    return false;
  }
}
