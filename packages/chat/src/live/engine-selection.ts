/**
 * THE single place that decides which chat engine backs a live session (#1350).
 *
 * There are two composition roots that build an engine — the in-process factory in
 * `runtime.ts` (host installs, tests) and `EngineHost.launchOnce` in the cli-runner
 * (every containerized deploy, because the API takes the RPC fork whenever
 * `JARVIS_CLI_RUNNER_SOCKET` is set). Until #1350 they each carried their own copy of
 * the selection rule and they had DRIFTED: the in-process root honoured
 * `execution_mode`, the cli-runner root always built the interactive tmux engine.
 *
 * The consequence was a full prod chat outage — every provider row read
 * `non_interactive` (migrations 0172/0173, #1239) while the only topology that ships
 * kept launching a tmux REPL, and every launch failed. Keeping the rule in ONE exported
 * function is the structural fix: a future engine or mode can only be added here, so the
 * two roots cannot disagree again.
 */

import type { Multiplexer, ProviderKind, TmuxIo } from "@moss/ai";
import type { AiProviderExecutionMode } from "@moss/shared";

import { ClaudePrintChatEngine } from "./claude-print-chat-engine.js";
import { CliChatEngineImpl } from "./cli-chat-engine.js";
import type { CliChatEngineDiagnostic } from "./cli-chat-engine-opts.js";
import { GeminiPrintChatEngine } from "./gemini-print-chat-engine.js";
import { ClaudePersistentRuntimeEngine } from "./persistent-runtime-engine.js";
import type { AdmitCapablePool } from "./persistent-runtime-pool.js";
import type { CliChatEngine, EngineLaunchOpts } from "./types.js";

/**
 * #1554 task #5 — `PersistentRuntimePool.admit()` needs an `EngineLaunchOpts`, but admission
 * (cap-check / LRU-evict / construct) happens BEFORE the real per-turn launch opts exist (those
 * are assembled later by `ChatSessionManager.launchSession` and passed to `engine.launch()`).
 * `PersistentRuntimePool.construct()` only forwards `opts` to `createRuntime`, and
 * `ClaudePersistentRuntime`'s constructor (the pool's `createRuntime` implementation) reads none
 * of `EngineLaunchOpts`'s fields — so an empty stand-in is safe here, mirroring the same
 * `NOOP_OPTS` precedent already used in `persistent-runtime-pool.test.ts`.
 */
const ADMIT_PROBE_OPTS = {} as EngineLaunchOpts;

export interface ChatEngineSelectionOpts {
  /** Multiplexer backend for the interactive engine; ignored by the one-shot engines. */
  readonly mux?: Multiplexer;
  /** Base dir whose `.claude`/`.codex`/`.gemini` hold CLI transcripts. */
  readonly homeBase?: string;
  /** The provider's configured mode. `non_interactive` selects a one-shot engine. */
  readonly executionMode?: AiProviderExecutionMode;
  /** 0600 file holding the captured OAuth token (claude-scoped, #363). */
  readonly credentialFile?: string;
  /** #342: true when the cli-runner owns the server-side replay submit+drain. */
  readonly ownsDrain?: boolean;
  /** #1157 diagnostic sink; must never throw into the submit path. */
  readonly onDiagnostic?: (event: CliChatEngineDiagnostic) => void;
  /**
   * #1557 Phase 1 rollout flag (`chat.persistent_runtime.enabled`). When true AND the provider
   * is anthropic (the only adapter Phase 1 ships), selects the persistent provider-runtime
   * engine ahead of the bounded-fallback/tmux fork below — a third engine shape, not a
   * replacement for either. The cli-runner RPC root (`engine-host.ts`) pins this to `false` for
   * the whole of Phase 1 (the #1350 two-composition-roots guard: the pool must exist before the
   * RPC root can safely select persistent children).
   */
  readonly persistentRuntimeEnabled?: boolean;
  /**
   * #1554 task #5 — the warm-pool admission seam. When `persistentRuntimeEnabled` selects the
   * persistent adapter AND a pool is supplied, admission is consulted (`pool.admit`) instead of
   * unconditionally constructing a fresh `ClaudePersistentRuntime`: `{kind:"admitted"}` hands the
   * already-constructed runtime to a new `ClaudePersistentRuntimeEngine`; `{kind:"denied"}` (at
   * cap, no idle victim to evict) falls back to the SAME bounded-fallback/tmux fork used when the
   * flag is off (ruling 5). Absent ⇒ unchanged pre-task-5 behavior: an unconditional, ungated
   * construct (only real for tests / callers that don't yet wire a pool).
   */
  readonly persistentPool?: AdmitCapablePool;
}

/**
 * True when this provider/mode pair runs bounded-fallback (`claude -p` / `gemini -p`, one
 * process per turn) rather than driving a persistent REPL inside a multiplexer pane.
 * Exported so callers that need to know whether a mux session will exist (the runner's
 * orphan reaping, tests) can ask without reconstructing the rule.
 *
 * Named for the *shape* of the engine (one-shot process per turn), not the persistent
 * provider-runtime adapter (#1557) — that adapter is a third shape, selected in front of
 * this check, not a replacement for it.
 */
export function isBoundedFallbackEngine(
  provider: ProviderKind,
  executionMode: AiProviderExecutionMode | undefined
): boolean {
  // Gemini's interactive UI does not emit the stream-json transcript that its reader needs.
  // Use the one-shot engine for every Gemini mode so replies always come from that stream.
  return provider === "google" || (provider === "anthropic" && executionMode === "non_interactive");
}

/**
 * The bounded-fallback/tmux fork, unchanged from before task #5 — extracted so both the
 * unconditional persistent-adapter path and the pool-denied path can reach it without
 * duplicating the fork logic.
 */
function buildFallbackEngine(
  provider: ProviderKind,
  sessionKey: string,
  io: TmuxIo,
  opts: ChatEngineSelectionOpts
): CliChatEngine {
  if (isBoundedFallbackEngine(provider, opts.executionMode)) {
    if (provider === "anthropic") {
      return new ClaudePrintChatEngine(sessionKey, io, {
        mux: opts.mux,
        homeBase: opts.homeBase,
        credentialFile: opts.credentialFile
      });
    }
    return new GeminiPrintChatEngine(sessionKey, io, {
      mux: opts.mux,
      homeBase: opts.homeBase
    });
  }

  return new CliChatEngineImpl(provider, sessionKey, io, {
    mux: opts.mux,
    homeBase: opts.homeBase,
    credentialFile: opts.credentialFile,
    ownsDrain: opts.ownsDrain,
    executionMode: opts.executionMode,
    onDiagnostic: opts.onDiagnostic
  });
}

/**
 * #1554 task #5 — the pool-consulting branch of the persistent-adapter fork. Admission is
 * fail-closed (ruling 5): a `"denied"` result falls all the way back to the bounded-fallback/tmux
 * fork, the SAME engine the flag-off path would have built.
 */
async function admitPersistentOrFallback(
  pool: AdmitCapablePool,
  provider: ProviderKind,
  sessionKey: string,
  io: TmuxIo,
  opts: ChatEngineSelectionOpts
): Promise<CliChatEngine> {
  const result = await pool.admit(sessionKey, ADMIT_PROBE_OPTS);
  if (result.kind === "admitted") {
    return new ClaudePersistentRuntimeEngine(sessionKey, io, {
      provider,
      credentialFile: opts.credentialFile,
      runtime: result.runtime
    });
  }
  return buildFallbackEngine(provider, sessionKey, io, opts);
}

/**
 * Build the engine for a session. `non_interactive` Anthropic and every Gemini session get the
 * bounded-fallback print engines (no multiplexer session is ever created); everything else —
 * including any provider explicitly configured `interactive` — gets the tmux-backed REPL engine.
 *
 * Synchronous for every call site that predates task #5 (no `persistentPool` supplied) — only
 * becomes a `Promise` when a real pool is wired in, i.e. only for the two composition roots task
 * #5 connects (`engine-host.ts`, `runtime.ts`'s `createRealEngineFactory`).
 */
export function createChatEngine(
  provider: ProviderKind,
  sessionKey: string,
  io: TmuxIo,
  opts: ChatEngineSelectionOpts = {}
): CliChatEngine | Promise<CliChatEngine> {
  // #1557 Phase 1 / #1558: the persistent adapter is a third engine shape, checked ahead of the
  // bounded-fallback/tmux fork below (ruling 2 — flag on + provider match wins, EXCEPT a caller
  // that explicitly asked for `executionMode: "non_interactive"` always keeps the bounded print
  // engine, because that engine is the only one that implements the structured one-shot methods
  // (`launchStructured`/`submitStructured`/`readStructured`) that scoped structured calls need.
  // Without this carve-out, turning the flag on breaks every structured caller (e.g. email
  // extraction) the moment any ordinary chat session enables persistent mode, since the flag is a
  // single process-wide toggle, not scoped to one call. Claude and Codex both build the
  // unconditional-construct path otherwise; the shared warm pool (`persistentPool`) stays
  // Claude-only — its `createRuntime` is wired Claude-only at the composition roots, out of scope
  // for #1558 (see plan seams note).
  if (
    opts.persistentRuntimeEnabled &&
    (provider === "anthropic" || provider === "openai-compatible") &&
    !isBoundedFallbackEngine(provider, opts.executionMode)
  ) {
    if (opts.persistentPool && provider === "anthropic") {
      return admitPersistentOrFallback(opts.persistentPool, provider, sessionKey, io, opts);
    }
    return new ClaudePersistentRuntimeEngine(sessionKey, io, {
      provider,
      credentialFile: opts.credentialFile
    });
  }

  return buildFallbackEngine(provider, sessionKey, io, opts);
}
