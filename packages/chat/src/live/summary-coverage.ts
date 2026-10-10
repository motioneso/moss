import { estimateTokens } from "./recall-seed.js";

/** Tokens reserved for the launch prompt wrapper around the seed, summary and replay. */
export const PROMPT_ALLOWANCE_TOKENS = 500;

/** Shown when a fresh launch cannot fit the retained context; the summary job is condensing it. */
export const CONVERSATION_TOO_LONG_TO_RESUME_MESSAGE =
  "This conversation is too long to resume right now. Moss is condensing it, and your history is kept. Try again in a minute, or start a new chat.";

/** Shown when a fresh launch cannot fit and no summary run could be queued. */
export const CONVERSATION_COULD_NOT_CONDENSE_MESSAGE =
  "This conversation is too long to resume right now, and Moss could not start condensing it. Your history is kept. Try again later, or start a new chat.";

/** Shown when a fresh launch cannot fit and no configured model can condense the conversation. */
export const CONVERSATION_NEEDS_SUMMARY_MODEL_MESSAGE =
  "This conversation is too long to restore in full, and no AI model that can summarize is set up. Add one in Settings, or start a new chat.";

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

/** Stored user and assistant turns, in history order, as coverage turns. */
export function storedCoverageTurns(
  messages: readonly { id: string; role: string; status: string; body: string }[]
): CoverageTurn[] {
  return messages
    .filter((m) => m.status === "stored" && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ id: m.id, role: m.role as "user" | "assistant", content: m.body }));
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
 * tokens than the raw allowance. The newest turns stay raw, bounded by `keep`
 * and the raw allowance: half the replay budget, and never more than a launch
 * with a full seed and summary can still fit. One run reads at most
 * `maxInputTokens` of raw turns (always at least one) and leaves the rest for
 * a later run.
 */
export function planSummaryCoverage<T extends CoverageTurn>(
  uncovered: readonly T[],
  opts: { readonly keep: number; readonly replayTokens: number; readonly maxInputTokens: number }
): SummaryCoveragePlan<T> | null {
  const rawAllowance = Math.max(
    0,
    Math.min(Math.floor(opts.replayTokens / 2), opts.replayTokens - PROMPT_ALLOWANCE_TOKENS)
  );
  const total = uncovered.reduce((sum, turn) => sum + coverageTurnTokens(turn), 0);
  if (uncovered.length <= Math.max(2 * opts.keep, 4) && total <= rawAllowance) return null;

  let kept = 0;
  let keptTokens = 0;
  for (let i = uncovered.length - 1; i >= 0 && kept < opts.keep; i -= 1) {
    const tokens = coverageTurnTokens(uncovered[i]!);
    if (keptTokens + tokens > rawAllowance) break;
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

/** Refusal messages that reach the owner as-is instead of the generic unavailable message. */
export const CONVERSATION_RESUME_MESSAGES: ReadonlySet<string> = new Set([
  CONVERSATION_TOO_LONG_TO_RESUME_MESSAGE,
  CONVERSATION_COULD_NOT_CONDENSE_MESSAGE,
  CONVERSATION_NEEDS_SUMMARY_MODEL_MESSAGE
]);
