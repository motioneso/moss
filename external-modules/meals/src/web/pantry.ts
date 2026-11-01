// external-modules/meals/src/web/pantry.ts
//
// Loads the Pantry through the read route. Each Pantry write returns the whole Pantry, so
// `apply` swaps it in without a second read. `reload` re-reads, for Undo and retries.
import { useCallback, useEffect, useState } from "@moss/module-web-sdk";

import type { PantryView } from "../contracts";
import { readTool } from "./api";

export type PantryState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly pantry: PantryView };

export function usePantry(): {
  state: PantryState;
  reload: () => void;
  apply: (pantry: PantryView) => void;
} {
  const [state, setState] = useState<PantryState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    readTool<PantryView>("meals.pantry.get", {}).then(
      (pantry) => live && setState({ kind: "ready", pantry }),
      () =>
        live && setState((previous) => (previous.kind === "ready" ? previous : { kind: "error" }))
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n: number) => n + 1), []);
  const apply = useCallback((pantry: PantryView) => setState({ kind: "ready", pantry }), []);
  return { state, reload, apply };
}
