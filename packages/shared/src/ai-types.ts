export type AiProviderKind = "openai-compatible" | "anthropic" | "google" | "ollama" | "custom";
// #874 — discriminator on app.ai_provider_configs (migration 0149). 'assistant' rows are the chat
// LLM providers shown in the LLM Providers list and eligible for chat routing / instance-default /
// per-user pin. 'voice' is the single instance-wide STT endpoint, kept off every assistant surface
// so the two never bleed into each other (CRIT-1). Voice endpoints are OpenAI-compatible only.
export type AiProviderPurpose = "assistant" | "voice";
export type AiProviderStatus = "active" | "error" | "disabled" | "revoked";
export type AiAuthMethod = "cli" | "api_key";
export type AiProviderExecutionMode = "interactive" | "non_interactive";
export type AiModelStatus = "active" | "disabled";
// #2208: who created a model row. `manual` rows (POST /api/ai/models) survive discovery refreshes;
// `discovered` rows are pruned when the provider's live list no longer carries them.
export type AiConfiguredModelOrigin = "discovered" | "manual";

// #1110: tier/capability are canonical on @moss/module-sdk (module manifests need them for
// AI requirement declarations); re-exported here so existing @moss/shared consumers don't churn.
// Regression fix (#1110, tracked cleanup #1120): import from the ./ai-capabilities subpath, not the
// bare @moss/module-sdk barrel — the barrel eagerly re-exports rate-limit-key.ts (node:crypto),
// and AI_MODEL_CAPABILITIES is a runtime const (can't be type-only), so importing it from the
// barrel dragged node:crypto into the apps/web browser bundle.
export {
  AI_MODEL_CAPABILITIES,
  type AiModelCapability,
  type AiModelTier
} from "@moss/module-sdk/ai-capabilities";
import type { AiModelCapability, AiModelTier } from "@moss/module-sdk/ai-capabilities";

export type AiCapabilityRouteReason =
  | "admin-pin"
  | "admin-pin-unavailable"
  | "admin-pin-unavailable-fallback"
  | "manual-route"
  | "manual-route-unavailable-fallback"
  | "matched-active-model"
  | "no-active-model"
  // #870 Slice 1: explicit "an admin must configure this" state for user-facing services
  // (Chat/Voice). Distinct from `no-active-model` (worker cross-provider miss) on purpose — the UI
  // renders needs-config as an actionable admin prompt, not a silent worker skip. See resolver.
  | "needs-config";

export interface AiProviderConfigDto {
  readonly id: string;
  readonly providerKind: AiProviderKind;
  readonly displayName: string;
  readonly baseUrl: string | null;
  readonly status: AiProviderStatus;
  readonly authMethod: AiAuthMethod;
  readonly executionMode: AiProviderExecutionMode;
  readonly hasCredential: boolean;
  readonly cliAvailable: boolean;
  // #870/H1 Slice 1: the single instance-default provider. User-facing services bound to a "mode"
  // (tier) resolve their model INSIDE this provider. Globally single-valued (DB partial unique
  // index in migration 0147); the UI renders it as a mutually-exclusive radio across providers.
  readonly isInstanceDefault: boolean;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AiConfiguredModelDto {
  readonly id: string;
  readonly providerConfigId: string | null;
  readonly providerKind: AiProviderKind | null;
  readonly providerDisplayName: string;
  readonly providerStatus: AiProviderStatus;
  readonly providerModelId: string | null;
  readonly displayName: string;
  readonly capabilities: readonly AiModelCapability[];
  readonly status: AiModelStatus;
  readonly tier: AiModelTier;
  readonly allowUserOverride: boolean;
  readonly origin: AiConfiguredModelOrigin;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AiCapabilityRouteDto {
  readonly capability: AiModelCapability;
  readonly available: boolean;
  readonly reason: AiCapabilityRouteReason;
  readonly model: AiConfiguredModelDto | null;
}

/**
 * #870 Slice 1: a per-service binding. The admin binds a user-facing service to EITHER a "mode"
 * (a tier resolved inside the instance-default provider) OR a specific model. This replaces the old
 * free-for-all per-capability model route + separate per-user tier preference with one unified knob
 * per service. Stored under `ai.service_bindings` in `app.instance_settings`. #874 HIGH-2: Chat is
 * the only bindable service — Voice (STT) is configured as its own dedicated endpoint, not a binding.
 */
export type AiServiceBinding =
  | { readonly kind: "mode"; readonly tier: AiModelTier }
  | { readonly kind: "model"; readonly modelId: string };

// ---------------------------------------------------------------------------
// #915 D6: module AI service keys
// ---------------------------------------------------------------------------

// A module service key is a BINDING key (an admin routing knob), not a capability. Structured
// output for modules always resolves capability "json"; these keys only steer WHICH model serves
// it. "module.worker" is the generic default for every module without a module-specific binding;
// "module.<moduleId>" pins a single module.
export type ModuleServiceKey = `module.${string}`;

// Everything the service-binding routes can address: a user-facing capability or a module key.
export type AiServiceKey = AiModelCapability | ModuleServiceKey;

export const MODULE_WORKER_SERVICE_KEY = "module.worker" as const;
export const WORKSHOP_PLAN_SERVICE_KEY = "module.workshop.plan" as const;

// "module." + id: lowercase alnum start, then alnum/underscore/dot/dash, ≤64 chars after the
// prefix. Kept as a plain string so JSON-schema `pattern` fields can embed it verbatim
// (ai-service-binding-api.ts must stay in sync — see the comment there).
export const MODULE_SERVICE_KEY_PATTERN = "^module\\.[a-z0-9][a-z0-9_.-]{0,63}$";
const moduleServiceKeyRegex = new RegExp(MODULE_SERVICE_KEY_PATTERN);

export function isModuleServiceKey(value: string): value is ModuleServiceKey {
  return moduleServiceKeyRegex.test(value);
}

export type ModuleServiceBindingMap = Partial<Record<ModuleServiceKey, AiServiceBinding>>;

export type AiServiceBindingMapDto = Partial<Record<AiServiceKey, AiServiceBinding>>;

export interface AiProviderTestResultDto {
  readonly ok: boolean;
  readonly providerKind: AiProviderKind;
  readonly message: string;
}

export interface AiProviderDiscoveredModelDto {
  readonly providerModelId: string;
  readonly displayName: string;
  readonly capabilities: readonly AiModelCapability[];
  readonly tier: AiModelTier;
  /**
   * The model's release date (ISO 8601) when the provider's list carries one (Anthropic
   * `created_at`, OpenAI-compatible `created`). The tier ladder prefers the newest release.
   */
  readonly releasedAt?: string | null;
}

/**
 * #2208: the outcome of asking a CLI provider's vendor for its live model list. `ok` carries ids
 * only — never a credential. The same shape crosses the api <-> cli-runner socket (rpc-contract)
 * and feeds `ModelDiscoveryService` for `auth_method = "cli"` providers.
 */
export type AiCliModelListFailure = "unsupported" | "not_logged_in" | "error";
export type AiCliModelListResult =
  | {
      readonly status: "ok";
      /** `releasedAt`: ISO 8601 release date when the vendor's list carries one (0214). */
      readonly models: readonly { readonly id: string; readonly releasedAt?: string | null }[];
    }
  | { readonly status: AiCliModelListFailure; readonly message?: string };

export interface AiDiscoverModelsItemDto extends AiProviderDiscoveredModelDto {
  readonly fromCache: boolean;
  readonly fromFallback: boolean;
}

/** #2208: result of POST /api/ai/providers/:id/models/refresh. */
export interface RefreshAiProviderModelsResponse {
  /** The provider's stored model rows after the refresh (unchanged when `reason` is set). */
  readonly models: readonly AiConfiguredModelDto[];
  /** Present only when a CLI provider's live list could not be fetched; nothing was changed. */
  readonly reason?: AiCliModelListFailure | "unavailable";
  readonly message?: string;
}

export interface AiDiscoverModelsResponse {
  readonly models: readonly AiDiscoverModelsItemDto[];
  readonly fromFallback: boolean;
  readonly cacheExpiresAt: string | null;
  /**
   * #2208: present ONLY when a CLI provider's live list could not be fetched — why there are no
   * models (`not_logged_in`, `unsupported`, `error`, or `unavailable` when no runner is wired).
   */
  readonly reason?: AiCliModelListFailure | "unavailable";
  /** Plain-English detail for `reason`; never carries a secret. */
  readonly message?: string;
}

export interface AiAssistantToolDto {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly name: string;
  readonly description: string;
  readonly permissionId: string;
  readonly risk: "read" | "write" | "outbound" | "destructive";
  readonly inputSchema: Record<string, unknown> | null;
  readonly outputSchema: Record<string, unknown> | null;
}

export type AiAssistantToolInvocationStatus = "succeeded" | "blocked";
export type AiAssistantToolBlockedReason =
  | "confirmation_required"
  | "non_read_risk"
  | "unsupported_tool";
export type AiAssistantActionRisk = "write" | "outbound" | "destructive";
export type AiAssistantActionStatus = "pending" | "confirmed" | "rejected" | "cancelled";
export type ResolveAiAssistantActionStatus = Exclude<AiAssistantActionStatus, "pending">;

export interface InvokeAiAssistantToolRequest {
  readonly input?: Record<string, unknown>;
}

export interface AiAssistantToolInvocationDto {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly name: string;
  readonly description: string;
  readonly permissionId: string;
  readonly risk: "read" | "write" | "outbound" | "destructive";
  readonly status: AiAssistantToolInvocationStatus;
  readonly blockedReason: AiAssistantToolBlockedReason | null;
  readonly actionRequestId: string | null;
  readonly result: Record<string, unknown> | null;
}

export interface AiAssistantActionDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly toolModuleId: string;
  readonly toolModuleName: string;
  readonly toolName: string;
  readonly permissionId: string;
  readonly risk: AiAssistantActionRisk;
  readonly status: AiAssistantActionStatus;
  readonly inputSummary: Record<string, unknown>;
  readonly requestedAt: string;
  readonly resolvedAt: string | null;
  readonly updatedAt: string;
}

export interface ListAiProviderConfigsResponse {
  readonly providers: readonly AiProviderConfigDto[];
}

export interface CreateAiProviderConfigRequest {
  readonly providerKind: AiProviderKind;
  readonly displayName: string;
  readonly baseUrl?: string | null;
  readonly status?: Exclude<AiProviderStatus, "revoked">;
  readonly authMethod?: AiAuthMethod;
  readonly executionMode?: AiProviderExecutionMode;
  readonly credentialPayload?: Record<string, unknown>;
}

export interface CreateAiProviderConfigResponse {
  readonly provider: AiProviderConfigDto;
}

export interface UpdateAiProviderConfigRequest {
  readonly providerKind?: AiProviderKind;
  readonly displayName?: string;
  readonly baseUrl?: string | null;
  readonly status?: Exclude<AiProviderStatus, "revoked">;
  readonly authMethod?: AiAuthMethod;
  readonly executionMode?: AiProviderExecutionMode;
  readonly credentialPayload?: Record<string, unknown>;
}

export interface UpdateAiProviderConfigResponse {
  readonly provider: AiProviderConfigDto;
}

export interface RevokeAiProviderConfigResponse {
  readonly provider: AiProviderConfigDto;
}

export interface ListAiConfiguredModelsResponse {
  readonly models: readonly AiConfiguredModelDto[];
}

export interface CreateAiConfiguredModelRequest {
  readonly providerConfigId: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly capabilities: readonly AiModelCapability[];
  readonly status?: AiModelStatus;
  readonly tier?: AiModelTier;
  readonly allowUserOverride?: boolean;
}

export interface CreateAiConfiguredModelResponse {
  readonly model: AiConfiguredModelDto;
}

export interface UpdateAiConfiguredModelRequest {
  readonly providerModelId?: string;
  readonly displayName?: string;
  readonly capabilities?: readonly AiModelCapability[];
  readonly status?: AiModelStatus;
  readonly tier?: AiModelTier;
  readonly allowUserOverride?: boolean;
}

export interface UpdateAiConfiguredModelResponse {
  readonly model: AiConfiguredModelDto;
}

export interface LookupAiCapabilityRouteResponse {
  readonly route: AiCapabilityRouteDto;
}

/**
 * Response for POST /api/ai/transcriptions. Transcript text only — the raw audio that
 * produced it is never stored, logged, or echoed back (secrets/private-data-never-escape
 * invariant extends to transient uploads, not just credentials).
 */
export interface TranscribeAudioResponse {
  readonly text: string;
}

/**
 * #874 — the single instance-wide Voice (STT) endpoint, surfaced in its own admin section (NOT the
 * LLM Providers list). Backed by one `purpose='voice'` provider row + its model row. The API key is
 * WRITE-ONLY: never returned in any DTO (plaintext or ciphertext). `hasKey` reports only whether a
 * credential is stored. `enabled` maps to provider status ('active' → true).
 */
export interface AiVoiceEndpointDto {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly baseUrl: string | null;
  readonly modelName: string | null;
  readonly hasKey: boolean;
}

export interface GetVoiceEndpointResponse {
  readonly endpoint: AiVoiceEndpointDto;
}

/**
 * PUT /api/ai/voice-endpoint — admin-only upsert of the voice endpoint. `apiKey` is omit-means-keep
 * on edit: omitted/undefined leaves the stored key untouched; a non-empty string replaces it. An
 * initial create requires a key (enforced server-side). `enabled` toggles provider status.
 */
export interface PutVoiceEndpointRequest {
  readonly baseUrl: string;
  readonly modelName: string;
  readonly apiKey?: string;
  readonly enabled?: boolean;
}

export interface PutVoiceEndpointResponse {
  readonly endpoint: AiVoiceEndpointDto;
}

export interface ListAiServiceBindingsResponse {
  readonly bindings: AiServiceBindingMapDto;
}

export interface PutAiServiceBindingRequest {
  readonly binding: AiServiceBinding;
}

export interface PutAiServiceBindingResponse {
  readonly service: AiServiceKey;
  readonly binding: AiServiceBinding;
}

export interface TestAiProviderConfigResponse {
  readonly result: AiProviderTestResultDto;
}

/**
 * #1059 owner-gated CLI-provider terminal — frontend-only DTOs for
 * packages/ai/src/terminal-routes.ts. None of those three HTTP routes pass a Fastify
 * response `schema`, so these are plain TS shapes (no fast-json-stringify field-strip
 * risk); keep them in sync with the route bodies if a later task adds schemas.
 */
export interface GetTerminalStatusResponse {
  readonly passwordSet: boolean;
}

export interface SetTerminalPasswordRequest {
  readonly password: string;
}

export interface SetTerminalPasswordResponse {
  readonly ok: true;
}

export interface RequestTerminalTicketRequest {
  readonly password: string;
}

export interface RequestTerminalTicketResponse {
  readonly ticket: string;
}

export interface DiscoverAiProviderModelsResponse {
  readonly models: readonly AiProviderDiscoveredModelDto[];
}

export interface ChatModelOverrideSettingsDto {
  readonly overrideEnabled: boolean;
  readonly currentOverrideModelId: string | null;
  readonly effectiveOverrideModelId: string | null;
  readonly defaultModel: AiConfiguredModelDto | null;
  readonly selectedModel: AiConfiguredModelDto | null;
  readonly selectableOverrideModels: readonly AiConfiguredModelDto[];
}

export interface GetChatModelOverrideSettingsResponse {
  readonly settings: ChatModelOverrideSettingsDto;
}

export interface PutChatModelOverrideRequest {
  readonly modelId: string | null;
}

export interface PutChatModelOverrideSettingsResponse {
  readonly settings: ChatModelOverrideSettingsDto;
}

export interface PutAdminChatModelOverrideRequest {
  readonly enabled: boolean;
}

export interface AiAdminUserPinDto {
  readonly pinnedModelId: string | null;
  readonly pinnedModel: AiConfiguredModelDto | null;
  // #870 Slice 1 (D8): an admin may pin a whole PROVIDER for a user instead of a single model. A
  // provider pin hard-locks ALL of that user's traffic (chat + voice + workers) to that provider —
  // model pin and provider pin are mutually exclusive (the handler enforces at-most-one).
  readonly pinnedProviderId: string | null;
  readonly pinnedProvider: AiProviderConfigDto | null;
  readonly effectiveChatModel: AiConfiguredModelDto | null;
  readonly effectiveChatReason: AiCapabilityRouteReason;
  readonly availableModels: readonly AiConfiguredModelDto[];
  readonly availableProviders: readonly AiProviderConfigDto[];
}

export interface GetAiAdminUserPinResponse {
  readonly pin: AiAdminUserPinDto;
}

export interface PutAiAdminUserPinRequest {
  // At most one of modelId/providerId may be non-null (mutually exclusive pin kinds, M4a). Both
  // null clears the pin.
  readonly modelId?: string | null;
  readonly providerId?: string | null;
}

export interface ListAiAssistantToolsResponse {
  readonly tools: readonly AiAssistantToolDto[];
}

export interface InvokeAiAssistantToolResponse {
  readonly invocation: AiAssistantToolInvocationDto;
}

export interface ListAiAssistantActionsResponse {
  readonly actions: readonly AiAssistantActionDto[];
}

export interface ResolveAiAssistantActionRequest {
  readonly status: ResolveAiAssistantActionStatus;
}

export interface ResolveAiAssistantActionResponse {
  readonly action: AiAssistantActionDto;
}
