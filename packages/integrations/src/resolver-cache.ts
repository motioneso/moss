import type { MossModuleManifest } from "@moss/module-sdk";

/**
 * Caches one user's connection rows and built tool descriptions for 30 seconds (#2175 Task 8),
 * keyed by acting user, so the chat gateway's per-call tool lookup doesn't hit the database and
 * rebuild every tool description on every single tool call. Same window as Task 3's call memory —
 * one number to reason about. The drop-on-edit rule in routes.ts, not this clock, is what keeps a
 * user's own changes immediate; a stale entry must never be returned for anyone but the user who
 * owns it, and only until their own next edit.
 */
export interface ResolverCache {
  /** Live cached synthetic modules for this user, or undefined if absent/expired. */
  get(actorUserId: string): readonly MossModuleManifest[] | undefined;
  set(actorUserId: string, modules: readonly MossModuleManifest[]): void;
  /** Called on every connection add/edit/delete/refresh or tool-curation change for this user. */
  drop(actorUserId: string): void;
}

export function createResolverCache(deps?: {
  now?: () => number;
  windowMs?: number;
}): ResolverCache {
  const now = deps?.now ?? (() => Date.now());
  const windowMs = deps?.windowMs ?? 30_000;
  const entries = new Map<string, { modules: readonly MossModuleManifest[]; storedAt: number }>();

  return {
    get(actorUserId) {
      const stored = entries.get(actorUserId);
      if (!stored) return undefined;
      if (now() - stored.storedAt > windowMs) {
        entries.delete(actorUserId);
        return undefined;
      }
      return stored.modules;
    },
    set(actorUserId, modules) {
      entries.set(actorUserId, { modules, storedAt: now() });
    },
    drop(actorUserId) {
      entries.delete(actorUserId);
    }
  };
}

/** Module-level singleton — imported by tool-manifests.ts and dropped from routes.ts on every edit. */
export const resolverCache: ResolverCache = createResolverCache();
