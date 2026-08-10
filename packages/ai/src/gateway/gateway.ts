import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type {
  ActionRequestPreview,
  MossModuleManifest,
  ModuleAssistantToolManifest,
  ToolContext,
  ToolExecute,
  ToolServices
} from "@moss/module-sdk";
import type { ActionAuditInputSummary, AiAssistantToolDto } from "@moss/shared";

import { summarizeAssistantToolInput } from "../assistant-tools.js";
import type { AiRepository, InsertAuditLogInput } from "../repository.js";
import { AutoRunRateLimiter } from "./auto-run-rate-limit.js";
import type { ConfirmationRegistry } from "./confirmation-registry.js";
import { validateToolInput } from "./input-validation.js";
import { renderAndCap, sanitizeAssistantToolResult } from "./output-validation.js";
import { resolvePolicy } from "./policy.js";
import type { AgencyPrefLookup, ActionPolicyLookup } from "./policy.js";
import { isSelfOperationExcluded } from "./self-operation.js";
import type { SessionTokenRegistry } from "./session-tokens.js";
import type { ActiveModulesResolver, GatewayToolResponse, SessionNotifier } from "./types.js";

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
  /**
   * Returns the user's configured IANA timezone (e.g. "America/Chicago"), or null if unknown.
   * Injected by the composition root; used to populate ToolContext.localTimezone so tools that
   * format user-visible date/time strings (e.g. calendar approval cards) use the correct timezone.
   */
  readonly resolveLocalTimezone?: (actorUserId: string) => Promise<string | null>;
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
// Bash and Task stay permanently gated: YOLO removes confirmation only for these mutation-only
// tools, and unknown/future native capabilities fail closed to the normal confirmation path.
const NATIVE_YOLO_AUTO_ALLOW = new Set(["Edit", "Write", "NotebookEdit"]);
// #1158: read-only native META-tools that must never require a user confirmation.
// Claude Code loads its MCP tool schemas lazily via the native ToolSearch tool; gating it
// behind the confirm flow deadlocks the permission hook (150s confirm wait == 150s hook
// deadline), the hook fails closed, claude retries in silence, and the #456 idle watchdog
// kills the live engine (prod outage 2026-07-18, issue #1157). Allow immediately with no
// pending action row — ToolSearch fires many times per conversation and cannot mutate
// anything, so a row per call is audit spam. Keep this set minimal: anything unlisted
// (including read-only tools like Grep/Read) stays on the confirm path.
const NATIVE_READONLY_AUTO_ALLOW = new Set(["ToolSearch"]);
const NATIVE_CONFIG_FILE_NAMES = new Set([
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  ".mcp.json",
  "keybindings.json",
  // #1085 F2: these cwd-root files enforce the native permission boundary; auto-allowing a
  // rewrite would let later Bash/Task hooks bypass the gateway and every audit row.
  ".jarvis-claude-permission-hook.mjs",
  ".jarvis-claude-settings.json",
  ".jarvis-claude-permission-token",
  ".claude.json"
]);

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
      input = validateToolInput(found.tool.inputSchema, rawInput);
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
        const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
        void this.recordAudit(access, found, {
          approvalMode: "yolo",
          outcome: "denied",
          errorClass: "rate_limited",
          chatSessionId: ctx.chatSessionId
        });
        return {
          ok: false,
          denied: true,
          reason: "Rate limit exceeded for unattended runs of this tool. Try again shortly."
        };
      }
      const result = await this.runHandler(found, input, ctx);
      this.deps.notifier.emit(ctx.chatSessionId, {
        kind: "action_result",
        actionRequestId: ctx.requestId,
        toolName: found.dto.name,
        outcome: result.ok ? "executed" : "error",
        ...(result.ok ? { result: result.data } : { reason: gatewayFailureReason(result) }),
        ...(result.ok && found.tool.affectsQueryKeys
          ? { affectsQueryKeys: found.tool.affectsQueryKeys }
          : {})
      });
      const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
      void this.recordAudit(access, found, {
        approvalMode: "yolo",
        outcome: result.ok ? "success" : "failed",
        errorClass: result.ok ? null : "handler_error",
        chatSessionId: ctx.chatSessionId
      });
      return result;
    }
    if ((await resolvePolicy(found.tool, found.dto.moduleId, input, lookup)) === "run") {
      if (
        found.tool.risk !== "read" &&
        !this.autoRunLimiter.consume(ctx.actorUserId, found.dto.name)
      ) {
        const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
        void this.recordAudit(access, found, {
          approvalMode: "auto",
          outcome: "denied",
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
      const result = await this.runHandler(found, input, ctx);
      if (found.tool.risk !== "read") {
        this.deps.notifier.emit(ctx.chatSessionId, {
          kind: "action_result",
          actionRequestId: ctx.requestId,
          toolName: found.dto.name,
          outcome: result.ok ? "executed" : "error",
          ...(result.ok ? { result: result.data } : { reason: gatewayFailureReason(result) }),
          ...(result.ok && found.tool.affectsQueryKeys
            ? { affectsQueryKeys: found.tool.affectsQueryKeys }
            : {})
        });
        const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
        void this.recordAudit(access, found, {
          approvalMode: "auto",
          outcome: result.ok ? "success" : "failed",
          errorClass: result.ok ? null : "handler_error",
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

    this.deps.notifier.emit(chatSessionId, {
      kind: "action_result",
      actionRequestId: action.id,
      toolName,
      outcome: "executed"
    });
    return { decision: "allow", reason: "Approved by user." };
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
      input = validateToolInput(found.tool.inputSchema, rawInput);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Invalid input" };
    }

    const requestId = `cross-tool_${randomUUID()}`;
    const access: AccessContext = { actorUserId, requestId };
    const localTimezone = (await this.deps.resolveLocalTimezone?.(actorUserId)) ?? undefined;
    const ctx: ToolContext = { actorUserId, requestId, chatSessionId: "", localTimezone };

    const readServices = this.deps.readToolServices ?? {};
    try {
      const result = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
        found.execute(scopedDb, input, ctx, readServices)
      );
      return {
        ok: true,
        data: renderAndCap(
          found.tool.outputSchema,
          result,
          found.tool.externalContent ? found.tool.name : undefined
        )
      };
    } catch {
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

    const access: AccessContext = { actorUserId, requestId: `mcp_${randomUUID()}` };
    const resolved = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
      this.deps.repository.resolveAssistantAction(scopedDb, actionRequestId, { status })
    );
    // Only unblock the pending call if the DB row was actually updated (owner matches + still pending).
    // Without this guard a logged-in user could unblock another user's tool call via a guessed ID.
    if (!resolved) return "not_found";
    this.deps.confirmations.resolve(actionRequestId, status);
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

  private async runHandler(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<GatewayToolResponse> {
    const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
    const services = this.servicesFor(found.tool);
    try {
      const result = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
        found.execute(scopedDb, input, ctx, services)
      );
      const sanitized = sanitizeAssistantToolResult(found.tool.outputSchema, result);
      return {
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
      };
    } catch {
      // never leak internals/secrets from a handler throw
      return { ok: false, error: `Tool ${found.dto.name} failed` };
    }
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
        risk: found.tool.risk as "write" | "destructive",
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
        chatSessionId: ctx.chatSessionId
      });
      const reason =
        outcome === "timeout"
          ? "Timed out awaiting confirmation — still pending in your drawer."
          : "Denied by user.";
      return { ok: false, denied: true, reason };
    }

    const result = await this.runHandler(found, input, ctx);
    this.deps.notifier.emit(ctx.chatSessionId, {
      kind: "action_result",
      actionRequestId: action.id,
      toolName: found.dto.name,
      outcome: result.ok ? "executed" : "error",
      ...(result.ok ? { result: result.data } : { reason: gatewayFailureReason(result) }),
      ...(result.ok && found.tool.affectsQueryKeys
        ? { affectsQueryKeys: found.tool.affectsQueryKeys }
        : {})
    });
    void this.recordAudit(access, found, {
      approvalMode: "confirmed",
      outcome: result.ok ? "success" : "failed",
      errorClass: result.ok ? null : "handler_error",
      chatSessionId: ctx.chatSessionId
    });
    return result;
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
    const out: ExecutableTool[] = [];
    for (const module of modules) {
      for (const tool of module.assistantTools ?? []) {
        if (typeof tool.execute !== "function") {
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
      actionKind: "write" | "destructive";
    },
    opts: {
      approvalMode: InsertAuditLogInput["approvalMode"];
      outcome: InsertAuditLogInput["outcome"];
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
          inputSummary: opts.inputSummary ?? null
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
        actionKind: found.tool.risk as "write" | "destructive"
      },
      opts
    );
  }
}

function gatewayFailureReason(result: Extract<GatewayToolResponse, { ok: false }>): string {
  return "reason" in result ? result.reason : result.error;
}

function safeNativeToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (trimmed.length === 0) return "Unknown";
  return trimmed.slice(0, 120);
}

async function nativeYoloCanAutoAllow(
  toolName: string,
  input: Record<string, unknown>,
  workingDirectory: string | undefined
): Promise<boolean> {
  if (!NATIVE_YOLO_AUTO_ALLOW.has(toolName)) return false;
  const target = input[toolName === "NotebookEdit" ? "notebook_path" : "file_path"];
  if (typeof workingDirectory !== "string" || workingDirectory.trim() === "") return false;
  if (typeof target !== "string" || target.trim() === "") return false;

  try {
    const lexicalRoot = resolve(workingDirectory);
    const lexicalTarget = resolve(lexicalRoot, target);
    const lexicalRelative = relative(lexicalRoot, lexicalTarget);
    // #1085 F3: native YOLO is workspace-scoped. Absolute paths and traversal that escape cwd
    // stay gated even when they name ordinary-looking files such as ~/.bashrc or .git hooks.
    if (
      lexicalRelative === ".." ||
      lexicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(lexicalRelative)
    ) {
      return false;
    }

    const canonicalRoot = await realpath(lexicalRoot);
    const canonicalTarget = await realpathWriteTarget(lexicalTarget);
    if (canonicalTarget === undefined) return false;
    const canonicalRelative = relative(canonicalRoot, canonicalTarget);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      return false;
    }

    return (
      !canonicalTarget.split(sep).includes(".claude") &&
      !NATIVE_CONFIG_FILE_NAMES.has(basename(canonicalTarget))
    );
  } catch {
    return false;
  }
}

async function realpathWriteTarget(target: string): Promise<string | undefined> {
  const unresolved: string[] = [];
  let existing = target;

  for (;;) {
    try {
      return resolve(await realpath(existing), ...unresolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }

    // #1085 F3: a dangling symlink can still redirect a subsequent Write outside cwd. Detect it
    // while walking to the deepest existing ancestor; unreadable/ambiguous paths fail closed.
    try {
      if ((await lstat(existing)).isSymbolicLink()) return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }

    const parent = dirname(existing);
    if (parent === existing) return undefined;
    unresolved.unshift(basename(existing));
    existing = parent;
  }
}

function nativeToolRisk(toolName: string): "write" | "destructive" {
  return toolName === "Bash" || toolName === "Unknown" ? "destructive" : "write";
}

function nativeToolSummary(toolName: string, input: Record<string, unknown>): string {
  const inputKeyCount = Object.keys(input).length;
  return `Claude wants to use native ${toolName} (${inputKeyCount} field(s)).`;
}
