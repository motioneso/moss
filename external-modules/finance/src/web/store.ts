// external-modules/finance/src/web/store.ts
// FIN-02 (#1147) Task 11: tiny module-scoped fetch cache, ported from
// job-search. The host deliberately does not expose React Query on the
// runtime global, so reads share one Map keyed by tool name + input JSON
// (module-scoped by construction) with useSyncExternalStore subscribers.
// Fetch starts on first subscribe; snapshots are stable object identities so
// getSnapshot is referentially safe.
import { useCallback, useSyncExternalStore } from "@moss/module-web-sdk";
import { invokeTool, type ToolOutcome } from "./api";

export type QuerySnapshot<T> =
  | { status: "loading" }
  | { status: "settled"; outcome: ToolOutcome<T> };

type Entry = {
  snapshot: QuerySnapshot<Record<string, unknown>>;
  listeners: Set<() => void>;
  started: boolean;
};

const LOADING: QuerySnapshot<never> = { status: "loading" };
const cache = new Map<string, Entry>();

function entryFor(key: string): Entry {
  let entry = cache.get(key);
  if (!entry) {
    entry = { snapshot: LOADING, listeners: new Set(), started: false };
    cache.set(key, entry);
  }
  return entry;
}

function start(key: string, name: string, input?: Record<string, unknown>): void {
  const entry = entryFor(key);
  if (entry.started) return;
  entry.started = true;
  void invokeTool(name, input).then((outcome) => {
    entry.snapshot = { status: "settled", outcome };
    for (const listener of entry.listeners) listener();
  });
}

export function useToolQuery<T extends Record<string, unknown>>(
  name: string,
  input?: Record<string, unknown>
): QuerySnapshot<T> {
  const key = `${name}:${JSON.stringify(input ?? {})}`;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const entry = entryFor(key);
      entry.listeners.add(onChange);
      start(key, name, input);
      return () => {
        entry.listeners.delete(onChange);
      };
    },
    // key encodes name+input, so it is the only dependency (no react-hooks plugin is
    // loaded for this tree — a disable directive for it would itself be a lint error).
    [key]
  );
  const getSnapshot = useCallback(() => entryFor(key).snapshot, [key]);
  // Third arg = server snapshot: renderToString requires it and reports the
  // current cache state (loading on a cold cache) without kicking off fetches.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as QuerySnapshot<T>;
}

// After a queue run (or on demand) drop everything so the next mount refetches.
export function invalidateQueries(): void {
  const listeners: Array<() => void> = [];
  for (const entry of cache.values()) listeners.push(...entry.listeners);
  cache.clear();
  for (const listener of listeners) listener();
}

export function __resetStoreForTests(): void {
  cache.clear();
}
