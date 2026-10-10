import { GATE_LIMITS, type GateSpeed } from "./classifier-gate.js";
import { GATE_TOKEN_TTL_MS } from "./classifier-gate-runner.js";

/**
 * #3365: the gate's time limit, measured per routing model.
 *
 * A fast router keeps a tight limit, so a hung one still falls back to the default model quickly. A
 * slow one (a sign-in CLI model answers each question in about 5 to 7 seconds, and an attempt asks
 * up to three) gets a stretched limit instead of a cutoff that always kills it.
 *
 * limit = clamp(slow answer time x 2 + margin, floor, ceiling), where the slow answer time is the
 * 90th percentile of the model's last 20 attempts. With no record yet (first use, or after a
 * restart) the limit is the ceiling, so a slow model still gets its first answer and is measured. A
 * timed-out attempt records the time it was allowed, so a model that keeps timing out doubles its
 * limit each time until the ceiling.
 *
 * The ceiling stays at half the gate token's fixed one-minute life, so the token outlives the
 * longest classification with the same time again left for the tool call itself.
 */
export const GATE_TIME_LIMIT = {
  floorMs: GATE_LIMITS.deadlineMs,
  ceilingMs: GATE_TOKEN_TTL_MS / 2,
  marginMs: 500,
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
    return Math.min(
      GATE_TIME_LIMIT.ceilingMs,
      Math.max(GATE_TIME_LIMIT.floorMs, slow * 2 + GATE_TIME_LIMIT.marginMs)
    );
  }

  record(modelId: string, elapsedMs: number): void {
    const times = this.answers.get(modelId) ?? [];
    times.push(elapsedMs);
    if (times.length > GATE_TIME_LIMIT.samples) times.shift();
    this.answers.set(modelId, times);
  }
}
