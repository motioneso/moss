import { estimateTokens } from "./recall-seed.js";

/** Tokens reserved for the launch prompt wrapper around the seed, summary and replay. */
export const PROMPT_ALLOWANCE_TOKENS = 500;

/** Upper bound on raw turn tokens one summarization run reads. */
export const SUMMARY_RUN_INPUT_TOKENS = 12_000;

export interface CoverageTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface StoredSummaryState {
  readonly summary: string | null;
  readonly coveredThroughMessageId: string | null;
  readonly revision: number;
}

export interface SummarySplit<T extends CoverageTurn> {
  /** The accepted summary, or null when none applies to this history. */
  readonly summary: string | null;
  /** Every stored turn after the accepted frontier, oldest first. */
  readonly uncovered: T[];
}

export interface SummaryCoveragePlan<T extends CoverageTurn> {
  readonly cover: T[];
  readonly throughMessageId: string;
}

export function coverageTurnTokens(turn: Pick<CoverageTurn, "role" | "content">): number {
  return estimateTokens(`${turn.role}: ${turn.content}`);
}

/**
 * Split a chronological history at the accepted summary frontier.
 *
 * A summary counts only when it has a revision, a frontier, and that frontier
 * is still present. Anything else replays the whole history with no summary,
 * so a stale or legacy summary can never hide a turn.
 */
export function splitAtSummaryFrontier<T extends CoverageTurn>(
  turns: readonly T[],
  state: StoredSummaryState
): SummarySplit<T> {
  const summary = state.summary?.trim() ?? "";
  if (state.revision < 1 || !state.coveredThroughMessageId || summary.length === 0) {
    return { summary: null, uncovered: [...turns] };
  }
  const index = turns.findIndex((turn) => turn.id === state.coveredThroughMessageId);
  if (index < 0) return { summary: null, uncovered: [...turns] };
  return { summary, uncovered: turns.slice(index + 1) };
}

/**
 * Decide which uncovered turns the next summarization run should fold in.
 *
 * Runs when the uncovered suffix holds more than twice `keep` turns or more
 * than half the replay budget. The newest turns stay raw, bounded by both
 * `keep` and half the replay budget. One run reads at most `maxInputTokens`
 * of raw turns (always at least one) and leaves the rest for a later run.
 */
export function planSummaryCoverage<T extends CoverageTurn>(
  uncovered: readonly T[],
  opts: { readonly keep: number; readonly replayTokens: number; readonly maxInputTokens: number }
): SummaryCoveragePlan<T> | null {
  const halfReplay = Math.floor(opts.replayTokens / 2);
  const total = uncovered.reduce((sum, turn) => sum + coverageTurnTokens(turn), 0);
  if (uncovered.length <= Math.max(2 * opts.keep, 4) && total <= halfReplay) return null;

  let kept = 0;
  let keptTokens = 0;
  for (let i = uncovered.length - 1; i >= 0 && kept < opts.keep; i -= 1) {
    const tokens = coverageTurnTokens(uncovered[i]!);
    if (keptTokens + tokens > halfReplay) break;
    kept += 1;
    keptTokens += tokens;
  }

  const candidates = uncovered.slice(0, uncovered.length - kept);
  const cover: T[] = [];
  let inputTokens = 0;
  for (const turn of candidates) {
    const tokens = coverageTurnTokens(turn);
    if (cover.length > 0 && inputTokens + tokens > opts.maxInputTokens) break;
    cover.push(turn);
    inputTokens += tokens;
  }

  const last = cover.at(-1);
  return last ? { cover, throughMessageId: last.id } : null;
}

/** True when the retained launch context plus the prompt allowance fits the budget. */
export function launchContextFits(
  parts: {
    readonly seedTokens: number;
    readonly summaryTokens: number;
    readonly replayTokens: number;
  },
  budgetTokens: number
): boolean {
  return (
    parts.seedTokens + parts.summaryTokens + parts.replayTokens + PROMPT_ALLOWANCE_TOKENS <=
    budgetTokens
  );
}
