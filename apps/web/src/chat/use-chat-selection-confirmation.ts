import { useCallback, useEffect, useState } from "react";
import type { ChatSurface } from "@moss/shared";
import type { ChatTransition } from "./use-chat-transition";

type ConfirmedSelection = {
  readonly surface: ChatSurface;
  readonly generation: number;
  readonly threadId: string | null;
  readonly confirmedAt: number;
};

/** Keeps a current successful selection ahead of cached privacy until a newer identity arrives. */
export function useChatSelectionConfirmation(
  surface: ChatSurface,
  generation: { current: number }
) {
  const [selection, setSelection] = useState<ConfirmedSelection | null>(null);
  useEffect(() => setSelection(null), [surface]);
  const confirm = useCallback((threadId: string | null, transition: ChatTransition) => {
    setSelection({ ...transition, threadId, confirmedAt: Date.now() });
  }, []);
  const current =
    selection && selection.surface === surface && selection.generation === generation.current
      ? selection
      : null;
  return { confirm, current };
}
