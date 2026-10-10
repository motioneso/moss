import { resolveMossEnv } from "@moss/db";
import type { ChatTurnUsageDto } from "@moss/shared";

import { estimateTokens } from "./recall-seed.js";
import type { TranscriptRecord } from "./types.js";

/**
 * App-counted tokens one provider session may hold before the next turn hands off to a fresh
 * session. It sits well under the smallest supported economy model window (128k) because the
 * vendor system prompt and tool definitions occupy context the app cannot see.
 */
export const DEFAULT_SESSION_BUDGET_TOKENS = 64_000;

export function getSessionBudgetTokens(): number {
  const raw = resolveMossEnv(process.env, "JARVIS_CHAT_SESSION_BUDGET_TOKENS");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_BUDGET_TOKENS;
}

/**
 * Conservative running count of what one provider session was fed and produced. Every input
 * and every output record counts by estimate. Provider usage is optional and is not context
 * occupancy, so reported output can only raise a turn's count.
 */
export interface SessionUsageMeter {
  tokens: number;
  turnsSinceLaunch: number;
  turnOutputTokens: number;
  readonly recordTokens: Map<string, number>;
}

export function createSessionUsage(launchInput: readonly string[]): SessionUsageMeter {
  return {
    tokens: launchInput.reduce((sum, text) => sum + estimateTokens(text), 0),
    turnsSinceLaunch: 0,
    turnOutputTokens: 0,
    recordTokens: new Map()
  };
}

export function noteSessionSubmission(
  meter: SessionUsageMeter | undefined,
  text: string,
  kind: "turn" | "context"
): void {
  if (!meter) return;
  meter.tokens += estimateTokens(text);
  if (kind !== "turn") return;
  meter.turnsSinceLaunch += 1;
  meter.turnOutputTokens = 0;
  meter.recordTokens.clear();
}

/** A live replacement record counts once, at its largest size. */
export function noteSessionOutput(
  meter: SessionUsageMeter | undefined,
  record: TranscriptRecord
): void {
  if (!meter) return;
  const tokens = estimateTokens(record.text) + estimateTokens(record.summary ?? "");
  const previous = record.id ? (meter.recordTokens.get(record.id) ?? 0) : 0;
  const delta = Math.max(0, tokens - previous);
  if (record.id) meter.recordTokens.set(record.id, Math.max(previous, tokens));
  meter.tokens += delta;
  meter.turnOutputTokens += delta;
}

export function noteSessionTurnUsage(
  meter: SessionUsageMeter | undefined,
  usage: ChatTurnUsageDto | undefined
): void {
  if (!meter || !usage) return;
  const reported = (usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0);
  if (reported <= meter.turnOutputTokens) return;
  meter.tokens += reported - meter.turnOutputTokens;
  meter.turnOutputTokens = reported;
}

/** A session that has served at least one turn hands off before a turn would pass the budget. */
export function sessionNeedsRollover(
  meter: SessionUsageMeter | undefined,
  nextTurnTokens: number,
  budgetTokens: number
): boolean {
  if (!meter || meter.turnsSinceLaunch < 1) return false;
  return meter.tokens + nextTurnTokens > budgetTokens;
}
