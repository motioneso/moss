// external-modules/meals/src/web/kitchen.ts
//
// Loads the Kitchen through the read route. `reload` re-reads after a write.
import { useCallback, useEffect, useState } from "@moss/module-web-sdk";

import type { KitchenView } from "../contracts";
import { readTool } from "./api";

export type KitchenState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly kitchen: KitchenView };

export function useKitchen(): { state: KitchenState; reload: () => void } {
  const [state, setState] = useState<KitchenState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    readTool<KitchenView>("meals.kitchen.get", {}).then(
      (kitchen) => live && setState({ kind: "ready", kitchen }),
      () => live && setState({ kind: "error" })
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n: number) => n + 1), []);
  return { state, reload };
}
