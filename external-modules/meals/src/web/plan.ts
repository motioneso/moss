// external-modules/meals/src/web/plan.ts
//
// Loads the plan the Plan tab shows and keeps it fresh while Moss is still writing it. Polling
// runs only when the page is visible and some day is still pending or being written.
import { useCallback, useEffect, useState } from "@moss/module-web-sdk";

import type { PlanView } from "../contracts";
import { readTool } from "./api";
import { todayIso } from "./format";

export type PlanState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly plan: PlanView };

export const POLL_MS = 4000;

/** True while the plan still has days to write and is not stopped or paused. */
export function isWriting(plan: PlanView): boolean {
  return (
    plan.state === "active" &&
    plan.days.some((day) => day.status === "pending" || day.status === "writing")
  );
}

export function usePlan(): { state: PlanState; reload: () => void } {
  const [state, setState] = useState<PlanState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const writing = state.kind === "ready" && isWriting(state.plan);

  useEffect(() => {
    let live = true;
    readTool<{ plan: PlanView | null }>("meals.plan.current", { date: todayIso() }).then(
      (result) => {
        if (!live) return;
        setState(result.plan === null ? { kind: "empty" } : { kind: "ready", plan: result.plan });
      },
      () =>
        live && setState((previous) => (previous.kind === "ready" ? previous : { kind: "error" }))
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (!writing) return undefined;
    const tick = () => {
      if (document.visibilityState === "visible") setAttempt((n: number) => n + 1);
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [writing]);

  const reload = useCallback(() => setAttempt((n: number) => n + 1), []);
  return { state, reload };
}
