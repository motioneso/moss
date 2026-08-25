export * from "./assistant-tools.js";
export * from "./error-tools.js";
export {
  AI_PURGE_AUDIT_LOG_QUEUE,
  AI_QUEUE_DEFINITIONS,
  registerAiMaintenanceWorkers
} from "./jobs.js";
export * from "./auto-register.js";
export * from "./chat-model-override.js";
export * from "./chat-adapter.js";
export * from "./cli-availability.js";
export * from "./crypto.js";
export * from "./credentials.js";
export * from "./manifest.js";
export * from "./model-discovery.js";
export * from "./provider-validation-routes.js";
export * from "./provider-validation.js";
export * from "./repository.js";
export * from "./terminal-password-repository.js";
// #1059 — re-exported so the composition root (packages/module-registry) and its tests can name
// TerminalRpcHandle/TerminalRpcConnectOptions/TerminalRoutesDependencies without an internal-file
// import; registerTerminalRoutes itself is still only reached via routes.ts's registerAiRoutes.
export * from "./terminal-routes.js";
export * from "./routes.js";
export * from "./structured/schema-bounds.js";
export * from "./structured/generate-structured.js";
export * from "./adapters/http-api.js";
export * from "./adapters/http-api-structured.js";
export * from "./adapters/tmux-bridge.js";
export * from "./adapters/multiplexer.js";
export * from "./adapters/tmux-multiplexer.js";
export * from "./adapters/herdr-multiplexer.js";
export * from "./adapters/binary-probe.js";
export * from "./adapters/multiplexer-resolve.js";
export * from "./adapters/root-workspace.js";
export { redactSecrets, redactExact } from "./adapters/redact.js";
export * from "./gateway/index.js";
export * from "./module-build/run-build-step.js";
export * from "./module-build/start-build.js";
export * from "./module-build/write-plan.js";
export {
  captureAckCursor,
  hasExactUserAck,
  parseTranscript,
  type AckCursor,
  type AckProviderKind,
  type ProviderKind,
  type TranscriptParseResult
} from "./adapters/transcript-reader.js";
