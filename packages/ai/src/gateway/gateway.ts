import { randomUUID } from "node:crypto";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type {
  ActionRequestPreview,
  MossModuleManifest,
  ToolContext,
  ToolResult,
  ToolServices
} from "@moss/module-sdk";
import type { AiAssistantToolDto } from "@moss/shared";

import { summarizeAssistantToolInput } from "../assistant-tools.js";
import type { AiRepository } from "../repository.js";
import {
  requestAcpBuiltInPermission as resolveAcpBuiltInPermission,
  type AcpBuiltInPermissionRequest,
  type AcpBuiltInPermissionResponse
} from "./acp-permission.js";
import { actionHoldDurationMs, emitActionResultRecord } from "./action-result-record.js";
import { AutoRunRateLimiter } from "./auto-run-rate-limit.js";
import type { ConfirmationRegistry } from "./confirmation-registry.js";
import { isConversationTainted } from "./conversation-policy.js";
import {
  admitToolOutcome,
  recordContextAdmission,
  runAutomaticAction,
  toolHasOutsideContent,
  CONTEXT_ADMISSION_UNAVAILABLE
} from "./content-admission.js";
import { recordGatewayAudit } from "./gateway-audit.js";
import { prepareToolCall, servicesForTool } from "./per-call-resolution.js";
import { liveStreamResult, renderAndCap } from "./output-validation.js";
import {
  createEffectivePolicyLookup,
  familyAllowsAutoRun,
  resolveFirstRunNotice,
  resolvePolicy,
  summarizeToolAction
} from "./policy.js";
import type { AgencyPrefLookup, ActionPolicyLookup } from "./policy.js";
import { APPROVAL_REFUSED_REASON, gatewayFailureReason } from "./native-tool-guard.js";
import {
  type NativeToolPermissionRequest,
  type NativeToolPermissionResponse
} from "./native-tool-permission.js";
export type { NativeToolPermissionRequest, NativeToolPermissionResponse };
import { requestNativeToolPermission as resolveNativeToolPermission } from "./native-permission-handler.js";
import {
  runToolHandler,
  type ExecutableTool,
  type GatewayLogger,
  type RunHandlerOutcome
} from "./run-tool-handler.js";
export type { GatewayLogger };
import { isSelfOperationExcluded } from "./self-operation.js";
import type { SessionTokenRegistry } from "./session-tokens.js";
import type {
  ActiveModulesResolver,
  AdmissionPath,
  ConversationProvenancePort,
  GatewayDeclineReason,
  GatewayGateOutcome,
  GatewayToolResponse,
  PerCallResolver,
  PerCallExecutor,
  PerCallServices,
  SessionNotifier
} from "./types.js";

const defaultGatewayLogger: GatewayLogger = {
  error: (event, fields) => console.error(JSON.stringify({ event, ...fields }))
};

export interface AssistantToolGatewayDependencies {
  readonly resolveActiveModules: ActiveModulesResolver;
  readonly repository: AiRepository;
  readonly runner: DataContextRunner;
  readonly tokens: SessionTokenRegistry;
  readonly confirmations: ConfirmationRegistry;
  readonly notifier: SessionNotifier;
  readonly confirmTimeoutMs: number;
  readonly agencyPrefs?: (ctx: ToolContext) => AgencyPrefLookup;
  readonly actionPolicy?: (ctx: ToolContext) => ActionPolicyLookup;
  readonly yoloMode?: (ctx: ToolContext) => Promise<boolean>;
  readonly provenance?: ConversationProvenancePort;
  readonly perCallResolvers?: Readonly<Record<string, PerCallResolver>>;
  /** Factories must return capabilities bound to the resolved input/context, never raw services. */
  readonly perCallServices?: Readonly<Record<string, PerCallServices>>;
  /** A resolved, bound transport owns its DB scopes; never a module-manifest opt-out. */
  readonly perCallExecutors?: Readonly<Record<string, PerCallExecutor>>;
  /**
   * Opaque, composition-layer-constructed service registry keyed by service name.
   * Passed verbatim (as a per-tool, declared-keys-only subset) as the 4th argument
   * to a confirmed tool's execute. The gateway never inspects it. A tool declares
   * which keys it needs via manifest `requiresServices`.
   */
  readonly toolServices?: ToolServices;
  /**
   * Services safe to pass to read tools (no write capability — no confirm bypass risk).
   * Injected by `servicesFor` for read-risk tools and by `runReadToolForActor`.
   * Kept separate from `toolServices` so the write→confirm floor remains structurally
   * un-bypassable: write-capable services (calendarWrite, notesSync) are never in this map.
   */
  readonly readToolServices?: ToolServices;
  /** One prompt-boundary policy for every read-tool execution path. */
  readonly readToolTrustBoundary?: (args: {
    readonly scopedDb: DataContextDb;
    readonly toolName: string;
    readonly ctx: ToolContext;
    readonly execute: () => Promise<ToolResult>;
  }) => Promise<ToolResult>;
  /**
   * Returns the user's configured IANA timezone (e.g. "America/Chicago"), or null if unknown.
   * Injected by the composition root; used to populate ToolContext.localTimezone so tools that
   * format user-visible date/time strings (e.g. calendar approval cards) use the correct timezone.
   */
  readonly resolveLocalTimezone?: (actorUserId: string) => Promise<string | null>;
  /**
   * Returns which web search engine is active for this actor: "brave" (the web.search tool calls
   * the Brave API directly), "model-native" (the web.search tool runs one structured search
   * through the actor's own chat model), or "none" (no key and no searching model, or built-in
   * search switched off). Chat turns only ever run through a CLI engine whose own search is
   * blocked by the permission hook, so web.search is the only chat search path and is offered for
   * both engines; it is hidden only for "none". Injected by the composition root via
   * `resolveWebSearchEngine` (module isolation: the gateway must not import settings).
   * Omitted (e.g. in tests) means always list web.search, matching pre-#2228 behavior.
   */
  readonly webSearchEngineForActor?: (
    actorUserId: string
  ) => Promise<"brave" | "model-native" | "none">;
  /** Defaults to a console.error(JSON.stringify(...)) shim when omitted. */
  readonly logger?: GatewayLogger;
}

const denyPrefs: AgencyPrefLookup = { get: async () => false };
const defaultPolicyLookup: ActionPolicyLookup = {
  getFamilyTier: async () => null,
  getFamilyManifest: async () => null
};

/**
 * The single chokepoint between Jarvis and every module's real operations. Lists
 * tools, validates input, enforces the hardcoded risk policy + confirmation bridge,
 * scopes each call to the token's user under RLS, and dispatches to the owning
 * module's handler. Identity comes only from the per-session token.
 */
export class AssistantToolGateway {
  private readonly autoRunLimiter = new AutoRunRateLimiter();

  constructor(private readonly deps: AssistantToolGatewayDependencies) {}

  /** Returns only tools executable by this actor (via resolveActiveModules). */
  async listToolsForActor(actorUserId: string): Promise<AiAssistantToolDto[]> {
    return (await this.executableTools(actorUserId)).map((entry) => entry.dto);
  }

  async listToolsForSession(token: string): Promise<AiAssistantToolDto[]> {
    const identity = this.deps.tokens.verify(token);
    const tools = await this.executableTools(identity.actorUserId);
    if (tools.some(({ tool }) => tool.isExternal !== false)) {
      await this.recordContextForSession(token, "tool_external_descriptors");
    }
    return tools.map(({ dto }) => dto);
  }

  async recordContextForSession(token: string, path: AdmissionPath): Promise<void> {
    const { actorUserId, threadId } = this.deps.tokens.verify(token);
    await recordContextAdmission(
      this.deps.provenance,
      { actorUserId, threadId: threadId ?? undefined },
      path
    );
  }

  recordNativeVaultReadForSession(token: string): Promise<void> {
    return this.recordContextForSession(token, "native_vault_read");
  }

  async callTool(
    token: string,
    toolName: string,
    rawInput: unknown,
    options: { onProgress?: (message: string) => void } = {}
  ): Promise<GatewayToolResponse> {
    const prepared = await this.prepareCall(token, toolName, rawInput, options.onProgress, true);
    if ("failure" in prepared) return prepared.failure;
    const { found, input, ctx } = prepared;

    const prefs = this.deps.agencyPrefs?.(ctx) ?? denyPrefs;
    const route = await this.planCall(found, input, ctx);
    if (route.kind === "yolo-confirm") {
      return this.confirmAndRun(
        found,
        input,
        ctx,
        await resolveFirstRunNotice(found.dto.moduleId, found.tool, prefs)
      );
    }
    if (route.kind === "yolo-run") {
      if (!this.autoRunLimiter.consume(ctx.actorUserId, found.dto.name)) {
        return this.denyRateLimited(found, ctx, "yolo");
      }
      const dispatched = await this.runAutomatically(found, input, ctx);
      if (dispatched.kind === "confirm") return this.confirmAndRun(found, input, ctx);
      const { response: result, audit } = dispatched.value;
      this.recordUnattendedRun(found, ctx, "yolo", result, audit);
      return result;
    }
    if (route.kind === "auto-run") {
      if (
        found.tool.risk !== "read" &&
        !this.autoRunLimiter.consume(ctx.actorUserId, found.dto.name)
      ) {
        void recordGatewayAudit(
          this.deps,
          { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
          found,
          {
            approvalMode: "auto",
            outcome: "denied",
            durationMs: null,
            errorClass: "rate_limited",
            chatSessionId: ctx.chatSessionId
          }
        );
        return this.confirmAndRun(
          found,
          input,
          ctx,
          "Automatic execution hit its rate limit — please confirm this action."
        );
      }
      const dispatched = await this.runAutomatically(found, input, ctx);
      if (dispatched.kind === "confirm") return this.confirmAndRun(found, input, ctx);
      const { response: result, audit } = dispatched.value;
      if (found.tool.risk !== "read") {
        this.recordUnattendedRun(found, ctx, "auto", result, audit);
      }
      return result;
    }
    return this.confirmAndRun(
      found,
      input,
      ctx,
      await resolveFirstRunNotice(found.dto.moduleId, found.tool, prefs)
    );
  }

  /**
   * Entry point for the classifier gate. Runs the same token, membership, input and policy checks
   * as callTool, but never raises an approval card. A call that would need approval (including a
   * rate-limit escalation) declines before any handler runs. `dry-run` evaluates the same decision
   * without consuming allowance, running a handler or writing an audit row. A dry-run result is
   * never authorization; `execute` re-evaluates everything at dispatch time.
   */
  async callToolForGate(
    token: string,
    toolName: string,
    rawInput: unknown,
    mode: "execute" | "dry-run"
  ): Promise<GatewayGateOutcome> {
    const prepared = await this.prepareCall(token, toolName, rawInput, undefined, false);
    if ("failure" in prepared) {
      return { kind: "declined", reason: prepared.reason };
    }
    const { found, input, ctx } = prepared;
    const route = await this.planCall(found, input, ctx);
    if (route.kind === "confirm" || route.kind === "yolo-confirm") {
      return { kind: "declined", reason: "would_confirm" };
    }
    const approvalMode = route.kind === "yolo-run" ? "yolo" : "auto";
    const limited = route.kind === "yolo-run" || found.tool.risk !== "read";
    if (mode === "dry-run") {
      if (limited && !this.autoRunLimiter.wouldAllow(ctx.actorUserId, found.dto.name)) {
        return { kind: "declined", reason: "rate_limited" };
      }
      return { kind: "would_run", approvalMode };
    }
    if (limited && !this.autoRunLimiter.consume(ctx.actorUserId, found.dto.name)) {
      if (route.kind === "yolo-run") {
        this.denyRateLimited(found, ctx, "yolo");
      } else {
        void recordGatewayAudit(
          this.deps,
          { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
          found,
          {
            approvalMode: "auto",
            outcome: "denied",
            durationMs: null,
            errorClass: "rate_limited",
            chatSessionId: ctx.chatSessionId
          }
        );
      }
      return { kind: "declined", reason: "rate_limited" };
    }
    const dispatched = await this.runAutomatically(found, input, ctx);
    if (dispatched.kind === "confirm") return { kind: "declined", reason: "would_confirm" };
    const { response, audit } = dispatched.value;
    if (limited) this.recordUnattendedRun(found, ctx, approvalMode, response, audit);
    return {
      kind: "executed",
      response,
      outcome:
        audit.errorClass === null
          ? "success"
          : audit.errorClass === "module_reported"
            ? "module_reported_error"
            : "handler_error"
    };
  }

  private async prepareCall(
    token: string,
    toolName: string,
    rawInput: unknown,
    onProgress: ((message: string) => void) | undefined,
    exposeValidationError: boolean
  ): Promise<
    | { found: ExecutableTool; input: Record<string, unknown>; ctx: ToolContext }
    | { failure: GatewayToolResponse; reason: GatewayDeclineReason }
  > {
    const { actorUserId, chatSessionId, threadId, allowedToolNames } =
      this.deps.tokens.verify(token);
    const localTimezone = (await this.deps.resolveLocalTimezone?.(actorUserId)) ?? undefined;
    let progressTool: ExecutableTool | undefined;
    let progressAdmission: Promise<void> | undefined;
    const ctx: ToolContext = {
      actorUserId,
      requestId: `mcp_${randomUUID()}`,
      chatSessionId,
      ...(threadId ? { threadId } : {}),
      localTimezone,
      // Only the MCP transport passes a sink; every other caller sends nowhere.
      ...(onProgress
        ? {
            reportProgress: (message: string) => {
              if (!message.trim() || !progressTool) return;
              if (!toolHasOutsideContent(progressTool.tool)) {
                onProgress(message);
                return;
              }
              progressAdmission ??= recordContextAdmission(
                this.deps.provenance,
                ctx,
                "tool_external_content"
              );
              // Never leak outside progress ahead of durable admission. In-flight automatic effects
              // can suppress progress; their final result is admitted after releasing the reservation.
              void progressAdmission.then(() => onProgress(message)).catch(() => undefined);
            }
          }
        : {})
    };

    const found = (await this.executableTools(actorUserId)).find(
      (entry) => entry.tool.name === toolName
    );
    if (!found) {
      return {
        failure: { ok: false, error: `Tool not available: ${toolName}` },
        reason: "not_available"
      };
    }

    // Server-side per-session allowlist check (defense-in-depth on top of executableTools).
    // Only fires when allowedToolNames is non-null (MCP sessions with a captured allowlist).
    // null = unrestricted (REST path tokens minted without an allowlist).
    if (allowedToolNames !== null && !allowedToolNames.has(toolName)) {
      return {
        // #2942 — this session started before the tool appeared (e.g. an
        // integration connected mid-conversation), so it is not in the
        // allowlist captured at launch. Name the way out: a new chat picks up
        // the current tool set. Returned as tool-result content, which the
        // chat relays to the person.
        failure: {
          ok: false,
          error: `Tool not in session allowlist: ${toolName}. It was added after this conversation started. Start a new chat to use it.`
        },
        reason: "not_in_allowlist"
      };
    }

    const prepared = await prepareToolCall(
      found,
      rawInput,
      ctx,
      this.deps.perCallResolvers?.[toolName],
      this.deps.perCallServices?.[toolName],
      this.deps.perCallExecutors?.[toolName]
    );
    // Schema failures can quote remote field names even when this token never listed tools.
    // The classifier gate discards this text and returns only its fixed decline reason.
    if (
      exposeValidationError &&
      "failure" in prepared &&
      prepared.reason === "invalid_input" &&
      found.tool.isExternal !== false
    ) {
      try {
        await recordContextAdmission(this.deps.provenance, ctx, "tool_external_descriptors");
      } catch {
        return {
          failure: { ok: false, error: CONTEXT_ADMISSION_UNAVAILABLE },
          reason: "invalid_input"
        };
      }
    }
    if (!("failure" in prepared)) progressTool = prepared.found;
    return "failure" in prepared ? prepared : { ...prepared, ctx };
  }

  /** The single approval decision shared by live calls and the gate's dry run. */
  private async planCall(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<{ kind: "yolo-confirm" | "yolo-run" | "auto-run" | "confirm" }> {
    if (found.resolution?.forceConfirm) return { kind: "confirm" };
    const confirmWhenTainted = found.resolution?.confirmWhenTainted ?? false;
    if (found.tool.risk === "read" && !confirmWhenTainted) return { kind: "auto-run" };
    const conversationTainted = await isConversationTainted(this.deps.provenance, ctx);
    if (conversationTainted && (found.tool.risk !== "read" || confirmWhenTainted)) {
      return { kind: "confirm" };
    }
    const perCallResolved = found.resolution !== undefined;
    const lookup = this.deps.actionPolicy?.(ctx) ?? defaultPolicyLookup;
    const confirmOverride = await this.computeConfirmOverride(found, input, ctx);
    const effectiveLookup = createEffectivePolicyLookup(
      lookup,
      this.deps.resolveActiveModules,
      ctx.actorUserId
    );
    if (found.tool.risk !== "read" && (await this.deps.yoloMode?.(ctx)) === true) {
      return confirmOverride ||
        !(await familyAllowsAutoRun(
          found.tool,
          found.dto.moduleId,
          effectiveLookup,
          perCallResolved
        ))
        ? { kind: "yolo-confirm" }
        : (await isConversationTainted(this.deps.provenance, ctx))
          ? { kind: "confirm" }
          : { kind: "yolo-run" };
    }
    return (await resolvePolicy(
      found.tool,
      found.dto.moduleId,
      confirmOverride,
      effectiveLookup,
      await this.computeSortedSafe(found, ctx),
      perCallResolved,
      conversationTainted,
      confirmWhenTainted
    )) === "run" && !(await isConversationTainted(this.deps.provenance, ctx))
      ? { kind: "auto-run" }
      : { kind: "confirm" };
  }

  private denyRateLimited(
    found: ExecutableTool,
    ctx: ToolContext,
    approvalMode: "yolo"
  ): GatewayToolResponse {
    emitActionResultRecord(this.deps.notifier, ctx.chatSessionId, {
      actionRequestId: ctx.requestId,
      toolName: found.dto.name,
      outcome: "denied",
      decidedBy: "policy",
      holdDurationMs: null,
      reason: "Rate limit exceeded for unattended runs of this tool."
    });
    void recordGatewayAudit(
      this.deps,
      { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
      found,
      {
        approvalMode,
        outcome: "denied",
        durationMs: null,
        errorClass: "rate_limited",
        chatSessionId: ctx.chatSessionId
      }
    );
    return {
      ok: false,
      denied: true,
      reason: "Rate limit exceeded for unattended runs of this tool. Try again shortly."
    };
  }

  private recordUnattendedRun(
    found: ExecutableTool,
    ctx: ToolContext,
    approvalMode: "yolo" | "auto",
    result: GatewayToolResponse,
    audit: RunHandlerOutcome["audit"]
  ): void {
    emitActionResultRecord(this.deps.notifier, ctx.chatSessionId, {
      actionRequestId: ctx.requestId,
      toolName: found.dto.name,
      outcome: audit.errorClass === null ? "executed" : "error",
      decidedBy: "policy",
      holdDurationMs: null,
      ...(result.ok
        ? { result: liveStreamResult(found.tool, result) }
        : { reason: gatewayFailureReason(result) }),
      ...(result.ok && audit.outcome === "success" && found.tool.affectsQueryKeys
        ? { affectsQueryKeys: found.tool.affectsQueryKeys }
        : {}),
      ...(result.ok && audit.outcome === "success" && found.tool.risk !== "read" && found.resolution
        ? { affectsModules: found.resolution.affectsModules }
        : {})
    });
    void recordGatewayAudit(
      this.deps,
      { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
      found,
      {
        approvalMode,
        ...audit,
        chatSessionId: ctx.chatSessionId
      }
    );
  }

  async requestNativeToolPermission(
    token: string,
    request: NativeToolPermissionRequest
  ): Promise<NativeToolPermissionResponse> {
    return resolveNativeToolPermission(this.deps, token, request);
  }

  /** Outside-agent built-in ask; orchestration lives in ./acp-permission.js. */
  async requestAcpBuiltInPermission(
    token: string,
    request: AcpBuiltInPermissionRequest
  ): Promise<AcpBuiltInPermissionResponse> {
    return resolveAcpBuiltInPermission(this.deps, token, request);
  }

  /**
   * Execute a single read tool on behalf of an actor without a session token.
   * Used by the cross-tool reasoning pre-submit path in ChatSessionManager.
   *
   * Fail-closed: only effective reads that need no approval are permitted. Services come
   * from the read bundle or a composition-owned capability bound to this exact call.
   * Handler throws are sanitized the same way runHandler sanitizes them.
   */
  async runReadToolForActor(
    actorUserId: string,
    toolName: string,
    rawInput: unknown,
    binding?: { readonly threadId: string | null; readonly chatSessionId: string }
  ): Promise<GatewayToolResponse> {
    const bound = binding ? { ...binding } : undefined;
    const declared = (await this.executableTools(actorUserId)).find(
      (entry) => entry.tool.name === toolName
    );
    if (!declared) return { ok: false, error: `Tool not available: ${toolName}` };
    const requestId = `cross-tool_${randomUUID()}`;
    const access: AccessContext = { actorUserId, requestId };
    const localTimezone = (await this.deps.resolveLocalTimezone?.(actorUserId)) ?? undefined;
    const ctx: ToolContext = {
      actorUserId,
      requestId,
      chatSessionId: bound?.chatSessionId ?? "",
      localTimezone,
      ...(bound?.threadId ? { threadId: bound.threadId } : {})
    };
    const prepared = await prepareToolCall(
      declared,
      rawInput,
      ctx,
      this.deps.perCallResolvers?.[toolName],
      this.deps.perCallServices?.[toolName],
      this.deps.perCallExecutors?.[toolName]
    );
    if ("failure" in prepared) return prepared.failure;
    const { found, input } = prepared;
    if (
      found.tool.risk !== "read" ||
      (await this.planCall(found, input, ctx)).kind !== "auto-run"
    ) {
      return { ok: false, error: `Tool ${toolName} is not a read tool` };
    }
    const readServices = this.servicesFor(found);
    try {
      const result = await this.executeTool(found, input, ctx, readServices, access);
      return {
        ok: true,
        data: renderAndCap(
          found.tool.outputSchema,
          result,
          toolHasOutsideContent(found.tool) ? found.tool.name : undefined
        )
      };
    } catch {
      // #1251: a tool handler (including third-party module handlers) can throw an arbitrary
      // hostile object. Never touch it — no property access, no instanceof, no prototype walk.
      (this.deps.logger ?? defaultGatewayLogger).error("read_tool_handler_threw", {
        toolName: found.tool.name,
        requestId,
        errorClass: "handler_error"
      });
      return { ok: false, error: `Tool ${found.tool.name} failed` };
    }
  }

  /**
   * Called by the Approve/Deny endpoint (and tests). Persists the resolution and unblocks the call.
   * #1250: returns outcome so caller knows if request expired (409) vs succeeded (204).
   */
  async resolveActionRequest(
    actorUserId: string,
    actionRequestId: string,
    status: "confirmed" | "rejected" | "cancelled"
  ): Promise<"resolved" | "expired" | "not_found"> {
    const access: AccessContext = { actorUserId, requestId: `mcp_${randomUUID()}` };

    // #1591: ownership before liveness. isAwaiting is a process-local, unscoped map keyed only by
    // actionRequestId — it can't tell "not mine" from "mine but expired", so checking it first let a
    // guessed/foreign ID's response (expired vs not_found) leak which state another user's row was
    // in. Confirm the row is owned-and-pending via the owner-scoped repository read first; only a
    // legitimate owner reaches the liveness check below, so both outcomes fold into "not_found" for
    // everyone else.
    if (status === "confirmed") {
      const action = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
        this.deps.repository.getAssistantAction(scopedDb, actionRequestId)
      );
      if (!action || action.status !== "pending") {
        return "not_found";
      }
    }

    // Confirm-after-timeout guard (fail-closed): a "confirmed" only means anything while the
    // blocked call is still awaiting. After the confirm timeout the waiter is gone, the call
    // already returned "timed out", and the tool can NEVER execute — so persisting 'confirmed'
    // would leave a row claiming a write happened when none did (DB/drawer divergence). When no
    // live waiter exists, treat an Approve as a no-op so the row stays pending (the operator sees
    // an honest "still pending" rather than a phantom success). A reject/cancel stays terminal
    // regardless: declining a no-longer-runnable action is always safe and correct.
    if (status === "confirmed" && !this.deps.confirmations.isAwaiting(actionRequestId)) {
      return "expired";
    }

    const resolved = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
      this.deps.repository.resolveAssistantAction(scopedDb, actionRequestId, { status })
    );
    // Only unblock the pending call if the DB row was actually updated (owner matches + still pending).
    // Without this guard a logged-in user could unblock another user's tool call via a guessed ID.
    if (!resolved) return "not_found";
    await this.deps.confirmations.resolveAndAwaitCompletion(actionRequestId, status);
    return "resolved";
  }

  private servicesFor(found: ExecutableTool): ToolServices {
    return servicesForTool(found, this.deps.toolServices, this.deps.readToolServices);
  }

  /**
   * Resolves the tool's optional `requiresConfirmation` hook (input-shaped, DB-aware — e.g. a
   * calendar write whose target event isn't Jarv1s-created) BEFORE `resolvePolicy` runs, so the
   * result can force "confirm" even when the module's family tier is trusted_auto. Unlike the
   * preview hook above, this MUST fail closed: a throw or a lookup that can't determine safety
   * resolves to true (confirm), never to auto-run. No hook declared -> false (no override).
   */
  private async computeConfirmOverride(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<boolean> {
    const hook = found.tool.requiresConfirmation;
    if (!hook) return false;
    const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
    try {
      return await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
        Promise.resolve(hook(scopedDb, input, ctx, this.servicesFor(found)))
      );
    } catch {
      return true;
    }
  }

  /**
   * Resolves a connected tool's `runsWithoutAsking` check (#2984, spec 8.3) under the actor's own
   * data context. Only an external write or outbound tool is asked; reads already run and
   * destructive tools always ask. Fails closed: a throw or anything but `true` means the tool asks.
   */
  private async computeSortedSafe(found: ExecutableTool, ctx: ToolContext): Promise<boolean> {
    const { risk, isExternal, runsWithoutAsking: hook } = found.tool;
    if (!hook || isExternal !== true || risk === "read" || risk === "destructive") return false;
    const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
    try {
      const safe = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
        Promise.resolve(hook(scopedDb, ctx))
      );
      return safe === true;
    } catch {
      return false;
    }
  }

  private async runHandler(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<RunHandlerOutcome> {
    return admitToolOutcome(
      this.deps.provenance,
      found,
      ctx,
      await this.dispatchHandler(found, input, ctx)
    );
  }

  private async runAutomatically(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext
  ) {
    const result =
      found.tool.risk === "read" && !found.resolution?.confirmWhenTainted
        ? { kind: "ran" as const, value: await this.dispatchHandler(found, input, ctx) }
        : await runAutomaticAction(this.deps.provenance, ctx, () =>
            this.dispatchHandler(found, input, ctx)
          );
    if (result.kind === "confirm") return result;
    if (result.kind === "failed")
      return {
        kind: "ran" as const,
        value: {
          response: { ok: false as const, error: CONTEXT_ADMISSION_UNAVAILABLE },
          audit: { outcome: "failed" as const, durationMs: 0, errorClass: "automatic_guard" }
        }
      };
    return {
      kind: "ran" as const,
      value: await admitToolOutcome(this.deps.provenance, found, ctx, result.value)
    };
  }

  private dispatchHandler(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<RunHandlerOutcome> {
    const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
    return runToolHandler(
      found,
      input,
      ctx,
      this.deps.logger ?? defaultGatewayLogger,
      (services) => this.executeTool(found, input, ctx, services, access),
      this.servicesFor(found)
    );
  }

  private executeTool(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext,
    services: ToolServices,
    access: AccessContext
  ): Promise<ToolResult> {
    if (found.executePerCall) return found.executePerCall();
    return this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) => {
      const execute = () => found.execute(scopedDb, input, ctx, services);
      return found.tool.risk === "read" && this.deps.readToolTrustBoundary
        ? this.deps.readToolTrustBoundary({
            scopedDb,
            toolName: found.tool.name,
            ctx,
            execute
          })
        : execute();
    });
  }

  private async confirmAndRun(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext,
    notice?: string
  ): Promise<GatewayToolResponse> {
    const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
    // #2956: the approval hold below can outlive the turn, so the turn is
    // captured at arrival and handed to each audit write explicitly.
    const arrivalTurnId = this.deps.tokens.readCurrentTurnId(ctx.chatSessionId);

    const action = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
      this.deps.repository.createPendingAssistantAction(scopedDb, {
        toolModuleId: found.dto.moduleId,
        toolModuleName: found.dto.moduleName,
        toolName: found.dto.name,
        permissionId: found.dto.permissionId,
        risk: found.tool.risk,
        inputSummary: summarizeAssistantToolInput(input),
        requestId: ctx.requestId
      })
    );

    const pendingResolution = this.deps.confirmations.awaitResolution(
      action.id,
      this.deps.confirmTimeoutMs
    );

    const summary = [notice, summarizeToolAction(found.tool, input, ctx)].filter(Boolean).join(" ");

    // Optional rich, server-derived card preview (e.g. email reply recipient/subject/body),
    // computed under the actor's DataContextDb. It rides the live stream ONLY — the persisted
    // row's `inputSummary` above stays key-names-only (metadata-only persistence). A preview
    // hook that throws must NOT block the card: guard and fall back to summary-only (never let
    // a thrown message, which could carry sensitive detail, reach the emit).
    let preview: ActionRequestPreview | undefined;
    const previewHook = found.tool.preview;
    if (previewHook) {
      try {
        preview = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
          previewHook(scopedDb, input, ctx, this.servicesFor(found))
        );
      } catch {
        preview = undefined;
      }
    }

    this.deps.notifier.emit(ctx.chatSessionId, {
      kind: "action_request",
      actionRequestId: action.id,
      toolName: found.dto.name,
      summary,
      outsideContentNotice: await isConversationTainted(this.deps.provenance, ctx),
      ...(found.resolution ? { details: found.resolution.details } : {}),
      ...(preview ? { preview } : {})
    });
    const holdStartedAt = Date.now();

    const outcome = await pendingResolution;

    // #2149: markDone unblocks resolveAndAwaitCompletion, which the Approve/Deny HTTP route
    // awaits before responding — must fire once this call has fully finished handling the
    // outcome (both branches below), on every exit path, so the caller never observes
    // "confirmed" before the handler run below has actually happened. Deliberately outside the
    // fire-and-forget `recordGatewayAudit` calls (`void recordGatewayAudit(...)`) — those stay
    // unawaited on purpose and must not reopen the same kind of delay on the audit write.
    try {
      if (outcome !== "confirmed") {
        emitActionResultRecord(this.deps.notifier, ctx.chatSessionId, {
          actionRequestId: action.id,
          toolName: found.dto.name,
          outcome: "denied",
          decidedBy:
            outcome === "timeout" ? "timeout" : outcome === "cancelled" ? "cancelled" : "person",
          holdDurationMs: actionHoldDurationMs(holdStartedAt),
          reason:
            outcome === "timeout"
              ? "Action timed out."
              : outcome === "cancelled"
                ? "Action cancelled."
                : APPROVAL_REFUSED_REASON
        });
        const approvalMode =
          outcome === "timeout" ? "timeout" : outcome === "rejected" ? "rejected" : "cancelled";
        void recordGatewayAudit(this.deps, access, found, {
          approvalMode,
          outcome: outcome === "cancelled" ? "cancelled" : "denied",
          durationMs: null,
          chatSessionId: ctx.chatSessionId,
          ...(arrivalTurnId ? { turnId: arrivalTurnId } : {})
        });
        const reason = APPROVAL_REFUSED_REASON;
        return { ok: false, denied: true, reason };
      }

      const { response: result, audit } = await this.runHandler(found, input, ctx);
      emitActionResultRecord(this.deps.notifier, ctx.chatSessionId, {
        actionRequestId: action.id,
        toolName: found.dto.name,
        outcome: audit.errorClass === null ? "executed" : "error",
        decidedBy: "person",
        holdDurationMs: actionHoldDurationMs(holdStartedAt),
        ...(result.ok
          ? { result: liveStreamResult(found.tool, result) }
          : { reason: gatewayFailureReason(result) }),
        ...(result.ok && audit.outcome === "success" && found.tool.affectsQueryKeys
          ? { affectsQueryKeys: found.tool.affectsQueryKeys }
          : {}),
        ...(result.ok &&
        audit.outcome === "success" &&
        found.tool.risk !== "read" &&
        found.resolution
          ? { affectsModules: found.resolution.affectsModules }
          : {})
      });
      void recordGatewayAudit(this.deps, access, found, {
        approvalMode: "confirmed",
        ...audit,
        chatSessionId: ctx.chatSessionId,
        ...(arrivalTurnId ? { turnId: arrivalTurnId } : {})
      });
      return result;
    } finally {
      this.deps.confirmations.markDone(action.id);
    }
  }

  private async executableTools(actorUserId: string): Promise<ExecutableTool[]> {
    const modules: readonly MossModuleManifest[] =
      await this.deps.resolveActiveModules(actorUserId);
    // #2228: web.search is backed by Brave or by the actor's model-native provider; it is the only
    // search path a chat turn can reach (CLI engines cannot search on their own here), so it is
    // hidden only when the actor has no engine at all. Resolved once per listing, not per tool.
    const webSearchEngine = this.deps.webSearchEngineForActor
      ? await this.deps.webSearchEngineForActor(actorUserId)
      : "brave";
    const out: ExecutableTool[] = [];
    for (const module of modules) {
      for (const tool of module.assistantTools ?? []) {
        if (typeof tool.execute !== "function") {
          continue;
        }
        if (tool.name === "web.search" && webSearchEngine === "none") {
          continue;
        }
        // Fail closed #0: a centrally excluded (self-operation) tool is never listed and never
        // executable, regardless of YOLO or any per-tool confirmation mechanism (#1263).
        if (isSelfOperationExcluded(module.id, tool)) {
          continue;
        }
        const declaredServices = tool.requiresServices ?? [];
        // A read declaration can only be satisfied by the read-only registry. A matching key
        // in the write registry never makes a read tool available or grants it write services.
        // Missing declared services hide the tool before it can become an approval dead-end.
        const registry =
          (tool.risk === "read" ? this.deps.readToolServices : this.deps.toolServices) ?? {};
        const missing = declaredServices.filter((key) => !(key in registry));
        if (missing.length > 0) {
          continue;
        }
        out.push({
          tool,
          execute: tool.execute,
          dto: {
            moduleId: module.id,
            moduleName: module.name,
            name: tool.name,
            description: tool.description,
            permissionId: tool.permissionId,
            risk: tool.risk,
            inputSchema: tool.inputSchema ?? null,
            outputSchema: tool.outputSchema ?? null
          }
        });
      }
    }
    return out;
  }
}
