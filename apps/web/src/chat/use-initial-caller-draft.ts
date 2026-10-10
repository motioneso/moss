import { useCallback, useEffect, useRef, useState } from "react";
import type { SetStateAction } from "react";
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

type CallerDraftTarget = {
  readonly destination: string;
  readonly generation: number;
  readonly surface: ChatSurface;
  readonly threadId: string | null;
};

/** Keeps caller-provided starters out of durable drafts until the user edits them. */
export function useInitialCallerDraft(
  initialText: string | undefined,
  surface: ChatSurface,
  generation: { current: number }
) {
  const [draft, setDraft] = useState<CallerDraft | null>(() =>
    initialText ? { text: initialText, surface, generation: generation.current } : null
  );
  const draftRef = useRef<CallerDraft | null>(draft);
  const initialTextRef = useRef<string | undefined>(undefined);
  const setCurrentDraft = useCallback((action: SetStateAction<CallerDraft | null>) => {
    setDraft((current) => {
      const next = typeof action === "function" ? action(current) : action;
      draftRef.current = next;
      return next;
    });
  }, []);
  useEffect(() => {
    initialTextRef.current = undefined;
    setCurrentDraft(null);
  }, [setCurrentDraft, surface]);
  useEffect(() => {
    if (!initialText) {
      initialTextRef.current = undefined;
      setCurrentDraft(null);
      return;
    }
    if (initialTextRef.current === initialText) return;
    initialTextRef.current = initialText;
    setCurrentDraft({ text: initialText, surface, generation: generation.current });
  }, [generation, initialText, setCurrentDraft, surface]);
  const bind = useCallback(
    (threadId: string, targetSurface: ChatSurface, targetGeneration: number, confirmed = false) =>
      setCurrentDraft((current) =>
        current &&
        !current.dispatched &&
        current.surface === targetSurface &&
        current.generation === targetGeneration &&
        (!current.confirmed || confirmed) &&
        (current.threadId !== threadId || (confirmed && !current.confirmed))
          ? { ...current, threadId, confirmed: confirmed || current.confirmed }
          : current
      ),
    [setCurrentDraft]
  );
  const retire = useCallback(
    (targetSurface: ChatSurface, targetGeneration?: number) =>
      setCurrentDraft((current) =>
        current &&
        current.surface === targetSurface &&
        (targetGeneration === undefined || current.generation === targetGeneration)
          ? null
          : current
      ),
    [setCurrentDraft]
  );
  const dispatch = useCallback(
    (text: string, targetSurface: ChatSurface, targetGeneration: number) =>
      setCurrentDraft((current) =>
        current &&
        !current.dispatched &&
        current.text === text &&
        current.surface === targetSurface &&
        current.generation === targetGeneration
          ? { ...current, dispatched: true }
          : current
      ),
    [setCurrentDraft]
  );
  const edit = useCallback(
    (targetSurface: ChatSurface, targetGeneration: number) =>
      setCurrentDraft((current) =>
        current &&
        current.surface === targetSurface &&
        current.generation === targetGeneration &&
        !current.edited
          ? { ...current, edited: true }
          : current
      ),
    [setCurrentDraft]
  );
  const starterFor = useCallback(
    (targetSurface: ChatSurface, targetGeneration: number, targetThreadId: string | null) => {
      const current = draftRef.current;
      return current &&
        !current.dispatched &&
        !current.edited &&
        current.surface === targetSurface &&
        current.generation === targetGeneration &&
        (!current.threadId || current.threadId === targetThreadId)
        ? current.text
        : undefined;
    },
    []
  );
  const apply = useCallback(
    (
      action: SetStateAction<string>,
      target: CallerDraftTarget,
      changeDraft: (update: SetStateAction<string>, draftKey: string, onChange?: () => void) => void
    ) => {
      if (typeof action !== "function") {
        edit(target.surface, target.generation);
        changeDraft(action, target.destination);
        return;
      }
      const starter = starterFor(target.surface, target.generation, target.threadId);
      changeDraft(
        (current) => {
          const next = action(current || starter || current);
          return starter && current === "" && next === starter ? current : next;
        },
        target.destination,
        () => edit(target.surface, target.generation)
      );
    },
    [edit, starterFor]
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
  return { apply, bind, dispatch, edit, retire, textFor };
}
