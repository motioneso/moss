import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatSurface } from "@moss/shared";
import {
  bindUnselectedDraft,
  boundDraftKey,
  moveUnselectedDraft,
  unselectedDraftKey,
  type ChatDrafts
} from "./chat-draft-storage";

export function useChatDraftBinding(input: {
  readonly surface: ChatSurface;
  readonly drafts: ChatDrafts;
  readonly setDrafts: Dispatch<SetStateAction<ChatDrafts>>;
  readonly privateMode: boolean;
  readonly activatingPrivate: boolean;
  readonly selectedThreadId: string | null;
  readonly mainThreadId: string | undefined;
  readonly hasConfirmedSelection: boolean;
  readonly confirmedThreadId: string | null;
  readonly privacyThreadId: string | undefined;
  readonly generation: { current: number };
}) {
  const {
    surface,
    drafts,
    setDrafts,
    privateMode,
    activatingPrivate,
    selectedThreadId,
    mainThreadId,
    hasConfirmedSelection,
    confirmedThreadId,
    privacyThreadId,
    generation
  } = input;
  const fallbackKey = unselectedDraftKey(surface);
  const origin = useRef<{ readonly surface: ChatSurface; readonly generation: number } | null>(
    null
  );
  useEffect(() => {
    origin.current = null;
  }, [surface]);
  useEffect(() => {
    if (surface === "drawer" && mainThreadId) {
      setDrafts((current) => moveUnselectedDraft(current, fallbackKey, mainThreadId));
      return;
    }
    const target = hasConfirmedSelection ? confirmedThreadId : privacyThreadId;
    if (
      surface !== "drawer" &&
      target &&
      origin.current?.surface === surface &&
      origin.current.generation === generation.current
    ) {
      setDrafts((current) => bindUnselectedDraft(current, surface, target));
      origin.current = null;
    }
  }, [
    confirmedThreadId,
    fallbackKey,
    generation,
    hasConfirmedSelection,
    mainThreadId,
    privacyThreadId,
    setDrafts,
    surface
  ]);
  const activeBoundKey = selectedThreadId ? boundDraftKey(surface, selectedThreadId) : null;
  const draftKey =
    privateMode || activatingPrivate
      ? "__private__"
      : activeBoundKey && drafts[activeBoundKey]
        ? activeBoundKey
        : surface === "drawer" && !mainThreadId && drafts[fallbackKey] !== undefined
          ? fallbackKey
          : (selectedThreadId ?? fallbackKey);
  const changeDraft = (draft: string) => {
    if (draftKey === fallbackKey) {
      if (!draft) origin.current = null;
      else if (drafts[fallbackKey] === undefined || drafts[fallbackKey] === "") {
        origin.current = { surface, generation: generation.current };
      }
    }
    setDrafts((current) => {
      if (!draft && draftKey === activeBoundKey) {
        const { [draftKey]: _bound, ...rest } = current;
        return rest;
      }
      return { ...current, [draftKey]: draft };
    });
  };
  return { changeDraft, draftKey };
}
