// external-modules/meals/src/web/log.ts
//
// Loads one day of the Log through the read route. The page re-reads every few seconds while the
// tab is visible, so a meal logged in chat shows up without a reload.
import { useCallback, useEffect, useState } from "@moss/module-web-sdk";

import type { LogListResult } from "../contracts";
import { readTool } from "./api";

export type LogState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly forDate: string; readonly day: LogListResult };

export const LOG_POLL_MS = 5000;

export function useLog(localDate: string): { state: LogState; reload: () => void } {
  const [state, setState] = useState<LogState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    readTool<LogListResult>("meals.log.list", { localDate }).then(
      (day) => live && setState({ kind: "ready", forDate: localDate, day }),
      () =>
        live &&
        setState((previous) =>
          previous.kind === "ready" && previous.forDate === localDate ? previous : { kind: "error" }
        )
    );
    return () => {
      live = false;
    };
  }, [localDate, attempt]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setAttempt((n: number) => n + 1);
    };
    const timer = window.setInterval(tick, LOG_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const reload = useCallback(() => setAttempt((n: number) => n + 1), []);
  return { state, reload };
}
