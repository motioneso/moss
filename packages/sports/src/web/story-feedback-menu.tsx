import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { MoreHorizontal, ThumbsDown, ThumbsUp } from "lucide-react";
import { Menu } from "@moss/module-web-sdk";
import type { FeedbackSurface } from "@moss/shared";
import { STORY_FEEDBACK_REASON_MAX_LENGTH } from "@moss/shared";

import { createSportsStoryFeedback } from "./sports-client.js";

type StoryFeedbackKind = "more_like_this" | "less_like_this";
type StoryFeedbackInput = { kind: StoryFeedbackKind; reason?: string };

export interface StoryFeedbackMenuProps {
  readonly storyRef?: string;
  readonly surface: Extract<FeedbackSurface, "sports" | "today">;
  readonly onChanged: (storyRef: string, kind: StoryFeedbackKind) => void;
}

export function StoryFeedbackMenu(props: StoryFeedbackMenuProps) {
  const { storyRef } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: (input: StoryFeedbackInput) =>
      createSportsStoryFeedback({
        targetKind: "sports_story",
        targetRef: storyRef!,
        surface: props.surface,
        kind: input.kind,
        ...(input.reason === undefined ? {} : { reason: input.reason })
      }),
    onSuccess: (_result, input) => {
      setEditing(false);
      setSaved(true);
      props.onChanged(storyRef!, input.kind);
    },
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not save story preference.");
    }
  });

  useEffect(() => {
    if (!editing) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setEditing(false);
      setError(null);
      containerRef.current?.querySelector<HTMLButtonElement>(".jds-menu__trigger")?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  if (!storyRef) return null;

  const closeEditor = () => {
    setEditing(false);
    setError(null);
    containerRef.current?.querySelector<HTMLButtonElement>(".jds-menu__trigger")?.focus();
  };

  const saveReason = () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Tell us why before saving.");
      return;
    }
    mutation.mutate({ kind: "less_like_this", reason: trimmed });
  };

  return (
    <div className="sp-feedback" ref={containerRef}>
      <Menu
        triggerIcon={<MoreHorizontal size={14} aria-hidden="true" />}
        triggerLabel="Story feedback"
        items={[
          {
            id: "more_like_this",
            label: "More like this",
            icon: <ThumbsUp size={13} aria-hidden="true" />,
            disabled: mutation.isPending
          },
          {
            id: "less_like_this",
            label: "Less like this",
            icon: <ThumbsDown size={13} aria-hidden="true" />,
            disabled: mutation.isPending
          }
        ]}
        onSelect={(id) => {
          if (id === "more_like_this") mutation.mutate({ kind: "more_like_this" });
          else {
            setEditing(true);
            setError(null);
          }
        }}
      />
      {editing ? (
        <div className="sp-feedback__editor" role="dialog" aria-label="Why less like this?">
          <label className="sp-feedback__label" htmlFor={`feedback-reason-${storyRef}`}>
            Why less like this?
          </label>
          <textarea
            id={`feedback-reason-${storyRef}`}
            className="sp-feedback__reason"
            value={reason}
            maxLength={STORY_FEEDBACK_REASON_MAX_LENGTH}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          {error ? (
            <p className="sp-feedback__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="sp-feedback__actions">
            <button type="button" onClick={closeEditor}>
              Cancel
            </button>
            <button type="button" onClick={saveReason}>
              Save
            </button>
          </div>
        </div>
      ) : null}
      {!editing && saved ? (
        <span className="sp-feedback__saved" role="status">
          Saved
        </span>
      ) : null}
      {!editing && error ? (
        <p className="sp-feedback__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
