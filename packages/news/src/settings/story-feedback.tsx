import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ListUsefulnessFeedbackResponse, UsefulnessFeedbackDto } from "@moss/shared";

import { Button } from "@moss/module-web-sdk";
import { formatTimestamp, Note, useUserLocale } from "@moss/settings-ui";

import { newsQueryKeys } from "../web/query-keys.js";
import {
  listNewsStoryFeedback,
  removeNewsStoryFeedback,
  updateNewsStoryFeedback
} from "../web/story-feedback-client.js";
import { clearStoryDismissed } from "../web/dismissed-story-tracker.js";

function text(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function StoryFeedbackRow({
  feedback,
  onNotice
}: {
  readonly feedback: UsefulnessFeedbackDto;
  readonly onNotice: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const locale = useUserLocale();
  const [editing, setEditing] = useState<string | null>(null);
  const headline = text(feedback.metadata, "headline") ?? "News story";
  const source = feedback.sourceLabel ?? text(feedback.metadata, "sourceLabel");
  const beginWrite = async () => {
    onNotice(null);
    await queryClient.cancelQueries({ queryKey: newsQueryKeys.feedback });
  };
  const updateMutation = useMutation({
    mutationFn: (reason: string) => updateNewsStoryFeedback(feedback.id, { reason }),
    onMutate: beginWrite,
    onSuccess: (result) => {
      queryClient.setQueryData<ListUsefulnessFeedbackResponse>(newsQueryKeys.feedback, (current) =>
        current
          ? {
              feedback: current.feedback.map((item) =>
                item.id === feedback.id ? result.feedback : item
              )
            }
          : current
      );
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.feedback });
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.overview });
      setEditing(null);
      onNotice(`Reason saved for ${headline}.`);
    }
  });
  const removeMutation = useMutation({
    mutationFn: () => removeNewsStoryFeedback(feedback.id),
    onMutate: beginWrite,
    onSuccess: () => {
      if (feedback.kind === "less_like_this") {
        clearStoryDismissed(feedback.targetRef);
      }
      queryClient.setQueryData<ListUsefulnessFeedbackResponse>(newsQueryKeys.feedback, (current) =>
        current ? { feedback: current.feedback.filter((item) => item.id !== feedback.id) } : current
      );
      onNotice(`Preference removed for ${headline}.`);
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.feedback });
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.overview });
    }
  });
  const pending = updateMutation.isPending || removeMutation.isPending;

  return (
    <li className="nw-set__feedback-item">
      <div>
        <strong>{headline}</strong>
        <div className="nw-set__item-meta">
          {source ?? "Unknown source"} ·{" "}
          {feedback.kind === "less_like_this" ? "Less like this" : "More like this"}
        </div>
        <div className="nw-set__item-meta">
          {formatTimestamp(feedback.updatedAt, "Date unavailable", locale)}
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
              if (reason && !pending) updateMutation.mutate(reason);
            }}
          >
            <label htmlFor={`news-feedback-${feedback.id}`}>Reason</label>
            <textarea
              id={`news-feedback-${feedback.id}`}
              value={editing}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setEditing(event.target.value)}
            />
            <div className="nw-set__addrow">
              <Button type="submit" size="sm" disabled={pending || !editing.trim()}>
                {updateMutation.isPending ? "Saving reason…" : "Save reason"}
              </Button>
              <Button variant="quiet" size="sm" disabled={pending} onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )
      ) : null}
      <div className="nw-set__feedback-actions">
        {feedback.kind === "less_like_this" && editing === null ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => {
              updateMutation.reset();
              removeMutation.reset();
              onNotice(null);
              setEditing(feedback.reason ?? "");
            }}
          >
            Edit reason
          </Button>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (!pending) removeMutation.mutate();
          }}
        >
          {removeMutation.isPending ? "Removing…" : "Remove"}
        </Button>
      </div>
      {pending ? (
        <p className="nw-set__exstatus" role="status">
          {updateMutation.isPending ? "Saving reason…" : "Removing preference…"}
        </p>
      ) : null}
      {updateMutation.isError ? (
        <p className="nw-set__exerr" role="alert">
          Could not save that reason. Try again.
        </p>
      ) : null}
      {removeMutation.isError ? (
        <p className="nw-set__exerr" role="alert">
          Could not remove that preference. Try again.
        </p>
      ) : null}
    </li>
  );
}

export function StoryFeedbackSettings() {
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: newsQueryKeys.feedback,
    queryFn: listNewsStoryFeedback
  });
  const feedback = (query.data?.feedback ?? []).filter((item) => item.status === "active");

  // Nothing to manage yet: keep the whole section out of the pane, matching Sports.
  if (feedback.length === 0 && !notice && !query.isError) {
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
      {notice ? (
        <p className="nw-set__exstatus" role="status">
          {notice}
        </p>
      ) : null}
      {query.isError ? (
        <Note>
          Could not load your News feedback.{" "}
          <Button
            variant="quiet"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry feedback
          </Button>
        </Note>
      ) : null}
      <ul className="nw-set__list">
        {feedback.map((item) => (
          <StoryFeedbackRow key={item.id} feedback={item} onNotice={setNotice} />
        ))}
      </ul>
    </section>
  );
}
