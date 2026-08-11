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

import { AgyPrintChatEngine } from "./agy-print-chat-engine.js";
import { ClaudePrintChatEngine } from "./claude-print-chat-engine.js";
import { CliChatEngineImpl } from "./cli-chat-engine.js";
import type { CliChatEngineDiagnostic } from "./cli-chat-engine-opts.js";
import type { CliChatEngine } from "./types.js";

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
}

/**
 * True when this provider/mode pair runs bounded-fallback (`claude -p` / `agy` exec, one
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
  if (executionMode !== "non_interactive") return false;
  return provider === "anthropic" || provider === "google";
}

/**
 * Build the engine for a session. `non_interactive` anthropic/google get the bounded-fallback
 * print engines (no multiplexer session is ever created); everything else — including any
 * provider explicitly configured `interactive` — gets the tmux-backed REPL engine.
 */
export function createChatEngine(
  provider: ProviderKind,
  sessionKey: string,
  io: TmuxIo,
  opts: ChatEngineSelectionOpts = {}
): CliChatEngine {
  if (isBoundedFallbackEngine(provider, opts.executionMode)) {
    if (provider === "anthropic") {
      return new ClaudePrintChatEngine(sessionKey, io, {
        mux: opts.mux,
        homeBase: opts.homeBase,
        credentialFile: opts.credentialFile
      });
    }
    return new AgyPrintChatEngine(sessionKey, io, {
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
