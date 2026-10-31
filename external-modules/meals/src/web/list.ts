// external-modules/meals/src/web/list.ts
//
// Loads the shopping list through the read route. Each list write returns the whole list, so
// `apply` swaps it in without a second read. `reload` re-reads, for Undo and retries.
import { useCallback, useEffect, useState } from "@moss/module-web-sdk";

import type { ShoppingListView } from "../contracts";
import { readTool } from "./api";

export type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly list: ShoppingListView };

export function useShoppingList(): {
  state: ListState;
  reload: () => void;
  apply: (list: ShoppingListView) => void;
} {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    readTool<ShoppingListView>("meals.list.get", {}).then(
      (list) => live && setState({ kind: "ready", list }),
      () =>
        live && setState((previous) => (previous.kind === "ready" ? previous : { kind: "error" }))
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n: number) => n + 1), []);
  const apply = useCallback((list: ShoppingListView) => setState({ kind: "ready", list }), []);
  return { state, reload, apply };
}

type WakeLockSentinelLike = { release: () => Promise<void> };
type WakeLockNavigator = {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

/**
 * Keeps the screen on while the list is showing on a touch device, so it stays readable in a
 * shop. Releases when the list hides, and does nothing where the browser has no wake lock.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || typeof window === "undefined") {
      return undefined;
    }
    const api = (navigator as unknown as WakeLockNavigator).wakeLock;
    const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    if (api === undefined || !touch) return undefined;

    let sentinel: WakeLockSentinelLike | null = null;
    let live = true;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      api.request("screen").then(
        (lock) => {
          if (live) sentinel = lock;
          else void lock.release().catch(() => undefined);
        },
        () => undefined
      );
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", acquire);
      if (sentinel !== null) void sentinel.release().catch(() => undefined);
    };
  }, [active]);
}
