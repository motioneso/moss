/**
 * Public "./live" subpath (#802) — the slice of chat's CLI-engine protocol that
 * `@moss/cli-runner` depends on: engine hosting (`cli-chat-engine`), RPC wire
 * framing (`rpc-contract`), provider install flow (`install-contract`), provider
 * login flow (`login-contract`), and the shared unavailable-engine error
 * (`errors`).
 *
 * These five modules were already de-facto public API — cli-runner reached into
 * them directly via `../../chat/src/live/*` relative imports before this
 * boundary was made honest. This barrel changes no behavior; it just gives that
 * existing surface a declared, package-boundary-respecting entry point.
 *
 * #744 adds `private-transcript-cleanup`: the cli-runner's engine-host needs
 * `purgePrivateTranscripts` for crash recovery when no engine object survives.
 * Collision-safe — that module's local `sanitizeSessionKey`/`deriveNeutralDir`
 * are NOT exported, so they don't clash with cli-chat-engine's public ones.
 *
 * #1059 adds `terminal-rpc-client`: the owner-terminal WebSocket relay (composed in
 * packages/module-registry, which already declares BOTH @moss/ai and @moss/chat as
 * dependencies) needs `TerminalRpcClient` to open/bridge a PTY over the cli-runner's
 * terminal-host socket. It was previously reachable only via the pre-v8-style deep
 * subpath `@moss/chat/live/terminal-rpc-client`, which is NOT in this package's
 * `exports` map and fails at runtime with ERR_PACKAGE_PATH_NOT_EXPORTED — re-exporting it
 * here makes it resolvable through the one declared "./live" subpath instead.
 */
export * from "./cli-chat-engine.js";
// #1258 — the dev-instance CLI's `cli-runner-reachable` doctor check needs the bare
// connect-plus-hello primitive (no RPC verb) to probe cli-runner without a chat session.
export { RpcConnection } from "./chat-engine-rpc-client.js";
// #1350 — the ONE engine-selection rule. The cli-runner's EngineHost must build its engine
// through this, not by hand, or `execution_mode` silently means nothing on a containerized deploy.
export * from "./engine-selection.js";
export { buildLaunchCommand, type LaunchCommandContext } from "./cli-launch-commands.js";
export {
  writeClaudePermissionHook,
  type ClaudePermissionHookOpts
} from "./claude-permission-hook.js";
export type { EngineLaunchOpts } from "./types.js";
// The engine interface itself, so hosts can hold any engine (one-shot or interactive) rather
// than narrowing to the tmux implementation and quietly assuming a pane exists.
export type { CliChatEngine } from "./types.js";
export * from "./rpc-contract.js";
export * from "./login-contract.js";
export * from "./install-contract.js";
export * from "./errors.js";
export {
  parseGeminiSourceCredential,
  readGeminiNativeCredential,
  GEMINI_SOURCE_RESTRICTIONS
} from "./gemini-source-policy.js";
export * from "./private-transcript-cleanup.js";
export * from "./terminal-rpc-client.js";
// #1554 Decision 3 — the composition-root-owned idle-reap timer that drives
// `PersistentRuntimePool.sweepIdle`. cli-runner's `engine-host.ts` needs it.
export * from "./idle-reap-timer.js";
// #1554 task #5 — the RPC topology's composition root (`main.ts`) constructs the real pool, so
// cli-runner needs the class + its structural interfaces (`AdmitCapablePool`, `AdmitResult`).
export * from "./persistent-runtime-pool.js";
// #1554 task #5 — `main.ts` constructs the pool's `createRuntime` callback itself (the same
// per-call-fresh-io pattern `createRealEngineFactory` in `runtime.ts` uses), so cli-runner needs
// the concrete runtime class, not just the pool that wraps it.
export * from "./claude-persistent-runtime.js";

export { CliSourceEngine, type SourceCredentialRefresh } from "./cli-source-engine.js";
