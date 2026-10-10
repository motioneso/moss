import { MAX_ARGUMENT_QUESTIONS } from "./classifier-gate-arguments.js";
import { GATE_LIMITS, type GateSpeed } from "./classifier-gate.js";
import { GATE_TOKEN_TTL_MS } from "./classifier-gate-runner.js";

/**
 * #3365: the gate's time limit, measured per routing model.
 *
 * The record holds time per question (an attempt's time divided by the questions it asked), because
 * most attempts stop after one question while a tool request asks up to four: area, tool and up to
 * two argument questions. A sign-in CLI model answers each question in about 5 to 7 seconds.
 *
 * limit = clamp(slow question time x questions per attempt x 2 + margin, floor, ceiling), where the
 * slow question time is the 90th percentile of the model's last 20 attempts. A fast router stays on
 * the floor; a slow one gets room for a full four-question attempt. With no record yet (first use,
 * or after a restart) the limit is the ceiling, so a slow model still gets its first answer and is
 * measured. A timed-out attempt counts the question in flight as answered at the deadline, so a
 * model that keeps timing out climbs with each run of timeouts until the ceiling.
 *
 * The ceiling is at most half the gate token's fixed one-minute life, so the token outlives the
 * longest classification with the same time again left for the tool call itself.
 */
export const GATE_TIME_LIMIT = {
  floorMs: GATE_LIMITS.deadlineMs,
  ceilingMs: GATE_TOKEN_TTL_MS / 2,
  marginMs: 500,
  questionsPerAttempt: 2 + MAX_ARGUMENT_QUESTIONS,
  slowQuantile: 0.9,
  samples: 20
} as const;

/** In memory only, keyed by the model's config id. One per process, shared by both runners. */
export class GateSpeedRecord implements GateSpeed {
  private readonly answers = new Map<string, number[]>();

  limitMs(modelId: string): number {
    const times = this.answers.get(modelId);
    if (!times?.length) return GATE_TIME_LIMIT.ceilingMs;
    const sorted = [...times].sort((a, b) => a - b);
    const slow = sorted[Math.ceil(sorted.length * GATE_TIME_LIMIT.slowQuantile) - 1] ?? 0;
    const attempt = slow * GATE_TIME_LIMIT.questionsPerAttempt;
    return Math.min(
      GATE_TIME_LIMIT.ceilingMs,
      Math.max(GATE_TIME_LIMIT.floorMs, attempt * 2 + GATE_TIME_LIMIT.marginMs)
    );
  }

  record(modelId: string, perQuestionMs: number): void {
    const times = this.answers.get(modelId) ?? [];
    times.push(perQuestionMs);
    if (times.length > GATE_TIME_LIMIT.samples) times.shift();
    this.answers.set(modelId, times);
  }
}
