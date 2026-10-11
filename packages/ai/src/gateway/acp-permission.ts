import { freezeSnapshot } from "./per-call-resolution.js";
import { exactArgumentText } from "./pending-presentation.js";
/**
 * Outside-agent built-in permission asks (#2380, spec 6.3/6.4).
 *
 * Same approval system as every other ask, not a second one: the automatic
 * policy (`@moss/acp`) allows in-folder reads and writes outright and refuses
 * the unrecognised without a row. Effective actor YOLO auto-approves eligible
 * asks; otherwise anything needing a person creates the
 * same pending row and emits the same `action_request` event the approval
 * card already listens for. Lives here rather than in gateway.ts so that file
 * stays under the size gate; the class keeps a thin delegate.
 */

import { randomUUID } from "node:crypto";

import {
  ACP_DESTRUCTIVE_TOOL_NAMES,
  acpRequestFamily,
  classifyAcpPermission,
  decideAcpPermission,
  extractAcpCommand,
  extractAcpPaths,
  extractAcpWebAddress,
  type AcpBuiltInRequest,
  type AcpToolCallLocation
} from "@moss/acp";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import type { ActionAuditAgentSummary, ActionAuditInputSummary } from "@moss/shared";

import { summarizeAssistantToolInput } from "../assistant-tools.js";
import type { AiRepository } from "../repository.js";
import type { ConfirmationRegistry } from "./confirmation-registry.js";
import { isConversationMarked, isConversationTainted } from "./conversation-policy.js";
import {
  CONTEXT_ADMISSION_UNAVAILABLE,
  recordContextAdmission,
  runAutomaticAction
} from "./content-admission.js";
import { actionResultRecord } from "./action-result-record.js";
import { awaitActionResolution, emitPendingActionRequest } from "./action-request-lifecycle.js";
import { nativePolicyOutcomeTitle } from "./native-policy-outcome-title.js";
import { APPROVAL_REFUSED_REASON, approvalRefusalReason } from "./native-tool-guard.js";
import type { SessionTokenRegistry } from "./session-tokens.js";
import type { AdmissionPath, ConversationProvenancePort, SessionNotifier } from "./types.js";

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
  /** Identity of the prompt turn that created this ask. */
  readonly turnId: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolName: string | null;
  readonly kind?: string | null;
  /** Announced file locations; scope only, never identity. */
  readonly locations?: readonly AcpToolCallLocation[] | null;
}

export interface AcpBuiltInPermissionResponse {
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly asked?: boolean;
  readonly holdDurationMs?: number | null;
}

/** Narrow view of the gateway dependencies this ask needs. */
export interface AcpPermissionGatewayDeps {
  readonly repository: Pick<
    AiRepository,
    | "createPendingAssistantAction"
    | "insertActionAuditLog"
    | "getAssistantAction"
    | "resolveAssistantAction"
    | "expireAssistantAction"
  >;
  readonly runner: DataContextRunner;
  readonly tokens: SessionTokenRegistry;
  readonly confirmations: ConfirmationRegistry;
  readonly notifier: SessionNotifier;
  readonly confirmTimeoutMs: number;
  readonly yoloMode?: (ctx: ToolContext) => Promise<boolean>;
  readonly provenance?: ConversationProvenancePort;
}

const ACP_TOOL_MODULE_ID = "acp-builtin";
const ACP_TOOL_MODULE_NAME = "Agent Built-in Tools";
/** Bounds on what the saved record carries about a request: identifiers only. */
const MAX_SUMMARY_PATHS = 5;
const MAX_SUMMARY_PATH_LENGTH = 200;

type AcpAuditMode = "auto" | "yolo" | "confirmed" | "rejected" | "cancelled" | "timeout";
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
  decision: ActionAuditAgentSummary["decision"],
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
 * shell run (it rides the live stream only, never the row). Otherwise show
 * the exact input rather than trusting the agent's description. No display truncation.
 */
export function acpCardText(request: AcpBuiltInRequest): string {
  const lead = `The agent wants to use ${request.toolName ?? "an unnamed tool"}`;
  const family = acpRequestFamily(request);
  if (family === "read" || family === "write") {
    const paths = extractAcpPaths(request);
    if (paths.length > 0) return `${lead}: ${paths.join(", ")}`;
  }
  if (family === "web") {
    const address = extractAcpWebAddress(request);
    if (address !== null) return `${lead}: ${address}`;
  }
  if (family === "shell") {
    const command = extractAcpCommand(request);
    if (command !== null) return `${lead}: ${command}`;
  }
  return `${lead}:\n${JSON.stringify(request.rawInput, null, 2)}`;
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
    /** #2956: captured at ask arrival; survives an approval hold. */
    turnId?: string;
  }
): Promise<void> {
  // #2956: capture the turn BEFORE any await. An explicit id (an approval
  // hold captured it at arrival) wins; otherwise the live turn is read.
  const turnId = line.turnId ?? deps.tokens.readCurrentTurnId(chatSessionId);
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
        ...(turnId ? { turnId } : {}),
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
  const { actorUserId, chatSessionId, threadId } = deps.tokens.verify(token);
  const input = freezeSnapshot(request.toolInput);
  if (exactArgumentText(input) === null)
    return { decision: "deny", reason: "Complete native tool details are unavailable." };
  const requestId = `acp_${randomUUID()}`;
  const access: AccessContext = { actorUserId, requestId };
  // #2956: the ask below can pend on approval past the turn's end; the turn is
  // captured at arrival and handed to each audit write explicitly.
  const arrivalTurnId = deps.tokens.readCurrentTurnId(chatSessionId);
  const folders = { cwd: request.cwd, home: request.home };
  const builtIn: AcpBuiltInRequest = {
    sessionId: request.sessionId,
    turnId: request.turnId,
    toolCallId: request.toolCallId,
    title: request.title,
    rawInput: input,
    toolName: request.toolName,
    kind: request.kind ?? null,
    locations: request.locations ? freezeSnapshot(request.locations) : null
  };
  const actionKind = acpActionKind(builtIn);
  const summarize = (decision: ActionAuditAgentSummary["decision"], reason: string | null) => ({
    ...summarizeAssistantToolInput(input),
    agent: acpAgentSummary(builtIn, request.cwd, decision, reason)
  });

  const startedAt = Date.now();
  const family = acpRequestFamily(builtIn);
  const outcomeTitle = nativePolicyOutcomeTitle(builtIn.toolName);
  const ctx: ToolContext = {
    actorUserId,
    requestId,
    chatSessionId,
    ...(threadId ? { threadId } : {})
  };
  const admissionPath: AdmissionPath | undefined =
    family === "read"
      ? "outside_agent_read"
      : family === "web"
        ? "outside_agent_web"
        : family === "shell"
          ? "outside_agent_shell"
          : undefined;
  let admissionDenied = false;
  const admitAllowed = async (): Promise<boolean> => {
    if (!admissionPath) return true;
    try {
      await recordContextAdmission(deps.provenance, ctx, admissionPath);
      return true;
    } catch {
      admissionDenied = true;
      return false;
    }
  };
  const classification = classifyAcpPermission(builtIn, folders);
  const conversationTainted = await isConversationTainted(deps.provenance, {
    actorUserId,
    ...(threadId ? { threadId } : {})
  });
  const taintRequiresApproval =
    conversationTainted &&
    (family === "write" ||
      family === "shell" ||
      family === "web" ||
      classification.verdict === "ask");
  let yoloAnswer: Promise<boolean> | undefined;
  const yoloOn = () =>
    (yoloAnswer ??= Promise.resolve(
      deps.yoloMode?.({ actorUserId, requestId, chatSessionId, ...(threadId ? { threadId } : {}) })
    ).then((on) => on === true));
  // The card names outside content only when a clean conversation would allow with no card.
  const outsideContentCaused = async () =>
    (classification.verdict === "allow" ||
      (classification.verdict === "ask" && (await yoloOn().catch(() => false)))) &&
    (await isConversationMarked(deps.provenance, ctx));
  // Reuse the effective actor setting on every eligible ask; never override hard denials.
  if (
    !taintRequiresApproval &&
    classification.verdict === "ask" &&
    (await yoloOn()) &&
    !(await isConversationTainted(deps.provenance, {
      actorUserId,
      ...(threadId ? { threadId } : {})
    }))
  ) {
    const auditPermission = (admitted: boolean) =>
      writeAcpAuditLine(deps, access, chatSessionId, {
        toolName: builtIn.toolName ?? "(unnamed)",
        actionKind,
        mode: "yolo",
        outcome: admitted ? "success" : "failed",
        errorClass: admitted ? null : "content_admission",
        durationMs: Date.now() - startedAt,
        inputSummary: summarize(
          admitted ? "allowed" : "refused",
          admitted ? "yolo" : CONTEXT_ADMISSION_UNAVAILABLE
        ),
        ...(arrivalTurnId ? { turnId: arrivalTurnId } : {})
      });
    const automatic = await runAutomaticAction(deps.provenance, ctx, async () => {
      // Pure write permission has no result-admission path; keep its decision audit guarded.
      // Reads/web/shell acquire durable taint before their final audit and allow delivery.
      if (!admissionPath) await auditPermission(true);
    });
    if (automatic.kind === "failed")
      return {
        decision: "deny",
        reason: CONTEXT_ADMISSION_UNAVAILABLE,
        asked: false,
        holdDurationMs: null
      };
    if (automatic.kind === "ran") {
      const admitted = await admitAllowed();
      if (admissionPath) await auditPermission(admitted);
      if (!admitted)
        deps.notifier.emit(
          chatSessionId,
          actionResultRecord({
            actionRequestId: builtIn.toolCallId,
            ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
            toolName: builtIn.toolName ?? "(unnamed)",
            outcome: "denied",
            decidedBy: "policy",
            ...(outcomeTitle ? { summary: outcomeTitle } : {}),
            holdDurationMs: null,
            reason: CONTEXT_ADMISSION_UNAVAILABLE
          })
        );
      return {
        decision: admitted ? "allow" : "deny",
        reason: admissionDenied ? CONTEXT_ADMISSION_UNAVAILABLE : "Allowed by YOLO mode.",
        asked: false,
        holdDurationMs: null
      };
    }
  }
  let humanHoldDurationMs: number | null = null;
  let modelRefusalReason = APPROVAL_REFUSED_REASON;
  const ask = async (): Promise<"allow" | "deny"> => {
    const toolName = builtIn.toolName ?? "";
    const action = await deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
      deps.repository.createPendingAssistantAction(scopedDb, {
        chatThreadId: ctx.threadId,
        chatSessionId: ctx.chatSessionId,
        expiresAt: new Date(Date.now() + deps.confirmTimeoutMs),
        toolModuleId: ACP_TOOL_MODULE_ID,
        toolModuleName: ACP_TOOL_MODULE_NAME,
        toolName,
        permissionId: `${ACP_TOOL_MODULE_ID}.${toolName}`,
        risk: actionKind,
        inputSummary: summarize("asked", null),
        requestId
      })
    );

    const pendingResolution = awaitActionResolution(
      deps,
      access,
      action.id,
      request.sessionId,
      request.turnId
    );

    emitPendingActionRequest(deps, actorUserId, chatSessionId, action, {
      kind: "action_request",
      nativePermission: true,
      actionRequestId: action.id,
      ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
      toolName,
      outsideContentNotice: await outsideContentCaused(),
      summary: acpCardText(builtIn)
    });
    const holdStartedAt = Date.now();

    try {
      const resolution = await pendingResolution;
      const outcome =
        resolution === "confirmed" && !(await admitAllowed()) ? "admission_failed" : resolution;
      if (resolution !== "confirmed") modelRefusalReason = approvalRefusalReason(resolution);
      const holdDurationMs = Math.max(0, Date.now() - holdStartedAt);
      humanHoldDurationMs = holdDurationMs;
      deps.notifier.emit(
        chatSessionId,
        actionResultRecord(
          outcome === "confirmed"
            ? {
                actionRequestId: action.id,
                ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
                toolName,
                outcome: "allowed",
                decidedBy: "person",
                holdDurationMs
              }
            : {
                actionRequestId: action.id,
                ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
                toolName,
                outcome: "denied",
                ...(outcome === "admission_failed" && outcomeTitle
                  ? { summary: outcomeTitle }
                  : {}),
                decidedBy:
                  outcome === "admission_failed"
                    ? "policy"
                    : outcome === "timeout"
                      ? "timeout"
                      : outcome === "cancelled"
                        ? "cancelled"
                        : "person",
                holdDurationMs,
                reason:
                  outcome === "admission_failed"
                    ? CONTEXT_ADMISSION_UNAVAILABLE
                    : outcome === "timeout"
                      ? "Action timed out."
                      : outcome === "cancelled"
                        ? "Action cancelled."
                        : "You declined this action."
              }
        )
      );
      await writeAcpAuditLine(deps, access, chatSessionId, {
        toolName,
        actionKind,
        mode:
          resolution === "confirmed"
            ? "confirmed"
            : outcome === "timeout"
              ? "timeout"
              : outcome === "cancelled"
                ? "cancelled"
                : "rejected",
        outcome: outcome === "confirmed" ? "success" : "failed",
        errorClass: outcome === "confirmed" ? null : outcome,
        durationMs: Date.now() - startedAt,
        inputSummary: summarize("asked", null),
        ...(arrivalTurnId ? { turnId: arrivalTurnId } : {})
      });
      return outcome === "confirmed" ? "allow" : "deny";
    } finally {
      deps.confirmations.markDone(action.id);
    }
  };
  // The folder policy may ordinarily allow a local write. A tainted conversation raises that
  // floor to the same approval callback; it never overrides an existing hard denial.
  let result: Awaited<ReturnType<typeof decideAcpPermission>>;
  if (classification.verdict === "allow" && (family === "write" || family === "web")) {
    const automatic = taintRequiresApproval
      ? { kind: "confirm" as const }
      : await runAutomaticAction(deps.provenance, ctx, async () => true);
    if (automatic.kind === "failed")
      return {
        decision: "deny",
        reason: CONTEXT_ADMISSION_UNAVAILABLE,
        asked: false,
        holdDurationMs: null
      };
    result =
      automatic.kind === "confirm"
        ? { decision: await ask(), asked: true, reason: null }
        : { decision: "allow", asked: false, reason: null };
  } else {
    result = await decideAcpPermission(builtIn, folders, ask);
  }
  if (result.decision === "allow" && !result.asked && !(await admitAllowed())) {
    return {
      decision: "deny",
      reason: CONTEXT_ADMISSION_UNAVAILABLE,
      asked: false,
      holdDurationMs: null
    };
  }

  const holdDurationMs = result.asked ? humanHoldDurationMs : null;
  if (!result.asked && result.decision === "deny") {
    deps.notifier.emit(
      chatSessionId,
      actionResultRecord({
        actionRequestId: builtIn.toolCallId,
        ...(ctx.threadId ? { originThreadId: ctx.threadId } : {}),
        toolName: builtIn.toolName ?? "(unnamed)",
        outcome: "denied",
        decidedBy: "policy",
        ...(outcomeTitle ? { summary: outcomeTitle } : {}),
        holdDurationMs: null,
        ...(result.reason ? { reason: result.reason } : {})
      })
    );
  }
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
      inputSummary: summarize("refused", result.reason),
      ...(arrivalTurnId ? { turnId: arrivalTurnId } : {})
    });
    return {
      decision: "deny",
      reason: APPROVAL_REFUSED_REASON,
      asked: false,
      holdDurationMs: null
    };
  }
  return {
    decision: result.decision === "allow" ? "allow" : "deny",
    reason: admissionDenied
      ? CONTEXT_ADMISSION_UNAVAILABLE
      : result.asked
        ? result.decision === "allow"
          ? "Approved by user."
          : modelRefusalReason
        : result.decision === "allow"
          ? "Allowed by policy."
          : APPROVAL_REFUSED_REASON,
    asked: result.asked,
    holdDurationMs
  };
}
