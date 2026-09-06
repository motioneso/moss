export {
  resolvePolicy,
  type AgencyPrefLookup,
  type ActionPolicyLookup,
  type PolicyDecision
} from "./policy.js";
export {
  SessionTokenRegistry,
  InvalidSessionTokenError,
  type SessionIdentity
} from "./session-tokens.js";
export {
  ConfirmationRegistry,
  type ResolutionStatus,
  type AwaitOutcome
} from "./confirmation-registry.js";
export { validateToolInput, ToolInputValidationError, compilePattern } from "./input-validation.js";
export {
  sanitizeAssistantToolResult,
  boundedAssistantToolResultData,
  capRenderedToolResult,
  liveStreamResult,
  renderAndCap
} from "./output-validation.js";
export type {
  ActiveModulesResolver,
  SessionNotifier,
  GatewaySessionRecord,
  GatewayToolResponse
} from "./types.js";
export {
  AssistantToolGateway,
  type AssistantToolGatewayDependencies,
  type NativeToolPermissionRequest,
  type NativeToolPermissionResponse
} from "./gateway.js";
export { createUnwiredActionResolver } from "./unwired-action-resolver.js";
export {
  AutoRunRateLimiter,
  GATEWAY_AUTO_RUN_RATE_LIMIT_DEFAULTS,
  type AutoRunRateLimiterOptions
} from "./auto-run-rate-limit.js";
export {
  assertBuiltInSelfOperationManifests,
  BUILT_IN_SELF_OPERATION_SCOPE_NOTE,
  grantSelfOperationForModule,
  isSelfOperationExcluded,
  selfHealGrantedAtInstallTier,
  SELF_OPERATION_EXCLUSIONS,
  type SelfOperationExclusionCategory,
  type SelfOperationManifestInput
} from "./self-operation.js";
