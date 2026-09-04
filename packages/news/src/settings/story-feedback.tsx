import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { UsefulnessFeedbackDto } from "@moss/shared";

import { Button } from "@moss/module-web-sdk";
import { formatTimestamp, Note } from "@moss/settings-ui";

import { newsQueryKeys } from "../web/query-keys.js";
import {
  listNewsStoryFeedback,
  removeNewsStoryFeedback,
  updateNewsStoryFeedback
} from "../web/story-feedback-client.js";

function text(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function StoryFeedbackRow({ feedback }: { readonly feedback: UsefulnessFeedbackDto }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const updateMutation = useMutation({
    mutationFn: (reason: string) => updateNewsStoryFeedback(feedback.id, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.feedback });
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.overview });
      setEditing(null);
    }
  });
  const removeMutation = useMutation({
    mutationFn: () => removeNewsStoryFeedback(feedback.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.feedback });
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.overview });
    }
  });
  const headline = text(feedback.metadata, "headline") ?? "News story";
  const source = feedback.sourceLabel ?? text(feedback.metadata, "sourceLabel");

  return (
    <li className="nw-set__feedback-item">
      <div>
        <strong>{headline}</strong>
        <div className="nw-set__item-meta">
          {source ?? "Unknown source"} ·{" "}
          {feedback.kind === "less_like_this" ? "Less like this" : "More like this"}
        </div>
        <div className="nw-set__item-meta">
          {formatTimestamp(feedback.updatedAt, "Date unavailable")}
        </div>
      </div>
      {feedback.kind === "less_like_this" ? (
        editing === null ? (
          <div className="nw-set__feedback-reason">{feedback.reason}</div>
        ) : (
          <form
            className="nw-set__feedback-edit"
            onSubmit={(event) => {
              event.preventDefault();
              const reason = editing.trim();
              if (reason) updateMutation.mutate(reason);
            }}
          >
            <label htmlFor={`news-feedback-${feedback.id}`}>Reason</label>
            <textarea
              id={`news-feedback-${feedback.id}`}
              value={editing}
              maxLength={500}
              onChange={(event) => setEditing(event.target.value)}
            />
            <div className="nw-set__addrow">
              <Button
                type="submit"
                size="sm"
                disabled={updateMutation.isPending || !editing.trim()}
              >
                Save reason
              </Button>
              <Button variant="quiet" size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )
      ) : null}
      <div className="nw-set__feedback-actions">
        {feedback.kind === "less_like_this" && editing === null ? (
          <Button variant="secondary" size="sm" onClick={() => setEditing(feedback.reason ?? "")}>
            Edit reason
          </Button>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          disabled={removeMutation.isPending}
          onClick={() => removeMutation.mutate()}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

export function StoryFeedbackSettings() {
  const query = useQuery({
    queryKey: newsQueryKeys.feedback,
    queryFn: listNewsStoryFeedback
  });
  if (query.isPending) return null;
  if (query.isError) return <Note>Could not load your News feedback.</Note>;
  const feedback = query.data.feedback.filter((item) => item.status === "active");

  // Nothing to manage yet: keep the whole section out of the pane, matching Sports.
  if (feedback.length === 0) {
    return null;
  }

  return (
    <section className="nw-set" aria-label="Story preferences">
      <div className="nw-set__head">
        <h2 className="jds-section-title">Story preferences</h2>
        <p className="jds-section-sub">
          What shapes your News: major stories about subjects you asked to see less of may still
          appear.
        </p>
      </div>
      <ul className="nw-set__list">
        {feedback.map((item) => (
          <StoryFeedbackRow key={item.id} feedback={item} />
        ))}
      </ul>
    </section>
  );
}
