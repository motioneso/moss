import { randomUUID } from "node:crypto";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";

import { summarizeAssistantToolInput } from "../assistant-tools.js";
import type { AiRepository } from "../repository.js";
import type { ConfirmationRegistry } from "./confirmation-registry.js";
import { actionResultRecord, actionHoldDurationMs } from "./action-result-record.js";
import {
  APPROVAL_REFUSED_REASON,
  nativeToolRisk,
  nativeToolSummary,
  nativeYoloCanAutoAllow,
  safeNativeToolName
} from "./native-tool-guard.js";
import type { SessionTokenRegistry } from "./session-tokens.js";
import type { SessionNotifier } from "./types.js";

export interface NativeToolPermissionRequest {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly workingDirectory?: string;
}

export interface NativeToolPermissionResponse {
  readonly decision: "allow" | "deny";
  readonly reason: string;
}

export interface NativeToolPermissionDeps {
  readonly tokens: SessionTokenRegistry;
  readonly runner: DataContextRunner;
  readonly repository: Pick<
    AiRepository,
    "createPendingAssistantAction" | "resolveAssistantAction"
  >;
  readonly confirmations: ConfirmationRegistry;
  readonly notifier: SessionNotifier;
  readonly confirmTimeoutMs: number;
  readonly resolveLocalTimezone?: (actorUserId: string) => Promise<string | null>;
  readonly yoloMode?: (ctx: {
    readonly actorUserId: string;
    readonly requestId: string;
    readonly chatSessionId: string;
    readonly localTimezone?: string;
  }) => Promise<boolean>;
}

const NATIVE_TOOL_MODULE_ID = "claude-native";
const NATIVE_TOOL_MODULE_NAME = "Claude Native Tools";
// #1158: read-only native META-tools that must never require a user confirmation.
// Claude Code loads its MCP tool schemas lazily via the native ToolSearch tool; gating it
// behind the confirm flow deadlocks the permission hook (150s confirm wait == 150s hook
// deadline), the hook fails closed, claude retries in silence, and the #456 idle watchdog
// kills the live engine (prod outage 2026-07-18, issue #1157). Allow immediately with no
// pending action row — ToolSearch fires many times per conversation and cannot mutate
// anything, so a row per call is audit spam. Keep this set minimal: anything unlisted
// (including read-only tools like Grep/Read) stays on the confirm path.
const NATIVE_READONLY_AUTO_ALLOW = new Set(["ToolSearch"]);

export async function requestNativeToolPermission(
  deps: NativeToolPermissionDeps,
  token: string,
  request: NativeToolPermissionRequest
): Promise<NativeToolPermissionResponse> {
  const { actorUserId, chatSessionId } = deps.tokens.verify(token);
  const toolName = safeNativeToolName(request.toolName);
  if (toolName.startsWith("mcp__jarvis__") && toolName.length > "mcp__jarvis__".length) {
    return { decision: "allow", reason: "First-party Moss MCP transport." };
  }
  // #1158: read-only meta-tools return before any DB/timezone work — this is the hot path
  // (every conversation's first jarvis tool use goes through ToolSearch).
  if (NATIVE_READONLY_AUTO_ALLOW.has(toolName)) {
    return { decision: "allow", reason: "Read-only native tool." };
  }
  const input = request.toolInput;
  const requestId = `native_${randomUUID()}`;
  const access: AccessContext = { actorUserId, requestId };
  const ctx = {
    actorUserId,
    requestId,
    chatSessionId,
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
    })());

  if (yoloGranted) {
    // #1085 F4: Jarvis observes the permission grant, not the native tool's completion. Persist
    // that grant before allowing it instead of fire-and-forget auditing a fictional "success".
    await deps.runner.withDataContext(access, async (scopedDb: DataContextDb) => {
      const pending = await deps.repository.createPendingAssistantAction(scopedDb, {
        toolModuleId: NATIVE_TOOL_MODULE_ID,
        toolModuleName: NATIVE_TOOL_MODULE_NAME,
        toolName,
        permissionId: `${NATIVE_TOOL_MODULE_ID}.${toolName}`,
        risk: nativeToolRisk(toolName),
        inputSummary: summarizeAssistantToolInput(input),
        requestId
      });
      const confirmed = await deps.repository.resolveAssistantAction(scopedDb, pending.id, {
        status: "confirmed"
      });
      if (!confirmed) throw new Error("Could not persist native YOLO permission grant");
      return confirmed;
    });
    return { decision: "allow", reason: "Allowed by YOLO." };
  }

  const action = await deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
    deps.repository.createPendingAssistantAction(scopedDb, {
      toolModuleId: NATIVE_TOOL_MODULE_ID,
      toolModuleName: NATIVE_TOOL_MODULE_NAME,
      toolName,
      permissionId: `${NATIVE_TOOL_MODULE_ID}.${toolName}`,
      risk: nativeToolRisk(toolName),
      inputSummary: summarizeAssistantToolInput(input),
      requestId
    })
  );
  const pendingResolution = deps.confirmations.awaitResolution(action.id, deps.confirmTimeoutMs);

  deps.notifier.emit(chatSessionId, {
    kind: "action_request",
    actionRequestId: action.id,
    toolName,
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
      deps.notifier.emit(
        chatSessionId,
        actionResultRecord({
          actionRequestId: action.id,
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
                : APPROVAL_REFUSED_REASON
        })
      );
      return { decision: "deny", reason: APPROVAL_REFUSED_REASON };
    }

    deps.notifier.emit(
      chatSessionId,
      actionResultRecord({
        actionRequestId: action.id,
        toolName,
        outcome: "allowed",
        decidedBy: "person",
        holdDurationMs
      })
    );
    return { decision: "allow", reason: "Approved by user." };
  } finally {
    deps.confirmations.markDone(action.id);
  }
}
