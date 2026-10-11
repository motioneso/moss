import type {
  ActionRequestPreview,
  ModuleAssistantToolRisk,
  MossModuleManifest,
  SelfOperationExclusionCategory,
  ToolContext,
  ToolResult,
  ToolResultMedia,
  ToolServices
} from "@moss/module-sdk";

export type AdmissionPath =
  | "tool_external_content"
  | "app_action_outside"
  | "attachment_read"
  | "recall_memory_turn"
  | "recall_cross_tool"
  | "recall_notes"
  | "launch_memory_seed"
  | "seed_route"
  | "evening_seed"
  | "module_control_context"
  | "native_vault_read"
  | "native_tool_result"
  | "outside_agent_read"
  | "outside_agent_web"
  | "outside_agent_shell"
  | "outside_agent_launch"
  | "tool_external_descriptors"
  | "classifier_candidates";

export type AutomaticExecution<T> =
  | { readonly kind: "ran"; readonly value: T }
  | { readonly kind: "confirm" };

export interface ConversationProvenancePort {
  /** Missing, legacy and foreign threads are tainted. The actor owns the lookup scope. */
  isTainted(actorUserId: string, threadId: string | undefined): Promise<boolean>;
  recordAdmission(actorUserId: string, threadId: string, path: AdmissionPath): Promise<void>;
  /**
   * True only for an owned thread durably marked as holding outside content with no automatic
   * run in flight. The user's trust runs writes past this taint and no other (#3338).
   */
  isMarked?(actorUserId: string, threadId: string | undefined): Promise<boolean>;
  /** Claim before execution, release only after its actual promise settles. No expiry. */
  runAutomatic?<T>(
    actorUserId: string,
    threadId: string | undefined,
    execute: () => Promise<T>
  ): Promise<AutomaticExecution<T>>;
}

export interface CallCardDetails {
  readonly presentation?: "human";
  /** Host-owned semantic identity; never derived from title text. */
  readonly approvalKind?: "memory_delete" | "note_delete";
  readonly target: string | null;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
}

export type PerCallResolution =
  | {
      readonly kind: "refuse";
      readonly reason: "unknown_route" | "blocked" | "consent_off" | "not_ready" | "invalid_input";
      /** Trusted server schema feedback; no target lookup, grant, approval or write occurred. */
      readonly validationError?: { readonly title: string; readonly message: string };
      readonly category?: SelfOperationExclusionCategory;
    }
  | {
      readonly kind: "proceed";
      readonly risk: ModuleAssistantToolRisk;
      readonly externalContent: boolean;
      readonly disclosureExternalContent?: boolean;
      readonly forceConfirm: boolean;
      readonly confirmWhenTainted: boolean;
      readonly summary: string;
      readonly details: CallCardDetails;
      /** Host-owned disclosure requirement, frozen with this exact resolved target. */
      readonly requiresTarget?: true;
      /** Opaque server-side target identity. Never streamed on the card or persisted. */
      readonly targetVersion?: string;
      readonly affectsModules: readonly string[];
    };

export type PerCallResolver = (
  input: Record<string, unknown>,
  ctx: ToolContext
) => Promise<PerCallResolution>;

/** Composition-owned capabilities bound to exactly this resolved input and actor. */
export type PerCallServices = (
  input: Record<string, unknown>,
  ctx: ToolContext,
  resolution: Extract<PerCallResolution, { kind: "proceed" }>
) => ToolServices;

/**
 * Composition-owned transport for a resolved, capability-bound call. It owns its data scopes;
 * the gateway must not hold an unused transaction while the transport opens its own scopes.
 */
export type PerCallExecutor = (
  input: Record<string, unknown>,
  ctx: ToolContext,
  resolution: Extract<PerCallResolution, { kind: "proceed" }>,
  boundServices: ToolServices
) => Promise<ToolResult>;

/**
 * Resolves the modules whose tools are exposed for a user. The enablement SEAM
 * (ADR 0009 §3): the real resolver (createActiveModulesResolver in
 * @moss/module-registry) reads the app.module_enablement deny-list under
 * withDataContext, so a disabled module's tools vanish from the surface with no
 * change to the gateway or any module. Async because it does a DB round-trip.
 */
export type ActiveModulesResolver = (actorUserId: string) => Promise<readonly MossModuleManifest[]>;

/**
 * A record the gateway pushes into a chat session's live stream (out-of-band from
 * the tmux transcript). The real implementation wires to chat-session-manager in
 * the transport/integration plan.
 */
export type GatewaySessionRecord =
  | {
      readonly kind: "action_request";
      /** Set exclusively by the native permission adapters. */
      readonly nativePermission?: true;
      /** Host-marked connected tool; complete arguments are shown verbatim. */
      readonly externalTool?: true;
      readonly exactArguments?: string;
      /** Server-only completeness rule declared by the host's per-call resolver. */
      readonly requiresTarget?: true;
      /** Server-only proof copied from the owned persisted request, never provider/model input. */
      readonly liveOrigin?: {
        readonly actorUserId: string;
        readonly chatSessionId: string;
        readonly threadId: string;
      };
      /** Server token's frozen conversation binding; never supplied by model tool input. */
      readonly originThreadId?: string;
      readonly actionRequestId: string;
      readonly toolName: string;
      readonly summary: string;
      /** Optional plain title frozen with the card; raw native descriptions never supply it. */
      readonly outcomeTitle?: string;
      /**
       * Optional rich, server-derived card preview (e.g. email reply recipient/subject/body).
       * Rides the live stream ONLY — it is never written to the persisted action_request row,
       * whose `inputSummary` stays key-names-only (metadata-only persistence). Produced by the
       * tool's async `preview` hook under withDataContext; absent when the tool declares none
       * or the hook returned undefined / threw (the card still renders from `summary`).
       */
      readonly preview?: ActionRequestPreview;
      /** Server-derived target and field rows, live only; never persisted. */
      readonly details?: CallCardDetails;
      readonly outsideContentNotice: boolean;
    }
  | {
      readonly kind: "action_result";
      /** Recovery replay persists the original thread without broadcasting an old live outcome. */
      readonly historyOnly?: boolean;
      /** Server token's frozen conversation binding, for results with no pending request row. */
      readonly originThreadId?: string;
      readonly actionRequestId: string;
      readonly toolName: string;
      readonly outcome: "executed" | "denied" | "error" | "allowed";
      /** Plain server-authored card title frozen before approval, independent of handler output. */
      readonly summary?: string;
      /** Decision provenance; execution outcome is intentionally separate. */
      readonly decidedBy?: "person" | "policy" | "timeout" | "cancelled";
      /** Time from the approval card becoming visible to its answer. */
      readonly holdDurationMs?: number | null;
      /** Structured, sanitized result for a module-owned inline artifact. Live only. */
      readonly result?: Record<string, unknown>;
      /** Safe typed failure/denial reason; arbitrary handler output is never attached. */
      readonly reason?: string;
      /**
       * Dot-path tokens into the frontend's `queryKeys` object, copied verbatim from the tool's
       * `affectsQueryKeys` manifest declaration when the call executed successfully. Lets the
       * shell invalidate the right cached read generically, without a per-tool switch.
       */
      readonly affectsQueryKeys?: readonly string[];
      readonly affectsModules?: readonly string[];
    };

export interface SessionNotifier {
  emit(chatSessionId: string, record: GatewaySessionRecord): void;
  /** Wait only for this server session's queued notification persistence. */
  flush?(chatSessionId: string): Promise<void>;
}

export type GatewayToolResponse =
  // #1133 — `media` is an optional verbatim pass-through from ToolResult.media (image
  // bytes for MCP image content blocks). It deliberately does NOT flow through
  // renderAndCap; see AssistantToolGateway.runHandler.
  | {
      readonly ok: true;
      readonly data: Record<string, unknown>;
      readonly structuredData?: Record<string, unknown>;
      readonly media?: ToolResultMedia;
    }
  | { readonly ok: false; readonly denied: true; readonly reason: string }
  | { readonly ok: false; readonly error: string };

/** Why the classifier gate's call was turned away before any handler ran. */
export type GatewayDeclineReason =
  | "not_available"
  | "not_in_allowlist"
  | "invalid_input"
  | "would_confirm"
  | "rate_limited"
  | "refused";

/**
 * Result of a gate call. `declined` guarantees no handler ran and no approval card was raised.
 * `would_run` is a dry-run verdict only and carries no authority. `outcome` separates a clean
 * success from a module-reported error and from a thrown handler, which the public `ok` flag hides.
 */
export type GatewayGateOutcome =
  | { readonly kind: "declined"; readonly reason: GatewayDeclineReason }
  | { readonly kind: "would_run"; readonly approvalMode: "yolo" | "auto" }
  | {
      readonly kind: "executed";
      readonly response: GatewayToolResponse;
      readonly outcome: "success" | "module_reported_error" | "handler_error";
    };
