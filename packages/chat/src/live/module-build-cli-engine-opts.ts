/**
 * Construction options + submit contract types for CliChatEngineImpl, split out of
 * module-build-cli-engine.ts (#1157) to keep that file under the repo's 1000-line cap. All names
 * are re-exported from module-build-cli-engine.ts so existing import paths keep working.
 */

import type { Multiplexer } from "@moss/ai";
import type { AiProviderExecutionMode } from "@moss/shared";

/**
 * #1157: out-of-band observability signal from the engine. `composer_discarded` fires when a
 * verified submit finds NON-empty composer content just before it clears the pane — meaning a
 * previous turn's text sat pasted-but-unsubmitted and is about to be silently thrown away
 * (exactly the failure Ben hit: "try again" stuck in the prod composer for ~10 minutes).
 * Privacy: carries a char count ONLY, never the discarded text — private-session content must
 * not leak into host logs.
 */
export type CliChatEngineDiagnostic = {
  readonly kind: "composer_discarded";
  readonly paneChars: number;
};

export interface CliChatEngineOpts {
  /** Multiplexer backend; defaults to a TmuxMultiplexer over the same io (preserves legacy behavior). */
  readonly mux?: Multiplexer;
  /** Base dir whose `.claude`/`.codex`/`.gemini` hold CLI transcripts. */
  readonly homeBase?: string;
  /**
   * (#363, claude-scoped) Path to the 0600 file holding the provider's captured OAuth token.
   * When set AND present, `buildClaudeCommand` prefixes the launch with
   * `CLAUDE_CODE_OAUTH_TOKEN="$(cat <file>)"` so claude is authenticated — the secret is read at
   * runtime, NEVER in the tmux argv / pane-typed string. Ignored by codex/gemini launches.
   */
  readonly credentialFile?: string;
  /** #342: true when cli-runner owns server-side replay submit+drain. */
  readonly ownsDrain?: boolean;
  /** #342: max wall-clock ms for server-side replay-drain. */
  readonly drainMs?: number;
  /** #342: poll interval (ms) used while draining the replay. Default 250ms. */
  readonly drainPollMs?: number;
  /** Max observation window for each ECHO attempt. Time can only fail; pane evidence succeeds. */
  readonly echoMs?: number;
  /** Failure-only bound for replay's verified submit. */
  readonly verifiedSubmitMs?: number;
  /**
   * #1162/#1171: how long to wait for the post-Enter transcript ACK before probing for a
   * swallowed Enter (composer still holds the text ⇒ press Enter again, max 2 nudges).
   * Default 7000ms; tests shrink it to keep the bounded ack wait off the wall clock.
   */
  readonly nudgeAfterMs?: number;
  /** #1226 relay-5/6: per-call bound on each individual mux RPC (capturePane/paste/pressEnter/
   * clearComposer/clearComposerHard/kill). Without this a single stalled call hangs
   * verifiedSubmit forever, upstream of every other bound in the file. Default 10000ms. */
  readonly muxCallMs?: number;
  readonly executionMode?: AiProviderExecutionMode;
  /** #1157: best-effort diagnostic sink (see CliChatEngineDiagnostic). Must never throw into the submit path. */
  readonly onDiagnostic?: (event: CliChatEngineDiagnostic) => void;
}

export interface VerifiedSubmitOpts {
  readonly attemptId: string;
  readonly text: string;
  readonly signal: AbortSignal;
}

export class VerifiedSubmitError extends Error {
  constructor(
    readonly code: "unavailable" | "delivery_unknown",
    readonly engineInvalidated = false
  ) {
    super(
      code === "delivery_unknown" ? "chat input delivery is unknown" : "chat input unavailable"
    );
    this.name = "VerifiedSubmitError";
  }
}
