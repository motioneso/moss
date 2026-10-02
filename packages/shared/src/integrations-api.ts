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
