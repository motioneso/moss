import { estimateTokens } from "./recall-seed.js";

/** Default replay window size in messages (unset/invalid env falls back here). */
export const DEFAULT_REPLAY_MESSAGES = 40;

/** Token budget for the replayed message window (excludes the summary). */
export const REPLAY_TOKEN_CAP = 8000;

/** Token budget for the stored rolling summary once capped for injection. */
export const SUMMARY_TOKEN_CAP = 1000;

export interface ReplayMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

function messageTokens(message: ReplayMessage): number {
  return estimateTokens(`${message.role}: ${message.content}`);
}

/**
 * Select the replay window from a chronological (oldest-first) turn history:
 * take the newest `maxMessages` by count, then drop whole oldest messages
 * until the total is within `maxTokens`. If a single newest message alone
 * still exceeds the cap, head-truncate it (keep the tail) rather than drop it.
 */
export function selectReplayWindow(
  messages: readonly ReplayMessage[],
  opts: { readonly maxMessages: number; readonly maxTokens: number }
): ReplayMessage[] {
  let windowed = messages.slice(Math.max(0, messages.length - opts.maxMessages));
  let total = windowed.reduce((sum, m) => sum + messageTokens(m), 0);

  while (windowed.length > 1 && total > opts.maxTokens) {
    total -= messageTokens(windowed[0]);
    windowed = windowed.slice(1);
  }

  if (windowed.length === 1 && messageTokens(windowed[0]) > opts.maxTokens) {
    const [message] = windowed;
    const prefixLen = message.role.length + 2; // "role: "
    const maxContentLen = Math.max(0, opts.maxTokens * 4 - prefixLen);
    windowed = [{ role: message.role, content: message.content.slice(-maxContentLen) }];
  }

  return [...windowed];
}

/** Cap a stored summary to `maxTokens`, tail-truncating (keeping the head). */
export function capSummary(summary: string, maxTokens: number): string {
  if (estimateTokens(summary) <= maxTokens) return summary;
  return summary.slice(0, maxTokens * 4);
}
