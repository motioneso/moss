import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { updatePageContext } from "../api/client.js";
import { capturePageContextSnapshot } from "./page-context.js";

const SYNC_DEBOUNCE_MS = 250;
// Page context shares a 20/minute chat-mutation limit; animated/live pages can mutate far faster.
const SYNC_MIN_INTERVAL_MS = 5_000;

type PageContextSyncState = {
  lastUploadAt: number;
};

export function createDebouncedPageContextSync(input: {
  readonly capture: typeof capturePageContextSnapshot;
  readonly upload: typeof updatePageContext;
  readonly state?: PageContextSyncState;
  readonly delayMs: number;
  readonly minIntervalMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = input.state ?? { lastUploadAt: Number.NEGATIVE_INFINITY };
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      const remaining = (input.minIntervalMs ?? 0) - (Date.now() - state.lastUploadAt);
      timer = setTimeout(
        () => {
          state.lastUploadAt = Date.now();
          void input.upload(input.capture()).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn("page context upload failed", message);
          });
        },
        Math.max(input.delayMs, remaining)
      );
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
  };
}

/**
 * #1109 — replaces the per-turn page-context push (deleted in Task 5): the client keeps the
 * server's live-view snapshot current independent of chat activity, debounced so route changes,
 * DOM mutations, focus, and selection changes don't each fire a request.
 */
export function usePageContextSync(): void {
  const location = useLocation();
  const stateRef = useRef<PageContextSyncState>({ lastUploadAt: Number.NEGATIVE_INFINITY });
  const sync = createDebouncedPageContextSync({
    capture: capturePageContextSnapshot,
    upload: updatePageContext,
    delayMs: SYNC_DEBOUNCE_MS,
    minIntervalMs: SYNC_MIN_INTERVAL_MS,
    state: stateRef.current
  });
  useEffect(() => {
    const observer = new MutationObserver(sync.schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener("focusin", sync.schedule);
    document.addEventListener("selectionchange", sync.schedule);
    sync.schedule();
    return () => {
      sync.stop();
      observer.disconnect();
      document.removeEventListener("focusin", sync.schedule);
      document.removeEventListener("selectionchange", sync.schedule);
    };
  }, [location.pathname, location.search]);
}
