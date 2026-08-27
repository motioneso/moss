export { chatCommitmentProvider } from "./commitment-provider.js";
// #1789: read by @moss/module-registry so the queued module path parses a stored locale exactly
// the way the chat/gateway path does. Two copies of this would drift, and the symptom of drift is
// a meal filed under the wrong calendar day with no error anywhere.
export { extractTimezone } from "./locale-utils.js";
export * from "./calendar-write-impl.js";
export * from "./email-write-impl.js";
export * from "./module-build-start-impl.js";
export * from "./jobs.js";
export * from "./live-routes.js";
export { DataContextChatPersistence } from "./live/persistence.js";
export type { DataContextChatPersistenceDeps } from "./live/persistence.js";
export { combineHiddenContextBlocks } from "./live/chat-session-manager.js";
export { ChatAttachmentsService } from "./attachments-service.js";
export * from "./live/recall-seed.js";
export * from "./live/passive-retrieval.js";
export * from "./live/prompt-safety.js";
export { projectPageContextSnapshot } from "./live/page-context.js";
export { createCurrentViewReadService, type CurrentViewReadService } from "./live/current-view.js";
export { chatGetCurrentViewExecute, chatGetCurrentViewOutputSchema } from "./current-view-tool.js";
export {
  planCrossToolReasoning,
  renderCrossToolContextBlock,
  collectCrossToolContext,
  collectCrossToolContextAndItems,
  normalizeNotesResult,
  normalizeEmailResult,
  normalizeCalendarResult,
  normalizeTasksResult,
  type CrossToolSource,
  type CrossToolReasoningPlan,
  type CrossToolEvidenceItem,
  type CrossToolReadRunner
} from "./live/cross-tool-reasoning.js";
export * from "./live/runtime.js";
export * from "./live/chat-surface.js";
export * from "./live/cli-structured-adapter.js";
// #342 Phase 2: the api-side install state machine (§A.4) — driver, reconcile projection,
// store port + wire types. Consumed by the composition root to wire the onboarding install seam.
export {
  INSTALL_START_STATES,
  INSTALL_TRANSITIONS,
  reconcileInstalling,
  reconcileInstallingRow,
  runInstallProvider,
  type InstallProviderKey,
  type InstallProviderRpc,
  type InstallTransition,
  type InstallTransitionKind,
  type PersistedProviderInstall,
  type ProviderInstallStateStore,
  type ProviderInstallWrite,
  type TerminalInstallState
} from "./live/provider-install-state.js";
// #342 Phase 3: the api-side login lifecycle (§L.4) — login-reconcile projection, the composed
// full-lifecycle reconcile, and the settled-status→state mapper. Consumed by the composition root.
export {
  loginFlowStatusToState,
  reconcileLogin,
  reconcileProviderLifecycle,
  reconcileProviderLifecycleRow,
  type LoginFlowResult,
  type LoginProviderRpc
} from "./live/provider-install-state.js";
export type {
  ProviderCatalog,
  CatalogEntry,
  InstallRecipe,
  RpcInstallProviderParams,
  RpcInstallProviderResult
} from "./live/install-contract.js";
// #342 Phase 3: login wire types (§L.2) shared by the composition root + the RPC client.
export type {
  LoginFlowStatus,
  LoginSurface,
  RpcBeginLoginParams,
  RpcBeginLoginResult,
  RpcCancelLoginParams,
  RpcCancelLoginResult,
  RpcPollLoginParams,
  RpcPollLoginResult,
  RpcSubmitLoginTokenParams,
  RpcSubmitLoginTokenResult
} from "./live/login-contract.js";
export * from "./manifest.js";
export * from "./feedback-verifier.js";
export * from "./memory-distillation.js";
export * from "./memory-settings-repository.js";
export * from "./recall-port.js";
export * from "./repository.js";
export * from "./routes.js";
export * from "./skills/repository.js";
