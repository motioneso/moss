import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSurface } from "@moss/shared";

type CallerDraft = {
  readonly text: string;
  readonly surface: ChatSurface;
  readonly generation: number;
  readonly threadId?: string;
  readonly confirmed?: boolean;
  readonly dispatched?: boolean;
  readonly edited?: boolean;
};

/** Keeps caller-provided starters out of durable drafts until the user edits them. */
export function useInitialCallerDraft(
  initialText: string | undefined,
  surface: ChatSurface,
  generation: { current: number }
) {
  const [draft, setDraft] = useState<CallerDraft | null>(null);
  const initialTextRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    initialTextRef.current = undefined;
    setDraft(null);
  }, [surface]);
  useEffect(() => {
    if (!initialText) {
      initialTextRef.current = undefined;
      setDraft(null);
      return;
    }
    if (initialTextRef.current === initialText) return;
    initialTextRef.current = initialText;
    setDraft({ text: initialText, surface, generation: generation.current });
  }, [initialText, surface, generation]);
  const bind = useCallback(
    (threadId: string, targetSurface: ChatSurface, targetGeneration: number, confirmed = false) =>
      setDraft((current) =>
        current &&
        !current.dispatched &&
        current.surface === targetSurface &&
        current.generation === targetGeneration &&
        (!current.confirmed || confirmed) &&
        (current.threadId !== threadId || (confirmed && !current.confirmed))
          ? { ...current, threadId, confirmed: confirmed || current.confirmed }
          : current
      ),
    []
  );
  const retire = useCallback(
    (targetSurface: ChatSurface, targetGeneration?: number) =>
      setDraft((current) =>
        current &&
        current.surface === targetSurface &&
        (targetGeneration === undefined || current.generation === targetGeneration)
          ? null
          : current
      ),
    []
  );
  const dispatch = useCallback(
    (text: string, targetSurface: ChatSurface, targetGeneration: number) =>
      setDraft((current) =>
        current &&
        !current.dispatched &&
        current.text === text &&
        current.surface === targetSurface &&
        current.generation === targetGeneration
          ? { ...current, dispatched: true }
          : current
      ),
    []
  );
  const edit = useCallback(
    (targetSurface: ChatSurface, targetGeneration: number) =>
      setDraft((current) =>
        current &&
        current.surface === targetSurface &&
        current.generation === targetGeneration &&
        !current.edited
          ? { ...current, edited: true }
          : current
      ),
    []
  );
  const textFor = (threadId: string | null, durableDraft: string | undefined) =>
    draft &&
    !draft.dispatched &&
    draft.surface === surface &&
    draft.generation === generation.current &&
    (!draft.threadId || draft.threadId === threadId) &&
    (durableDraft === undefined || (!draft.edited && durableDraft === ""))
      ? draft.text
      : "";
  return { bind, dispatch, edit, retire, textFor };
}
