import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { types as nodeUtilTypes } from "node:util";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type {
  ActionRequestPreview,
  MossModuleManifest,
  ModuleAssistantToolManifest,
  ToolContext,
  ToolExecute,
  ToolResult,
  ToolServices
} from "@moss/module-sdk";
import type { ActionAuditInputSummary, AiAssistantToolDto } from "@moss/shared";

import { summarizeAssistantToolInput } from "../assistant-tools.js";
import type { AiRepository, InsertAuditLogInput } from "../repository.js";
import { AutoRunRateLimiter } from "./auto-run-rate-limit.js";
import type { ConfirmationRegistry } from "./confirmation-registry.js";
import {
  classifyToolDependencyFailure,
  describeToolDependencyCause,
  safeErrorName
} from "./dependency-failure.js";
import { validateToolInput } from "./input-validation.js";
import {
  liveStreamResult,
  renderAndCap,
  sanitizeAssistantToolResult
} from "./output-validation.js";
import { resolvePolicy } from "./policy.js";
import type { AgencyPrefLookup, ActionPolicyLookup } from "./policy.js";
import {
  gatewayFailureReason,
  nativeToolRisk,
  nativeToolSummary,
  nativeYoloCanAutoAllow,
  safeNativeToolName
} from "./native-tool-guard.js";
import { isSelfOperationExcluded } from "./self-operation.js";
import type { SessionTokenRegistry } from "./session-tokens.js";
import type { ActiveModulesResolver, GatewayToolResponse, SessionNotifier } from "./types.js";

export interface GatewayLogger {
  error(event: string, fields: Record<string, unknown>): void;
}

const defaultGatewayLogger: GatewayLogger = {
  error: (event, fields) => console.error(JSON.stringify({ event, ...fields }))
};

/**
 * Private runHandler return shape: the public envelope plus the audit-log fields, computed once
 * so every call site records them identically. `audit.errorClass` is `null` only for a genuine
 * success (a module self-reporting failure inside an `ok:true` result is not one); the live-stream
 * outcome keys off it too. Never exposed outside this file.
 */
interface RunHandlerOutcome {
  readonly response: GatewayToolResponse;
  readonly audit: {
    readonly outcome: InsertAuditLogInput["outcome"];
    readonly durationMs: number;
    readonly errorClass: string | null;
  };
}

/**
 * Closed set of conventional error shapes a module handler may return inside an `ok:true`
 * ToolResult. Checked on the raw pre-sanitize payload (#1252) — top-level only, no recursion.
 */
function isModuleReportedError(data: Record<string, unknown>): boolean {
  if (data.status === "error") return true;
  if (data.ok === false) return true;
  if (typeof data.error === "string" && data.error.length > 0) return true;
  return false;
}

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
const TASKS_FIRST_RUN_NOTICE_KEY = "tasks.agency_auto_execute.first_prompt_seen";
const TASKS_FIRST_RUN_NOTICE =
  'Your assistant now asks before creating tasks. Enable "create without asking" in Task settings to auto-run task changes.';

interface ExecutableTool {
  readonly tool: ModuleAssistantToolManifest;
  readonly execute: ToolExecute;
  readonly dto: AiAssistantToolDto;
}

export interface NativeToolPermissionRequest {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly workingDirectory?: string;
}

export interface NativeToolPermissionResponse {
  readonly decision: "allow" | "deny";
  readonly reason: string;
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

  async callTool(token: string, toolName: string, rawInput: unknown): Promise<GatewayToolResponse> {
    const { actorUserId, chatSessionId, allowedToolNames } = this.deps.tokens.verify(token);
    const localTimezone = (await this.deps.resolveLocalTimezone?.(actorUserId)) ?? undefined;
    const ctx: ToolContext = {
      actorUserId,
      requestId: `mcp_${randomUUID()}`,
      chatSessionId,
      localTimezone
    };

    const found = (await this.executableTools(actorUserId)).find(
      (entry) => entry.tool.name === toolName
    );
    if (!found) {
      return { ok: false, error: `Tool not available: ${toolName}` };
    }

    // Server-side per-session allowlist check (defense-in-depth on top of executableTools).
    // Only fires when allowedToolNames is non-null (MCP sessions with a captured allowlist).
    // null = unrestricted (REST path tokens minted without an allowlist).
    if (allowedToolNames !== null && !allowedToolNames.has(toolName)) {
      return { ok: false, error: `Tool not in session allowlist: ${toolName}` };
    }

    let input: Record<string, unknown>;
    try {
      input = await validateToolInput(found.tool.inputSchema, rawInput, {
        // Missing provenance is untrusted: only the registry's explicit false marker gets the
        // built-in synchronous path.
        external: found.tool.isExternal !== false,
        toolName
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Invalid input" };
    }

    const prefs = this.deps.agencyPrefs?.(ctx) ?? denyPrefs;
    const lookup = this.deps.actionPolicy?.(ctx) ?? defaultPolicyLookup;
    if (found.tool.risk !== "read" && (await this.deps.yoloMode?.(ctx)) === true) {
      if (!this.autoRunLimiter.consume(ctx.actorUserId, found.dto.name)) {
        this.deps.notifier.emit(ctx.chatSessionId, {
          kind: "action_result",
          actionRequestId: ctx.requestId,
          toolName: found.dto.name,
          outcome: "denied",
          reason: "Rate limit exceeded for unattended runs of this tool."
        });
        void this.recordAudit({ actorUserId: ctx.actorUserId, requestId: ctx.requestId }, found, {
          approvalMode: "yolo",
          outcome: "denied",
          durationMs: null,
          errorClass: "rate_limited",
          chatSessionId: ctx.chatSessionId
        });
        return {
          ok: false,
          denied: true,
          reason: "Rate limit exceeded for unattended runs of this tool. Try again shortly."
        };
      }
      const { response: result, audit } = await this.runHandler(found, input, ctx);
      this.deps.notifier.emit(ctx.chatSessionId, {
        kind: "action_result",
        actionRequestId: ctx.requestId,
        toolName: found.dto.name,
        outcome: audit.errorClass === null ? "executed" : "error",
        ...(result.ok
          ? { result: liveStreamResult(found.tool, result) }
          : { reason: gatewayFailureReason(result) }),
        ...(result.ok && found.tool.affectsQueryKeys
          ? { affectsQueryKeys: found.tool.affectsQueryKeys }
          : {})
      });
      void this.recordAudit({ actorUserId: ctx.actorUserId, requestId: ctx.requestId }, found, {
        approvalMode: "yolo",
        ...audit,
        chatSessionId: ctx.chatSessionId
      });
      return result;
    }
    const confirmOverride = await this.computeConfirmOverride(found, input, ctx);
    if ((await resolvePolicy(found.tool, found.dto.moduleId, confirmOverride, lookup)) === "run") {
      if (
        found.tool.risk !== "read" &&
        !this.autoRunLimiter.consume(ctx.actorUserId, found.dto.name)
      ) {
        void this.recordAudit({ actorUserId: ctx.actorUserId, requestId: ctx.requestId }, found, {
          approvalMode: "auto",
          outcome: "denied",
          durationMs: null,
          errorClass: "rate_limited",
          chatSessionId: ctx.chatSessionId
        });
        return this.confirmAndRun(
          found,
          input,
          ctx,
          "Automatic execution hit its rate limit — please confirm this action."
        );
      }
      const { response: result, audit } = await this.runHandler(found, input, ctx);
      if (found.tool.risk !== "read") {
        this.deps.notifier.emit(ctx.chatSessionId, {
          kind: "action_result",
          actionRequestId: ctx.requestId,
          toolName: found.dto.name,
          outcome: audit.errorClass === null ? "executed" : "error",
          ...(result.ok
            ? { result: liveStreamResult(found.tool, result) }
            : { reason: gatewayFailureReason(result) }),
          ...(result.ok && found.tool.affectsQueryKeys
            ? { affectsQueryKeys: found.tool.affectsQueryKeys }
            : {})
        });
        void this.recordAudit({ actorUserId: ctx.actorUserId, requestId: ctx.requestId }, found, {
          approvalMode: "auto",
          ...audit,
          chatSessionId: ctx.chatSessionId
        });
      }
      return result;
    }
    return this.confirmAndRun(found, input, ctx, await this.firstRunNotice(found, prefs));
  }

  async requestNativeToolPermission(
    token: string,
    request: NativeToolPermissionRequest
  ): Promise<NativeToolPermissionResponse> {
    const { actorUserId, chatSessionId } = this.deps.tokens.verify(token);
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

    const ctx: ToolContext = {
      actorUserId,
      requestId,
      chatSessionId,
      localTimezone: (await this.deps.resolveLocalTimezone?.(actorUserId)) ?? undefined
    };

    const yoloGranted =
      (await nativeYoloCanAutoAllow(toolName, input, request.workingDirectory)) &&
      (await (async () => {
        try {
          return (await this.deps.yoloMode?.(ctx)) === true;
        } catch {
          return false;
        }
      })());

    if (yoloGranted) {
      // #1085 F4: Jarvis observes the permission grant, not the native tool's completion. Persist
      // that grant before allowing it instead of fire-and-forget auditing a fictional "success".
      const action = await this.deps.runner.withDataContext(
        access,
        async (scopedDb: DataContextDb) => {
          const pending = await this.deps.repository.createPendingAssistantAction(scopedDb, {
            toolModuleId: NATIVE_TOOL_MODULE_ID,
            toolModuleName: NATIVE_TOOL_MODULE_NAME,
            toolName,
            permissionId: `${NATIVE_TOOL_MODULE_ID}.${toolName}`,
            risk: nativeToolRisk(toolName),
            inputSummary: summarizeAssistantToolInput(input),
            requestId
          });
          const confirmed = await this.deps.repository.resolveAssistantAction(
            scopedDb,
            pending.id,
            {
              status: "confirmed"
            }
          );
          if (!confirmed) throw new Error("Could not persist native YOLO permission grant");
          return confirmed;
        }
      );
      this.deps.notifier.emit(chatSessionId, {
        kind: "action_result",
        actionRequestId: action.id,
        toolName,
        outcome: "allowed"
      });
      return { decision: "allow", reason: "Allowed by YOLO." };
    }

    const action = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
      this.deps.repository.createPendingAssistantAction(scopedDb, {
        toolModuleId: NATIVE_TOOL_MODULE_ID,
        toolModuleName: NATIVE_TOOL_MODULE_NAME,
        toolName,
        permissionId: `${NATIVE_TOOL_MODULE_ID}.${toolName}`,
        risk: nativeToolRisk(toolName),
        inputSummary: summarizeAssistantToolInput(input),
        requestId
      })
    );

    const pendingResolution = this.deps.confirmations.awaitResolution(
      action.id,
      this.deps.confirmTimeoutMs
    );

    this.deps.notifier.emit(chatSessionId, {
      kind: "action_request",
      actionRequestId: action.id,
      toolName,
      summary: nativeToolSummary(toolName, input)
    });

    // #2149: markDone (in the finally below) unblocks resolveAndAwaitCompletion, which the
    // Approve/Deny HTTP route awaits before responding. This path has no handler to run — it
    // only grants a permission decision — but it still shares the wake-up mechanism with
    // confirmAndRun, so it must report back the same way or an Approve of a native tool would
    // hang waiting for a markDone that never comes.
    try {
      const outcome = await pendingResolution;
      if (outcome !== "confirmed") {
        this.deps.notifier.emit(chatSessionId, {
          kind: "action_result",
          actionRequestId: action.id,
          toolName,
          outcome: "denied",
          reason: outcome === "timeout" ? "Timed out awaiting confirmation." : "Denied by user."
        });
        return {
          decision: "deny",
          reason: outcome === "timeout" ? "Timed out awaiting confirmation." : "Denied by user."
        };
      }

      // #1661: "allowed", not "executed". This method decides a native tool's PERMISSION and
      // returns `decision: "allow"` — the tool then runs outside the gateway's sight, so nothing
      // here ever learns whether it worked. Saying "executed" told the user the action completed
      // on the strength of their own click. The YOLO branch above already got this right and
      // says why (#1085 F4: observe the grant, never fire-and-forget a fictional success); this
      // sibling branch, forty lines down and doing the identical thing, was missed.
      this.deps.notifier.emit(chatSessionId, {
        kind: "action_result",
        actionRequestId: action.id,
        toolName,
        outcome: "allowed"
      });
      return { decision: "allow", reason: "Approved by user." };
    } finally {
      this.deps.confirmations.markDone(action.id);
    }
  }

  /**
   * Execute a single read tool on behalf of an actor without a session token.
   * Used by the cross-tool reasoning pre-submit path in ChatSessionManager.
   *
   * Fail-closed: only tools with risk "read" are permitted; empty services are
   * passed so the write→confirm floor is structurally un-bypassable; handler
   * throws are sanitized the same way runHandler sanitizes them.
   */
  async runReadToolForActor(
    actorUserId: string,
    toolName: string,
    rawInput: unknown
  ): Promise<GatewayToolResponse> {
    const found = (await this.executableTools(actorUserId)).find(
      (entry) => entry.tool.name === toolName
    );
    if (!found) {
      return { ok: false, error: `Tool not available: ${toolName}` };
    }
    if (found.tool.risk !== "read") {
      return { ok: false, error: `Tool ${toolName} is not a read tool` };
    }

    let input: Record<string, unknown>;
    try {
      input = await validateToolInput(found.tool.inputSchema, rawInput, {
        // Missing provenance is untrusted: only the registry's explicit false marker gets the
        // built-in synchronous path.
        external: found.tool.isExternal !== false,
        toolName
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Invalid input" };
    }

    const requestId = `cross-tool_${randomUUID()}`;
    const access: AccessContext = { actorUserId, requestId };
    const localTimezone = (await this.deps.resolveLocalTimezone?.(actorUserId)) ?? undefined;
    const ctx: ToolContext = { actorUserId, requestId, chatSessionId: "", localTimezone };

    const readServices = this.deps.readToolServices ?? {};
    try {
      const result = await this.executeTool(found, input, ctx, readServices, access);
      return {
        ok: true,
        data: renderAndCap(
          found.tool.outputSchema,
          result,
          found.tool.externalContent ? found.tool.name : undefined
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

  /**
   * The subset of toolServices this tool declared via requiresServices — but ONLY for non-read
   * tools. A read tool (risk → "run", no confirmation) receives NOTHING,
   * so no injected (potentially write-capable) service can be invoked without an Approve. This
   * keeps the write→confirm floor structurally un-bypassable by a mistaken/hostile read-tool
   * requiresServices declaration, with no service-risk taxonomy (Codex HIGH #5). The per-tool
   * subset also means a tool can never reach an undeclared (write-capable) service (Codex HIGH #1).
   */
  private servicesFor(tool: ModuleAssistantToolManifest): ToolServices {
    if (tool.risk === "read") {
      // Read tools bypass confirmAndRun so they never receive write-capable services.
      // readToolServices carries only informational (read-only) services — safe here.
      return this.deps.readToolServices ?? {};
    }
    const registry = this.deps.toolServices ?? {};
    const keys = tool.requiresServices ?? [];
    const subset: Record<string, unknown> = {};
    for (const key of keys) {
      // executableTools already guaranteed every declared key is registered (fail-closed),
      // so this is always present here; guard defensively regardless.
      if (key in registry) subset[key] = registry[key];
    }
    return subset;
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
        Promise.resolve(hook(scopedDb, input, ctx, this.servicesFor(found.tool)))
      );
    } catch {
      return true;
    }
  }

  private async runHandler(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<RunHandlerOutcome> {
    const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
    const services = this.servicesFor(found.tool);
    const startedAt = performance.now();
    try {
      const result = await this.executeTool(found, input, ctx, services, access);
      const durationMs = Math.round(performance.now() - startedAt);
      const sanitized = sanitizeAssistantToolResult(found.tool.outputSchema, result);
      // Detection must run on the raw pre-sanitize payload: sanitizeAssistantToolResult allow-lists
      // to schema-declared keys, so an undeclared status/ok/error field would already be stripped
      // from structuredData. Applies to every module, built-in or external: isExternal only decides
      // whether a module's INPUT is trusted (validateToolInput above), not whether its output can be
      // taken at face value. Gating on isExternal used to mean a built-in module's self-reported
      // error (e.g. tasks.updateStatus returning {error: "Task not found"} inside an ok:true result)
      // never got flagged and was recorded as a plain "success" (#1252 finding).
      const errorClass = isModuleReportedError(result.data) ? "module_reported" : null;
      return {
        response: {
          ok: true,
          data: renderAndCap(
            found.tool.outputSchema,
            result,
            // Scope trust-boundary wrapping to tools with untrusted external content only.
            // Internal tools whose output Jarvis controls must not be wrapped (PR #435 sets
            // externalContent: true on web.search + web.read; all others leave it unset).
            found.tool.externalContent ? found.tool.name : undefined
          ),
          structuredData: sanitized.data,
          // #1133 — media (image bytes) bypasses renderAndCap on purpose: sanitize's schema
          // projection would drop the field and the 16k text cap would truncate base64. Size
          // is already bounded at upload (attachment caps), and the payload flows only over
          // the engine's MCP stdio channel — never into logs, DB, or job payloads.
          ...(result.media ? { media: result.media } : {})
        },
        audit: {
          // A tool's execute may request a distinct audit outcome (#2175 Task 7). Only a registry-
          // trusted built-in tool's claim is honoured: an external tool cannot say "suppressed"/
          // "refused" to hide a real failure from audit.
          outcome:
            (found.tool.isExternal === false ? result.auditOutcome : undefined) ??
            (errorClass === null ? "success" : "failed"),
          durationMs,
          errorClass
        }
      };
    } catch (error) {
      // #1251: a tool handler (including third-party module handlers) can throw an arbitrary
      // hostile object. Never touch it — no property access, no instanceof, no prototype walk.
      // isExternal === false trusts the TOOL, not the shape of what it throws — a first-party
      // dependency can still surface a hostile Proxy, so classifyToolDependencyFailure/
      // safeErrorName brand-check with util.types.isNativeError before reading anything, exactly
      // like this branch's untrusted path already refuses to touch `error` at all.
      const isFirstParty = found.tool.isExternal === false;
      const cause = isFirstParty ? classifyToolDependencyFailure(error) : null;
      const errorName = isFirstParty ? safeErrorName(error) : undefined;
      (this.deps.logger ?? defaultGatewayLogger).error("tool_handler_threw", {
        toolName: found.dto.name,
        requestId: ctx.requestId,
        errorClass: "handler_error",
        ...(cause ? { cause } : {}),
        ...(errorName ? { errorName } : {})
      });
      return {
        response: {
          ok: false,
          // The cause id goes in the log above; the chat gets ordinary words. The model is free to
          // repeat this text to the user, so it must already read like something a person wrote.
          error:
            found.tool.safeErrors === true &&
            nodeUtilTypes.isNativeError(error) &&
            error instanceof HttpError
              ? error.message
              : cause
                ? `Tool ${found.dto.name} failed: ${describeToolDependencyCause(cause)}.`
                : `Tool ${found.dto.name} failed`
        },
        audit: {
          outcome: "failed",
          durationMs: Math.round(performance.now() - startedAt),
          errorClass: "handler_error"
        }
      };
    }
  }

  private executeTool(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext,
    services: ToolServices,
    access: AccessContext
  ): Promise<ToolResult> {
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

    const action = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
      this.deps.repository.createPendingAssistantAction(scopedDb, {
        toolModuleId: found.dto.moduleId,
        toolModuleName: found.dto.moduleName,
        toolName: found.dto.name,
        permissionId: found.dto.permissionId,
        risk: found.tool.risk as "write" | "outbound" | "destructive",
        inputSummary: summarizeAssistantToolInput(input),
        requestId: ctx.requestId
      })
    );

    const pendingResolution = this.deps.confirmations.awaitResolution(
      action.id,
      this.deps.confirmTimeoutMs
    );

    const summary = [notice, this.summaryFor(found.tool, input, ctx)].filter(Boolean).join(" ");

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
          previewHook(scopedDb, input, ctx, this.servicesFor(found.tool))
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
      ...(preview ? { preview } : {})
    });

    const outcome = await pendingResolution;

    // #2149: markDone unblocks resolveAndAwaitCompletion, which the Approve/Deny HTTP route
    // awaits before responding — must fire once this call has fully finished handling the
    // outcome (both branches below), on every exit path, so the caller never observes
    // "confirmed" before the handler run below has actually happened. Deliberately outside the
    // fire-and-forget `recordAudit` calls (`void this.recordAudit(...)`) — those stay
    // unawaited on purpose and must not reopen the same kind of delay on the audit write.
    try {
      if (outcome !== "confirmed") {
        this.deps.notifier.emit(ctx.chatSessionId, {
          kind: "action_result",
          actionRequestId: action.id,
          toolName: found.dto.name,
          outcome: "denied",
          reason:
            outcome === "timeout"
              ? "Timed out awaiting confirmation."
              : outcome === "cancelled"
                ? "Action cancelled."
                : "Denied by user."
        });
        const approvalMode =
          outcome === "timeout" ? "timeout" : outcome === "rejected" ? "rejected" : "cancelled";
        void this.recordAudit(access, found, {
          approvalMode,
          outcome: outcome === "cancelled" ? "cancelled" : "denied",
          durationMs: null,
          chatSessionId: ctx.chatSessionId
        });
        const reason =
          outcome === "timeout"
            ? "Timed out awaiting confirmation — still pending in your drawer."
            : "Denied by user.";
        return { ok: false, denied: true, reason };
      }

      const { response: result, audit } = await this.runHandler(found, input, ctx);
      this.deps.notifier.emit(ctx.chatSessionId, {
        kind: "action_result",
        actionRequestId: action.id,
        toolName: found.dto.name,
        outcome: audit.errorClass === null ? "executed" : "error",
        ...(result.ok
          ? { result: liveStreamResult(found.tool, result) }
          : { reason: gatewayFailureReason(result) }),
        ...(result.ok && found.tool.affectsQueryKeys
          ? { affectsQueryKeys: found.tool.affectsQueryKeys }
          : {})
      });
      void this.recordAudit(access, found, {
        approvalMode: "confirmed",
        ...audit,
        chatSessionId: ctx.chatSessionId
      });
      return result;
    } finally {
      this.deps.confirmations.markDone(action.id);
    }
  }

  private summaryFor(
    tool: ModuleAssistantToolManifest,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): string {
    if (typeof tool.summarize === "function") {
      return tool.summarize(input, ctx);
    }
    return tool.actionLabel ?? tool.name;
  }

  private async firstRunNotice(
    found: ExecutableTool,
    prefs: AgencyPrefLookup
  ): Promise<string | undefined> {
    if (
      found.dto.moduleId !== "tasks" ||
      found.tool.risk !== "write" ||
      found.tool.executionPolicy !== "auto" ||
      !prefs.upsert
    ) {
      return undefined;
    }
    try {
      if ((await prefs.get(TASKS_FIRST_RUN_NOTICE_KEY)) === true) return undefined;
      await prefs.upsert(TASKS_FIRST_RUN_NOTICE_KEY, true);
      return TASKS_FIRST_RUN_NOTICE;
    } catch {
      return undefined;
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
        // Fail closed #1: a read tool must NOT declare services — a read dispatches without the
        // confirm gate, so a write-capable service on a read tool would bypass the write→confirm
        // floor. Such a manifest is a misconfiguration; hide it rather than risk a bypass (HIGH #5).
        if (declaredServices.length > 0 && tool.risk === "read") {
          continue;
        }
        // Fail closed #2: a tool whose required services we cannot satisfy is hidden — never
        // listed and never confirmable. Prevents an approve→execute-fail dead-end (HIGH #2).
        const registry = this.deps.toolServices ?? {};
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

  private async recordAuditRaw(
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
    }
  ): Promise<void> {
    try {
      await this.deps.runner.withDataContext(access, (scopedDb) =>
        this.deps.repository.insertActionAuditLog(scopedDb, {
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

  private async recordAudit(
    access: AccessContext,
    found: ExecutableTool,
    opts: {
      approvalMode: InsertAuditLogInput["approvalMode"];
      outcome: InsertAuditLogInput["outcome"];
      durationMs: number | null;
      errorClass?: string | null;
      chatSessionId?: string;
    }
  ): Promise<void> {
    return this.recordAuditRaw(
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
}
