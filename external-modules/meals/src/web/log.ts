// external-modules/meals/src/web/log.ts
//
// Loads one day of the Log through the read route. While any meal on screen is still being
// estimated, the page re-reads every few seconds, but only when the tab is visible.
import { useCallback, useEffect, useState } from "@moss/module-web-sdk";

import type { LogListResult } from "../contracts";
import { readTool } from "./api";

export type LogState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly day: LogListResult };

export const LOG_POLL_MS = 5000;

export function isEstimating(day: LogListResult): boolean {
  return day.entries.some((entry) => entry.estimateState === "pending");
}

export function useLog(localDate: string): { state: LogState; reload: () => void } {
  const [state, setState] = useState<LogState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const estimating = state.kind === "ready" && isEstimating(state.day);

  useEffect(() => {
    let live = true;
    readTool<LogListResult>("meals.log.list", { localDate }).then(
      (day) => live && setState({ kind: "ready", day }),
      () =>
        live && setState((previous) => (previous.kind === "ready" ? previous : { kind: "error" }))
    );
    return () => {
      live = false;
    };
  }, [localDate, attempt]);

  useEffect(() => {
    if (!estimating) return undefined;
    const tick = () => {
      if (document.visibilityState === "visible") setAttempt((n: number) => n + 1);
    };
    const timer = window.setInterval(tick, LOG_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [estimating]);

  const reload = useCallback(() => setAttempt((n: number) => n + 1), []);
  return { state, reload };
}
