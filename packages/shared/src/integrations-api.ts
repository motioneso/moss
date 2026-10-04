export type IntegrationKind = "mcp" | "openapi";
export type CredentialPlacementKind = "bearer" | "header" | "query";

export interface CredentialPlacement {
  readonly kind: CredentialPlacementKind;
  /** Header or query parameter name; required for kind "header" | "query". */
  readonly name?: string;
}

export interface IntegrationToolDescriptor {
  readonly name: string; // remote tool name / sanitized operationId (no connection prefix)
  readonly description: string;
  readonly group: string; // OpenAPI tag; "" for MCP/ungrouped
  readonly inputSchema: Record<string, unknown> | null;
  /** Absent means "did not say" — never coerced to false. */
  readonly readOnly?: boolean;
  readonly idempotent?: boolean;
  readonly destructive?: boolean;
}

export interface IntegrationSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: IntegrationKind;
  readonly url: string;
  readonly enabled: boolean;
  readonly hasCredential: boolean;
  readonly toolCount: number;
  readonly enabledToolCount: number;
  readonly lastDiscoveryAt: string | null;
  readonly lastError: string | null;
}

export interface IntegrationGroupSummary {
  readonly name: string;
  readonly toolCount: number;
  readonly enabled: boolean;
}

/** Owner-reviewed classifier risk for one connected tool. `null` (absent) means unknown and keeps the tool out. */
export type IntegrationClassifierRisk = "read" | "write" | "outbound" | "destructive";

/** How the classifier is allowed to supply one argument of a connected tool. */
export type IntegrationClassifierArgumentKind = "enum" | "candidates" | "extract";

export interface IntegrationClassifierArgument {
  readonly kind: IntegrationClassifierArgumentKind;
  /** kind "enum": the fixed values the classifier may pick from. */
  readonly values?: readonly string[];
  /** kind "candidates": name of the runtime source that produces the candidate list. */
  readonly candidateSource?: string;
}

export type IntegrationClassifierPreparationState = "current" | "stale";

/** One stored, owner-reviewed classifier preparation for a single connected tool. */
export interface IntegrationClassifierToolPreparation {
  readonly toolName: string;
  /** Whether the owner opted this tool into the classifier. Default false. */
  readonly optIn: boolean;
  /** Reviewed risk; `null` when the owner has not classified it — the tool stays out of the menu. */
  readonly reviewedRisk: IntegrationClassifierRisk | null;
  readonly description: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  readonly replyTemplate: string;
  readonly candidateSource?: string;
  /** Fingerprint of the definition this review was saved against. */
  readonly definitionFingerprint: string;
  readonly reviewedAt: string;
  /** "stale" when the discovered definition no longer matches the saved fingerprint. */
  readonly state: IntegrationClassifierPreparationState;
  readonly preparationVersion: number;
}

/**
 * Body for saving one reviewed tool preparation. A cancelled review never calls this, so no draft
 * is persisted. `reviewedFingerprint` is compared with the current discovered definition; a
 * mismatch is rejected so an old tab cannot approve a superseded draft.
 */
export interface SaveIntegrationClassifierToolRequest {
  readonly optIn: boolean;
  readonly reviewedRisk: IntegrationClassifierRisk | null;
  readonly description: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  readonly replyTemplate: string;
  readonly candidateSource?: string;
  readonly reviewedFingerprint: string;
}

/** A tool's sort as read against its current definition (#2984). Anything but `current` asks. */
export type IntegrationClassifierSortStatus = "current" | "stale" | "failed" | "never_tried";

/** One discovered tool's sort and whether chat asks before running it (spec 8.3, #2984). */
export interface IntegrationClassifierToolSort {
  readonly toolName: string;
  readonly status: IntegrationClassifierSortStatus;
  /** The sorted group as its risk. Set only when `status` is `current`. */
  readonly risk: IntegrationClassifierRisk | null;
  /** `unsafe`: the tool's text held the stored credential, so it was not sent. Set only when failed. */
  readonly failure: "error" | "unsafe" | null;
  /** The owner allowed this Sends things out tool to run without asking. */
  readonly sendWithoutAsking: boolean;
  /** Ordinary chat shows an approval card before running this tool, unless YOLO mode is on. */
  readonly asksFirst: boolean;
}

/**
 * Body for `PUT /api/integrations/:id/classifier/send-without-asking` (#2984). `allow: true` lets
 * the named Sends things out tools run without asking, all or nothing; `allow: false` clears them.
 */
export interface SetIntegrationSendWithoutAskingRequest {
  readonly allow: boolean;
  readonly toolNames: readonly string[];
}

export interface IntegrationDetail extends IntegrationSummary {
  readonly credentialPlacement: CredentialPlacement | null;
  readonly tools: readonly IntegrationToolDescriptor[];
  readonly groups: readonly IntegrationGroupSummary[];
  readonly enabledGroups: readonly string[];
  readonly enabledTools: readonly string[];
  readonly mutedTools: readonly string[];
  /** Per-connection escape hatch: named tools skip in-burst duplicate suppression (#2175 Task 3). Off by default. */
  readonly unsuppressedTools: readonly string[];
  /** True when toolCount > threshold: groups start off, user opts in per group. */
  readonly groupOptIn: boolean;
  /** OpenAPI only: true when the spec was pasted rather than fetched from a URL — refresh needs a new paste. */
  readonly specPasted: boolean;
  /** Per-connection classifier opt-in (#2884). Default false. */
  readonly classifierEnabled: boolean;
  /** Owner-reviewed classifier preparation, one entry per reviewed discovered tool. */
  readonly classifierPreparation: readonly IntegrationClassifierToolPreparation[];
  /** One entry per discovered tool, in discovered order (#2984). */
  readonly classifierTools: readonly IntegrationClassifierToolSort[];
}

export interface CreateIntegrationRequest {
  readonly name: string;
  readonly kind: IntegrationKind;
  /** MCP: the server URL. OpenAPI: the spec URL — unless `spec` is pasted, then the service base URL. */
  readonly url: string;
  /** OpenAPI only: paste the spec document (JSON text) instead of fetching it from `url`. */
  readonly spec?: string;
  readonly credential?: string;
  readonly credentialPlacement?: CredentialPlacement;
}

export interface UpdateIntegrationRequest {
  readonly name?: string;
  readonly url?: string;
  readonly enabled?: boolean;
  readonly credential?: string | null; // null clears
  readonly credentialPlacement?: CredentialPlacement | null;
  readonly enabledGroups?: readonly string[];
  readonly enabledTools?: readonly string[];
  readonly mutedTools?: readonly string[];
  readonly unsuppressedTools?: readonly string[];
  /** Per-connection classifier opt-in (#2884). */
  readonly classifierEnabled?: boolean;
}

export interface ListIntegrationsResponse {
  readonly integrations: readonly IntegrationSummary[];
}

export const INTEGRATION_LIVE_TOOL_THRESHOLD = 30;

/**
 * What the owner is told before their default chat model reads a connection's tool definitions
 * (plan 2b.3, #2894; Ben's ruling 6). No price is quoted: only that preparing costs model usage.
 * 2b.4 renders this before the prepare request; the prepare response echoes it.
 */
export interface IntegrationClassifierPreparationDisclosure {
  /** The definition fields sent to the owner's model, in plain words. */
  readonly sent: string;
  /** That a hosted model sends them to its provider. */
  readonly provider: string;
  /** That preparing and re-preparing use model usage. */
  readonly cost: string;
  /** What the setup request never includes. */
  readonly excluded: string;
}

export const INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE: IntegrationClassifierPreparationDisclosure =
  {
    sent:
      "Each tool's name, description, group, input schema and read-only, repeatable and " +
      "destructive hints. Descriptions go out exactly as the service wrote them. Credential " +
      "header parameters and default or example values are removed from the schema first.",
    provider:
      "Your current default chat model reads these once; if it is a hosted model, they also go " +
      "to that model's provider.",
    cost: "Preparing, and preparing again after a change, uses model usage and may cost money.",
    excluded:
      "Moss does not add the connection's saved address or sign-in settings to this request, " +
      "and it does not run any tool for this step. Text the service provides, such as tool " +
      "descriptions and choice lists, is sent as written and is not checked for secrets, " +
      "including saved sign-in details."
  };

/** Why one tool's draft could not be produced. Fixed codes; never raw provider text. */
export type IntegrationClassifierDraftFailure =
  | "provider_error"
  | "invalid_draft"
  | "aborted"
  | "definition_too_large";

/** A validated, transient preparation draft for one tool. Not stored until 2b.2's save. */
export interface IntegrationClassifierToolDraft {
  readonly toolName: string;
  /** The definition fingerprint the draft is bound to; a later change makes it stale at save. */
  readonly definitionFingerprint: string;
  readonly description: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  readonly replyTemplate: string;
}

export interface IntegrationClassifierToolDraftFailure {
  readonly toolName: string;
  readonly reason: IntegrationClassifierDraftFailure;
}

/**
 * Reply to `POST /api/integrations/:id/classifier/prepare`, the owner's Try again (#2984 R2.4).
 * The request queues a background run that saves each prepared tool itself, so the reply carries
 * no drafts.
 */
export interface PrepareIntegrationClassifierResponse {
  readonly disclosure: IntegrationClassifierPreparationDisclosure;
  readonly status: "ok" | "unavailable" | "unsupported_model";
  readonly drafts: readonly IntegrationClassifierToolDraft[];
  /** Tools whose unchanged reviewed definition was reused, so no model call was made. */
  readonly reused: readonly string[];
  readonly failed: readonly IntegrationClassifierToolDraftFailure[];
  /** Eligible tools not drafted in this call because of the per-call bound. */
  readonly remaining: number;
}

/**
 * Reply to `POST /api/integrations/:id/classifier/sort` (#2984 R2.2): the owner's Try again.
 * The sort runs in the background and re-sends tools whose last sort failed.
 */
export interface SortIntegrationClassifierResponse {
  readonly status: "queued";
}

/** Body for the prepare request. */
export interface PrepareIntegrationClassifierRequest {
  /** Re-draft every target, even one whose reviewed definition is unchanged (explicit re-prepare). */
  readonly force?: boolean;
}
