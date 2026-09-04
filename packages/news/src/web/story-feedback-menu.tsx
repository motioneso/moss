import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, ThumbsDown, ThumbsUp } from "lucide-react";
import { useId, useState } from "react";
import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";

import { Button, Menu } from "@moss/module-web-sdk";

import { newsQueryKeys } from "./query-keys.js";
import { createNewsStoryFeedback } from "./story-feedback-client.js";
import { CAROUSEL_CAP } from "./news-mosaic.js";
import "./story-feedback.css";

// A dismissal shrinks the carousel's slide list. Refill it from the stories already loaded in
// the ranked pool so the carousel stays full instead of draining one dismissal at a time — a
// blind refetch here could bring back a stale server snapshot that still has the dismissed story.
function refillTopStories(
  topStories: readonly NewsHeadline[],
  rankedPool: readonly NewsHeadline[] | undefined,
  cap: number
): NewsHeadline[] {
  if (topStories.length >= cap || !rankedPool) return [...topStories];
  const present = new Set(topStories.map((h) => h.id));
  const refilled = [...topStories];
  for (const candidate of rankedPool) {
    if (refilled.length >= cap) break;
    if (present.has(candidate.id)) continue;
    refilled.push(candidate);
    present.add(candidate.id);
  }
  return refilled;
}

function withoutStory(
  data: NewsOverviewResponse,
  targetRef: string,
  headlineId?: string
): NewsOverviewResponse {
  const keep = (headline: NewsHeadline) =>
    headline.feedbackRef !== targetRef && (headlineId ? headline.id !== headlineId : true);
  const topStories = data.topStories.filter(keep);
  const rankedStories = data.rankedStories?.filter(keep);
  return {
    ...data,
    topStories: refillTopStories(topStories, rankedStories, CAROUSEL_CAP),
    rankedStories,
    sourceGroups: data.sourceGroups
      .map((group) => ({ ...group, headlines: group.headlines.filter(keep) }))
      .filter((group) => group.headlines.length > 0)
  };
}

export function StoryFeedbackMenu(props: {
  readonly headline: NewsHeadline;
  readonly surface: "news" | "today";
}) {
  const targetRef = props.headline.feedbackRef;
  if (!targetRef) return null;
  return <StoryFeedbackMenuWithTarget {...props} targetRef={targetRef} />;
}

function StoryFeedbackMenuWithTarget(props: {
  readonly headline: NewsHeadline;
  readonly surface: "news" | "today";
  readonly targetRef: string;
}) {
  const targetRef = props.targetRef;
  const queryClient = useQueryClient();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const reasonId = useId();
  const mutation = useMutation({
    mutationFn: (input: { kind: "more_like_this" | "less_like_this"; reason?: string }) =>
      createNewsStoryFeedback({ targetRef: targetRef!, surface: props.surface, ...input }),
    onSuccess: (_result, variables) => {
      if (variables.kind === "less_like_this") {
        queryClient.setQueryData<NewsOverviewResponse>(newsQueryKeys.overview, (current) =>
          current ? withoutStory(current, targetRef, props.headline.id) : current
        );
      }
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.feedback });
      setReasonOpen(false);
      setReason("");
    }
  });

  function submitReason() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setValidationError("Tell us why before saving.");
      return;
    }
    setValidationError(null);
    mutation.mutate({ kind: "less_like_this", reason: trimmed });
  }

  return (
    <div className="nw-feedback" onClick={(event) => event.stopPropagation()}>
      <Menu
        triggerIcon={<MoreHorizontal size={15} aria-hidden="true" />}
        triggerLabel={`Feedback for ${props.headline.title}`}
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
          if (id === "less_like_this") setReasonOpen(true);
          else mutation.mutate({ kind: "more_like_this" });
        }}
      />
      {reasonOpen ? (
        <form
          className="nw-feedback__form"
          onSubmit={(event) => {
            event.preventDefault();
            submitReason();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setReasonOpen(false);
              setValidationError(null);
            }
          }}
        >
          <label htmlFor={reasonId}>Why less like this?</label>
          <textarea
            id={reasonId}
            value={reason}
            maxLength={500}
            autoFocus
            onChange={(event) => {
              setReason(event.target.value);
              setValidationError(null);
            }}
          />
          {validationError ? <span role="alert">{validationError}</span> : null}
          {mutation.isError ? <span role="alert">Could not save that feedback.</span> : null}
          <div className="nw-feedback__actions">
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                setReasonOpen(false);
                setValidationError(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
