/**
 * Outside-agent built-in permission asks (#2380, spec 6.3/6.4).
 *
 * Same approval system as every other ask, not a second one: the automatic
 * policy (`@moss/acp`) allows in-folder reads and writes outright and refuses
 * the unrecognised without a row, while anything needing a person creates the
 * same pending row and emits the same `action_request` event the approval
 * card already listens for. Lives here rather than in gateway.ts so that file
 * stays under the size gate; the class keeps a thin delegate.
 */

import { randomUUID } from "node:crypto";

import {
  ACP_DESTRUCTIVE_TOOL_NAMES,
  acpRequestFamily,
  decideAcpPermission,
  extractAcpCommand,
  extractAcpPaths,
  extractAcpWebAddress,
  type AcpBuiltInRequest,
  type AcpToolCallLocation
} from "@moss/acp";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { ActionAuditAgentSummary, ActionAuditInputSummary } from "@moss/shared";

import { summarizeAssistantToolInput } from "../assistant-tools.js";
import type { AiRepository } from "../repository.js";
import type { ConfirmationRegistry } from "./confirmation-registry.js";
import { APPROVAL_REFUSED_REASON } from "./native-tool-guard.js";
import type { SessionTokenRegistry } from "./session-tokens.js";
import type { SessionNotifier } from "./types.js";
import type { NativeToolPermissionResponse } from "./gateway.js";

/**
 * One built-in tool ask from the outside agent (ACP `session/request_permission`).
 * `toolName` is the real name the adapter carries in the tool-call announcement's
 * `_meta`, written by adapter platform code — never the model-written display
 * title, which travels alongside only for the card text. Identity of the person
 * always comes from the verified session token, never from these fields.
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
  /** Announced file locations; scope only, never identity. */
  readonly locations?: readonly AcpToolCallLocation[] | null;
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
/** Bounds on what the saved record carries about a request: identifiers only. */
const MAX_SUMMARY_PATHS = 5;
const MAX_SUMMARY_PATH_LENGTH = 200;
/** The card shows the agent's own description at most this long. */
const MAX_CARD_TEXT = 200;

type AcpAuditMode = "auto" | "confirmed" | "rejected" | "cancelled" | "timeout";
type AcpActionKind = "write" | "outbound" | "destructive";

/**
 * Seriousness shown on the card. Shell is destructive; writes are writes;
 * reads and fetches that reach a person do so because information may leave
 * the project's bounds, which is what "outbound" names. The announced kind
 * can only raise seriousness, never lower it.
 */
function acpActionKind(request: AcpBuiltInRequest): AcpActionKind {
  if (ACP_DESTRUCTIVE_TOOL_NAMES.has(request.toolName ?? "")) return "destructive";
  if (request.kind === "execute" || request.kind === "delete" || request.kind === "move") {
    return "destructive";
  }
  const family = acpRequestFamily(request);
  return family === "read" || family === "web" ? "outbound" : "write";
}

/**
 * The saved record: plain identifiers a later reader can use to tell which
 * agent was approved for what, plus the paths a read or write named. Never
 * a command, never file contents.
 */
function acpAgentSummary(
  request: AcpBuiltInRequest,
  cwd: string,
  decision: "asked" | "refused",
  reason: string | null
): ActionAuditAgentSummary {
  const family = acpRequestFamily(request);
  const paths =
    family === "read" || family === "write"
      ? extractAcpPaths(request)
          .slice(0, MAX_SUMMARY_PATHS)
          .map((path) => path.slice(0, MAX_SUMMARY_PATH_LENGTH))
      : [];
  return {
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName ?? "",
    cwd,
    paths,
    decision,
    reason
  };
}

/**
 * What the person reads on the card: the real name, then the thing decided
 * on — the paths for a file tool, the address for a fetch, the command for a
 * shell run (it rides the live stream only, never the row). Anything else
 * shows the agent's own description, labelled as such.
 */
export function acpCardText(request: AcpBuiltInRequest): string {
  const lead = `The agent wants to use ${request.toolName ?? "an unnamed tool"}`;
  const family = acpRequestFamily(request);
  if (family === "read" || family === "write") {
    const paths = extractAcpPaths(request);
    if (paths.length > 0) return `${lead}: ${paths.join(", ").slice(0, MAX_CARD_TEXT)}`;
  }
  if (family === "web") {
    const address = extractAcpWebAddress(request);
    if (address !== null) return `${lead}: ${address.slice(0, MAX_CARD_TEXT)}`;
  }
  if (family === "shell") {
    const command = extractAcpCommand(request);
    if (command !== null) return `${lead}: ${command.slice(0, MAX_CARD_TEXT)}`;
  }
  const title = request.title.trim();
  return title === ""
    ? `${lead}.`
    : `${lead} (its own description: "${title.slice(0, MAX_CARD_TEXT)}").`;
}

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
    actionKind: AcpActionKind;
    mode: AcpAuditMode;
    outcome: "success" | "failed";
    errorClass: string | null;
    durationMs: number | null;
    inputSummary: ActionAuditInputSummary;
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
        inputSummary: line.inputSummary,
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
  const builtIn: AcpBuiltInRequest = {
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    title: request.title,
    rawInput: input,
    toolName: request.toolName,
    kind: request.kind ?? null,
    locations: request.locations ?? null
  };
  const actionKind = acpActionKind(builtIn);
  const summarize = (decision: "asked" | "refused", reason: string | null) => ({
    ...summarizeAssistantToolInput(input),
    agent: acpAgentSummary(builtIn, request.cwd, decision, reason)
  });

  const startedAt = Date.now();
  const result = await decideAcpPermission(builtIn, folders, async () => {
    const toolName = builtIn.toolName ?? "";
    const action = await deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
      deps.repository.createPendingAssistantAction(scopedDb, {
        toolModuleId: ACP_TOOL_MODULE_ID,
        toolModuleName: ACP_TOOL_MODULE_NAME,
        toolName,
        permissionId: `${ACP_TOOL_MODULE_ID}.${toolName}`,
        risk: actionKind,
        inputSummary: summarize("asked", null),
        requestId
      })
    );

    const pendingResolution = deps.confirmations.awaitResolution(action.id, deps.confirmTimeoutMs);

    deps.notifier.emit(chatSessionId, {
      kind: "action_request",
      actionRequestId: action.id,
      toolName,
      summary: acpCardText(builtIn)
    });

    try {
      const outcome = await pendingResolution;
      deps.notifier.emit(
        chatSessionId,
        outcome === "confirmed"
          ? { kind: "action_result", actionRequestId: action.id, toolName, outcome: "allowed" }
          : {
              kind: "action_result",
              actionRequestId: action.id,
              toolName,
              outcome: "denied",
              reason: outcome === "cancelled" ? "Action cancelled." : APPROVAL_REFUSED_REASON
            }
      );
      await writeAcpAuditLine(deps, access, chatSessionId, {
        toolName,
        actionKind,
        mode:
          outcome === "confirmed"
            ? "confirmed"
            : outcome === "timeout"
              ? "timeout"
              : outcome === "cancelled"
                ? "cancelled"
                : "rejected",
        outcome: outcome === "confirmed" ? "success" : "failed",
        errorClass: outcome === "confirmed" ? null : outcome,
        durationMs: Date.now() - startedAt,
        inputSummary: summarize("asked", null)
      });
      return outcome === "confirmed" ? "allow" : "deny";
    } finally {
      deps.confirmations.markDone(action.id);
    }
  });

  if (!result.asked && result.decision === "deny" && result.reason) {
    // Refused with no row, but never silently: the audit line names the agent,
    // the folder and the reason word, so the refusal itself stays visible.
    await writeAcpAuditLine(deps, access, chatSessionId, {
      toolName: builtIn.toolName ?? "(unnamed)",
      actionKind,
      mode: "auto",
      outcome: "failed",
      errorClass: result.reason,
      durationMs: null,
      inputSummary: summarize("refused", result.reason)
    });
    return { decision: "deny", reason: APPROVAL_REFUSED_REASON };
  }
  return result.decision === "allow"
    ? { decision: "allow", reason: result.asked ? "Approved by user." : "Allowed by policy." }
    : { decision: "deny", reason: APPROVAL_REFUSED_REASON };
}
