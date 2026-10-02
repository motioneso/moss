import { resolveMossEnv } from "@moss/db";
import { parsePositiveIntEnv } from "@moss/shared";

const DEFAULT_MAX_CALLS = 10;
const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_MAX_ACTORS = 2000;

// Override via env: JARVIS_RL_GATEWAY_AUTO_RUN_MAX (calls per window, default 10) and
// JARVIS_RL_GATEWAY_AUTO_RUN_WINDOW_MS (window length, default 10s).
export const GATEWAY_AUTO_RUN_RATE_LIMIT_DEFAULTS = {
  maxCalls: parsePositiveIntEnv(
    resolveMossEnv(process.env, "JARVIS_RL_GATEWAY_AUTO_RUN_MAX"),
    DEFAULT_MAX_CALLS
  ),
  windowMs: parsePositiveIntEnv(
    resolveMossEnv(process.env, "JARVIS_RL_GATEWAY_AUTO_RUN_WINDOW_MS"),
    DEFAULT_WINDOW_MS
  )
} as const;

// Override via env: JARVIS_RL_GATEWAY_AUTO_RUN_MAX_ACTORS (default 2000).
const MAX_ACTORS = parsePositiveIntEnv(
  resolveMossEnv(process.env, "JARVIS_RL_GATEWAY_AUTO_RUN_MAX_ACTORS"),
  DEFAULT_MAX_ACTORS
);

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

export interface AutoRunRateLimiterOptions {
  readonly maxCalls?: number;
  readonly windowMs?: number;
  readonly maxActors?: number;
}

/**
 * #1264 Task 13 — a runaway-loop guard on the gateway's unconfirmed auto-run branches
 * (yolo and resolvePolicy === "run"), NOT a security boundary: state is in-memory and
 * per-process, so it clears on restart. That is acceptable only because it bounds a loop
 * calling the same tool too fast, never an authorization decision — never wire this into
 * a tier/policy check, and never widen a family's defaultTier on the strength of "it's
 * capped now anyway."
 *
 * Nested actorUserId -> toolName maps plus an LRU actor bound mirror
 * packages/settings/src/undo-stack.ts's actors/lru pattern (touch = delete+set for
 * move-to-end, evict oldest while lru.size > cap) so a large actor population can't
 * retain buckets forever.
 */
export class AutoRunRateLimiter {
  private readonly actors = new Map<string, Map<string, RateLimitBucket>>();
  private readonly lru = new Map<string, true>();
  private readonly maxCalls: number;
  private readonly windowMs: number;
  private readonly maxActors: number;

  constructor(options: AutoRunRateLimiterOptions = {}) {
    this.maxCalls = options.maxCalls ?? GATEWAY_AUTO_RUN_RATE_LIMIT_DEFAULTS.maxCalls;
    this.windowMs = options.windowMs ?? GATEWAY_AUTO_RUN_RATE_LIMIT_DEFAULTS.windowMs;
    this.maxActors = options.maxActors ?? MAX_ACTORS;
  }

  private touch(actorUserId: string): Map<string, RateLimitBucket> {
    let tools = this.actors.get(actorUserId);
    if (!tools) {
      tools = new Map();
      this.actors.set(actorUserId, tools);
    }
    this.lru.delete(actorUserId);
    this.lru.set(actorUserId, true);
    this.evictLeastRecentlyUsed();
    return tools;
  }

  private evictLeastRecentlyUsed(): void {
    while (this.lru.size > this.maxActors) {
      const oldest = this.lru.keys().next();
      if (oldest.done) break;
      this.lru.delete(oldest.value);
      this.actors.delete(oldest.value);
    }
  }

  /**
   * Returns true when the (actorUserId, toolName) call may proceed this window. A call
   * that trips the ceiling keeps returning false for the rest of the window without
   * incrementing further — calling faster buys no extra headroom.
   */
  consume(actorUserId: string, toolName: string): boolean {
    const tools = this.touch(actorUserId);
    const now = Date.now();
    let bucket = tools.get(toolName);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { count: 0, windowStart: now };
      tools.set(toolName, bucket);
    }
    if (bucket.count >= this.maxCalls) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  /** Non-mutating twin of `consume`: true when a call would currently be allowed. */
  wouldAllow(actorUserId: string, toolName: string): boolean {
    const bucket = this.actors.get(actorUserId)?.get(toolName);
    if (!bucket || Date.now() - bucket.windowStart >= this.windowMs) return true;
    return bucket.count < this.maxCalls;
  }
}
