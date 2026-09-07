/**
 * Outside-agent built-in permission asks (#2380, spec 6.3/6.4).
 *
 * Same approval system as every other ask, not a second one: the automatic
 * policy allows read-only tools and in-folder writes outright and refuses the
 * unrecognised without a row, while anything needing a person creates the
 * same pending row and emits the same `action_request` event the approval
 * card already listens for. Lives here rather than in gateway.ts so that file
 * stays under the size gate; the class keeps a thin delegate.
 */

import { randomUUID } from "node:crypto";

import { ACP_DESTRUCTIVE_TOOL_NAMES, decideAcpPermission } from "@moss/acp";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";

import { summarizeAssistantToolInput } from "../assistant-tools.js";
import type { AiRepository } from "../repository.js";
import type { ConfirmationRegistry } from "./confirmation-registry.js";
import { APPROVAL_REFUSED_REASON } from "./native-tool-guard.js";
import type { SessionTokenRegistry } from "./session-tokens.js";
import type { SessionNotifier } from "./types.js";
import type { NativeToolPermissionResponse } from "./gateway.js";

/**
 * One built-in tool ask from the outside agent (ACP `session/request_permission`).
 * `toolName` is the real name the adapter carries in `toolCall._meta`, written
 * by adapter platform code — never the model-written display title, which
 * travels alongside only for the card text. Identity of the person always comes
 * from the verified session token, never from these fields.
 */
export interface AcpBuiltInPermissionRequest {
  readonly cwd: string;
  /** The HOME handed to the agent process, or null when it names none. */
  readonly home: string | null;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolName: string | null;
  readonly kind?: string | null;
}

export type AcpBuiltInPermissionResponse = NativeToolPermissionResponse;

/** Narrow view of the gateway dependencies this ask needs. */
export interface AcpPermissionGatewayDeps {
  readonly repository: Pick<AiRepository, "createPendingAssistantAction" | "insertActionAuditLog">;
  readonly runner: DataContextRunner;
  readonly tokens: SessionTokenRegistry;
  readonly confirmations: ConfirmationRegistry;
  readonly notifier: SessionNotifier;
  readonly confirmTimeoutMs: number;
}

const ACP_TOOL_MODULE_ID = "acp-builtin";
const ACP_TOOL_MODULE_NAME = "Agent Built-in Tools";

type AcpAuditMode = "auto" | "confirmed" | "rejected" | "timeout";

/**
 * One audit line for an ask outcome or a refusal. Mirrors the gateway's
 * recordAuditRaw field mapping (same table, same no-content rule); the two
 * are twins to keep in sync. A failed write never fails the permission
 * answer — it is said out loud instead.
 */
async function writeAcpAuditLine(
  deps: AcpPermissionGatewayDeps,
  access: AccessContext,
  chatSessionId: string,
  line: {
    toolName: string;
    actionKind: "write" | "destructive";
    mode: AcpAuditMode;
    outcome: "success" | "failed";
    errorClass: string | null;
    durationMs: number | null;
  }
): Promise<void> {
  try {
    await deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
      deps.repository.insertActionAuditLog(scopedDb, {
        id: randomUUID(),
        ownerUserId: access.actorUserId,
        toolModuleId: ACP_TOOL_MODULE_ID,
        toolName: line.toolName,
        actionFamilyId: null,
        actionKind: line.actionKind,
        approvalMode: line.mode,
        outcome: line.outcome,
        errorClass: line.errorClass,
        requestId: access.requestId ?? null,
        chatSessionId,
        sourceSurface: "chat",
        inputSummary: null,
        durationMs: line.durationMs
      })
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "audit_log_write_failed",
        toolName: line.toolName,
        toolModuleId: ACP_TOOL_MODULE_ID,
        approvalMode: line.mode,
        outcome: line.outcome
      })
    );
  }
}

/**
 * Decide one outside-agent built-in tool ask. The row owner is the token's
 * actor, so the audit records who approved by the token that carried the
 * request. The session tool allowlist is not consulted: built-in names are
 * outside that list.
 */
export async function requestAcpBuiltInPermission(
  deps: AcpPermissionGatewayDeps,
  token: string,
  request: AcpBuiltInPermissionRequest
): Promise<AcpBuiltInPermissionResponse> {
  const { actorUserId, chatSessionId } = deps.tokens.verify(token);
  const input = request.toolInput;
  const requestId = `acp_${randomUUID()}`;
  const access: AccessContext = { actorUserId, requestId };
  const folders = { cwd: request.cwd, home: request.home };
  const actionKind =
    ACP_DESTRUCTIVE_TOOL_NAMES.has(request.toolName ?? "") ||
    request.kind === "execute" ||
    request.kind === "delete" ||
    request.kind === "move"
      ? "destructive"
      : "write";

  // No name means only model-written text arrived: unrecognised, refused with
  // no row but an audit line, so the refusal itself stays visible.
  if (request.toolName === null) {
    await writeAcpAuditLine(deps, access, chatSessionId, {
      toolName: "Unknown",
      actionKind: "write",
      mode: "auto",
      outcome: "failed",
      errorClass: "unknown_tool",
      durationMs: null
    });
    return { decision: "deny", reason: APPROVAL_REFUSED_REASON };
  }
  const toolName = request.toolName;

  const startedAt = Date.now();
  const result = await decideAcpPermission(
    {
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      title: request.title,
      rawInput: input,
      toolName,
      kind: request.kind ?? null,
      locations: null
    },
    folders,
    async () => {
      const action = await deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
        deps.repository.createPendingAssistantAction(scopedDb, {
          toolModuleId: ACP_TOOL_MODULE_ID,
          toolModuleName: ACP_TOOL_MODULE_NAME,
          toolName,
          permissionId: `${ACP_TOOL_MODULE_ID}.${toolName}`,
          risk: actionKind,
          // The saved record names the agent session and folder as plain
          // identifiers, so a later reader can tell which agent was approved
          // for what. Values stay out: input keys only, never content.
          inputSummary: {
            ...summarizeAssistantToolInput(input),
            agentSessionId: request.sessionId,
            sessionFolder: request.cwd
          },
          requestId
        })
      );

      const pendingResolution = deps.confirmations.awaitResolution(
        action.id,
        deps.confirmTimeoutMs
      );

      deps.notifier.emit(chatSessionId, {
        kind: "action_request",
        actionRequestId: action.id,
        toolName,
        summary:
          `Agent ${request.sessionId} in ${request.cwd} wants to use ` +
          `${toolName} (${request.title.slice(0, 200)}).`
      });

      try {
        const outcome = await pendingResolution;
        if (outcome !== "confirmed") {
          deps.notifier.emit(chatSessionId, {
            kind: "action_result",
            actionRequestId: action.id,
            toolName,
            outcome: "denied",
            reason: APPROVAL_REFUSED_REASON
          });
        } else {
          deps.notifier.emit(chatSessionId, {
            kind: "action_result",
            actionRequestId: action.id,
            toolName,
            outcome: "allowed"
          });
        }
        await writeAcpAuditLine(deps, access, chatSessionId, {
          toolName,
          actionKind,
          mode:
            outcome === "confirmed" ? "confirmed" : outcome === "timeout" ? "timeout" : "rejected",
          outcome: outcome === "confirmed" ? "success" : "failed",
          errorClass: outcome === "confirmed" ? null : outcome,
          durationMs: Date.now() - startedAt
        });
        return outcome === "confirmed" ? "allow" : "deny";
      } finally {
        deps.confirmations.markDone(action.id);
      }
    }
  );

  if (!result.asked && result.decision === "deny" && result.reason) {
    await writeAcpAuditLine(deps, access, chatSessionId, {
      toolName,
      actionKind,
      mode: "auto",
      outcome: "failed",
      errorClass: result.reason,
      durationMs: null
    });
    return { decision: "deny", reason: APPROVAL_REFUSED_REASON };
  }
  return result.decision === "allow"
    ? { decision: "allow", reason: result.asked ? "Approved by user." : "Allowed by policy." }
    : { decision: "deny", reason: APPROVAL_REFUSED_REASON };
}
