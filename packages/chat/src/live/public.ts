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
// #1350 — the ONE engine-selection rule. The cli-runner's EngineHost must build its engine
// through this, not by hand, or `execution_mode` silently means nothing on a containerized deploy.
export * from "./engine-selection.js";
// The engine interface itself, so hosts can hold any engine (one-shot or interactive) rather
// than narrowing to the tmux implementation and quietly assuming a pane exists.
export type { CliChatEngine } from "./types.js";
export * from "./rpc-contract.js";
export * from "./login-contract.js";
export * from "./install-contract.js";
export * from "./errors.js";
export * from "./private-transcript-cleanup.js";
export * from "./terminal-rpc-client.js";
// #1554 Decision 3 — the composition-root-owned idle-reap timer that drives
// `PersistentRuntimePool.sweepIdle`. cli-runner's `engine-host.ts` needs it; `persistent-runtime-pool.js`
// itself is intentionally NOT exported here (no cli-runner caller constructs a pool yet — task #5).
export * from "./idle-reap-timer.js";
