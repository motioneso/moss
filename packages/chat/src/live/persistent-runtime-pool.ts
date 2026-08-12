/**
 * Warm-pool admission for persistent provider-CLI children (#1554 Phase 2).
 *
 * Provider-agnostic despite the name prefix matching the existing `persistent-runtime-engine.ts`;
 * only Claude uses it in Phase 2 (internal file/type names are not a product surface).
 */

import type { ReapReason, ProviderChatRuntime } from "./provider-runtime.js";
import type { EngineLaunchOpts } from "./types.js";

export interface PersistentRuntimePoolDeps {
  readonly cap: number; // chat.persistent_pool_cap, read once at pool construction
  readonly createRuntime: (sessionKey: string, opts: EngineLaunchOpts) => ProviderChatRuntime;
  // Fires AFTER a runtime.reap() this pool initiated (idle-timeout | lru-evict), not on
  // caller-driven kill (release()).
  readonly onReap?: (sessionKey: string, reason: ReapReason) => void;
  readonly clock: { now(): number };
}

export type AdmitResult =
  | { readonly kind: "admitted"; readonly runtime: ProviderChatRuntime }
  | { readonly kind: "denied" }; // caller falls back to bounded engine, ruling 5

interface TrackedChild {
  readonly sessionKey: string;
  readonly runtime: ProviderChatRuntime;
}

export class PersistentRuntimePool {
  private readonly deps: PersistentRuntimePoolDeps;
  private readonly children = new Map<string, TrackedChild>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(deps: PersistentRuntimePoolDeps) {
    this.deps = deps;
  }

  size(): number {
    return this.children.size;
  }

  /**
   * Fail-closed admission: atomic cap-check + LRU-evict-one-idle-if-needed + construct, under a
   * per-pool lock (single lock, not per-key — cap/evict decisions are pool-global).
   */
  admit(sessionKey: string, opts: EngineLaunchOpts): Promise<AdmitResult> {
    return this.withLock(async () => {
      if (this.children.size < this.deps.cap) {
        return this.construct(sessionKey, opts);
      }

      const victim = await this.findIdleVictim();
      if (!victim) {
        return { kind: "denied" };
      }

      // Atomic re-check immediately before evicting — no stale kill on a child that transitioned
      // out of idle between the scan above and this instant.
      const recheck = await victim.runtime.health();
      if (recheck.state !== "idle") {
        return { kind: "denied" };
      }

      await this.reapAndUntrack(victim, "lru-evict");
      return this.construct(sessionKey, opts);
    });
  }

  /** Caller-driven (session end, incognito end, explicit kill) — always allowed regardless of state. */
  release(sessionKey: string, reason: ReapReason): Promise<void> {
    return this.withLock(async () => {
      const child = this.children.get(sessionKey);
      if (!child) {
        return;
      }
      await this.reapAndUntrack(child, reason);
    });
  }

  /**
   * Idle-timeout sweep, called on a fixed interval by the composition root. Re-checks each
   * idle-tracked child's health() immediately before reaping (atomic re-check, no stale kill).
   */
  sweepIdle(idleThresholdMs: number): Promise<void> {
    return this.withLock(async () => {
      const now = this.deps.clock.now();
      const candidates = Array.from(this.children.values());
      for (const child of candidates) {
        const health = await child.runtime.health();
        if (health.state !== "idle" || health.lastResultAt === null) {
          continue;
        }
        if (now - health.lastResultAt < idleThresholdMs) {
          continue;
        }
        await this.reapAndUntrack(child, "idle-timeout");
      }
    });
  }

  private construct(sessionKey: string, opts: EngineLaunchOpts): AdmitResult {
    const runtime = this.deps.createRuntime(sessionKey, opts);
    this.children.set(sessionKey, { sessionKey, runtime });
    return { kind: "admitted", runtime };
  }

  private async findIdleVictim(): Promise<TrackedChild | null> {
    const candidates = Array.from(this.children.values());
    const healths = await Promise.all(candidates.map((child) => child.runtime.health()));

    let victim: TrackedChild | null = null;
    let victimLastResultAt = Infinity;
    for (let i = 0; i < candidates.length; i += 1) {
      const health = healths[i];
      if (health.state !== "idle") {
        continue;
      }
      const lastResultAt = health.lastResultAt ?? -Infinity;
      if (lastResultAt < victimLastResultAt) {
        victim = candidates[i];
        victimLastResultAt = lastResultAt;
      }
    }
    return victim;
  }

  private async reapAndUntrack(child: TrackedChild, reason: ReapReason): Promise<void> {
    this.children.delete(child.sessionKey);
    await child.runtime.reap(reason);
    this.deps.onReap?.(child.sessionKey, reason);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    // Keep the lock chain alive regardless of outcome so one failure doesn't wedge the pool.
    this.lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
