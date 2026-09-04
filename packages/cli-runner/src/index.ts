/**
 * @moss/cli-runner — the in-container CLI chat sidecar (#342). Hosts the provider
 * CLIs + multiplexer behind a private Unix-domain socket and drives them via the
 * frozen RPC contract (docs/superpowers/specs/2026-06-20-cli-runner-rpc-contract.md).
 */

export { CliRunnerServer, type CliRunnerServerDeps } from "./server.js";
export { CliChatEngineHost, type EngineHostDeps } from "./engine-host.js";
export { serveConnection, type ByteChannel, type ConnectionDeps } from "./connection.js";
export {
  stepHelloServer,
  isHandshakeFrame,
  type HelloServerState,
  type HelloStep
} from "./hello.js";
export { buildSanitizedCliEnv } from "./sanitized-env.js";
export { createSanitizedTmuxIo } from "./runner-io.js";
export {
  buildCliRunnerChildEnv,
  sourceSelfUpdateDisableEnv,
  main,
  type CliRunnerConfig
} from "./main.js";
export {
  InstallService,
  InstallBadRequestError,
  buildSanitizedInstallerEnv,
  type InstallServiceDeps
} from "./install-service.js";
export { PROVIDER_CATALOG, CATALOG_VALIDATION_ISSUES } from "./catalog.js";
// #342 Phase 3 login (§L): the login service + the validated login-adapter allowlist + loader.
export {
  LoginService,
  LoginBadRequestError,
  type LoginServiceDeps,
  type LoginFlowOutcome
} from "./login-service.js";
export { LOGIN_ADAPTERS, loadLoginAdapters, type LoginAdapterIssue } from "./login-adapters.js";
// #2208: live model listing for CLI providers (ids only; credentials never leave the runner).
export {
  MODEL_LIST_ADAPTERS,
  listProviderModels,
  type ModelListAdapter,
  type ModelListAdapterDeps
} from "./model-list-adapters.js";
// #1121: seed-only opt-in real-chat path persists a captured token from the host side.
export {
  persistProviderToken,
  readProviderToken,
  providerTokenPath,
  isTokenProvider
} from "./provider-token-store.js";
