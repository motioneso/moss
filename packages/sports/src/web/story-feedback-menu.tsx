import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button, Menu } from "@moss/module-web-sdk";
import type { FeedbackSurface } from "@moss/shared";
import { STORY_FEEDBACK_REASON_MAX_LENGTH } from "@moss/shared";

import { createSportsStoryFeedback } from "./sports-client.js";

type StoryFeedbackKind = "more_like_this" | "less_like_this";
type StoryFeedbackInput = { kind: StoryFeedbackKind; reason?: string };

export type StoryFeedbackChange = (storyRef: string, kind: StoryFeedbackKind) => void;

export interface StoryFeedbackMenuProps {
  readonly storyRef?: string;
  readonly surface: Extract<FeedbackSurface, "sports" | "today">;
  readonly onChanged: StoryFeedbackChange;
}

export function StoryFeedbackMenu(props: StoryFeedbackMenuProps) {
  const { storyRef } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const submit = (input: StoryFeedbackInput) => {
    setError(null);
    setPending(true);
    void createSportsStoryFeedback({
      targetKind: "sports_story",
      targetRef: storyRef!,
      surface: props.surface,
      kind: input.kind,
      ...(input.reason === undefined ? {} : { reason: input.reason })
    })
      .then(() => {
        setEditing(false);
        setSaved(true);
        props.onChanged(storyRef!, input.kind);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not save story preference.");
      })
      .finally(() => setPending(false));
  };

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
    submit({ kind: "less_like_this", reason: trimmed });
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
            disabled: pending
          },
          {
            id: "less_like_this",
            label: "Less like this",
            icon: <ThumbsDown size={13} aria-hidden="true" />,
            disabled: pending
          }
        ]}
        onSelect={(id) => {
          if (id === "more_like_this") submit({ kind: "more_like_this" });
          else {
            setEditing(true);
            setError(null);
          }
        }}
      />
      {editing ? (
        <div
          className="sp-feedback__editor jds-card jds-card--raised jds-card--pad-sm"
          role="dialog"
          aria-label="Why less like this?"
        >
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
            <Button variant="quiet" size="sm" onClick={closeEditor}>
              Cancel
            </Button>
            <Button size="sm" onClick={saveReason} disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
      {!editing && saved ? (
        <span
          className="sp-feedback__saved jds-card jds-card--raised jds-card--pad-sm"
          role="status"
        >
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
