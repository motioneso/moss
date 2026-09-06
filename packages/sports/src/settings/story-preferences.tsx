import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Note } from "@moss/settings-ui";
import type { UsefulnessFeedbackDto } from "@moss/shared";

import { sportsQueryKeys } from "../web/query-keys.js";
import {
  listSportsStoryFeedback,
  undoSportsStoryFeedback,
  updateSportsStoryFeedbackReason
} from "../web/sports-client.js";

const STORY_FEEDBACK_KEY = ["sports", "story-feedback"] as const;

function metadataText(feedback: UsefulnessFeedbackDto, key: string): string | null {
  const value = feedback.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function StoryPreferencesSection() {
  const queryClient = useQueryClient();
  const feedbackQuery = useQuery({
    queryKey: STORY_FEEDBACK_KEY,
    queryFn: listSportsStoryFeedback
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editReason, setEditReason] = useState("");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: STORY_FEEDBACK_KEY });
    void queryClient.invalidateQueries({ queryKey: sportsQueryKeys.overview });
  };
  const editMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      updateSportsStoryFeedbackReason(id, { reason }),
    onSuccess: () => {
      setEditingId(null);
      refresh();
    }
  });
  const undoMutation = useMutation({
    mutationFn: (id: string) => undoSportsStoryFeedback(id),
    onSuccess: refresh
  });
  const feedback = (feedbackQuery.data?.feedback ?? []).filter(
    (item) => item.targetKind === "sports_story"
  );

  // Nothing to manage yet: keep the whole section out of the pane (Ben, 2026-09-03).
  if (!feedbackQuery.isError && feedback.length === 0) {
    return null;
  }

  return (
    <section className="sp-feedback-settings" aria-label="Story preferences">
      <h2 className="jds-section-title sp-feedback-settings__title">Story preferences</h2>
      <p className="jds-section-sub sp-feedback-settings__note">
        A major story about a subject you asked to see less of may still appear.
      </p>
      {feedbackQuery.isError ? <Note>Could not load story preferences. Try again.</Note> : null}
      {feedbackQuery.isError ? null : (
        <div className="sp-feedback-settings__list">
          {feedback.map((item) => {
            const headline = metadataText(item, "headline") ?? "Saved story";
            const source = metadataText(item, "sourceLabel");
            const isEditing = editingId === item.id;
            return (
              <article className="sp-feedback-settings__row" key={item.id}>
                <div className="sp-feedback-settings__details">
                  <strong>{item.kind === "more_like_this" ? "More" : "Less"}</strong>
                  <span>{headline}</span>
                  {source ? <span>{source}</span> : null}
                  {item.reason ? <span>{item.reason}</span> : null}
                  <time dateTime={item.updatedAt}>
                    {new Date(item.updatedAt || item.createdAt).toLocaleDateString()}
                  </time>
                </div>
                {isEditing ? (
                  <div className="sp-feedback-settings__editor">
                    <textarea
                      aria-label={`Reason for ${headline}`}
                      value={editReason}
                      maxLength={500}
                      onChange={(event) => setEditReason(event.currentTarget.value)}
                    />
                    {editMutation.isError ? (
                      <span role="alert">Could not update this preference. Try again.</span>
                    ) : null}
                    <button
                      type="button"
                      disabled={editMutation.isPending || editReason.trim().length === 0}
                      onClick={() =>
                        editMutation.mutate({ id: item.id, reason: editReason.trim() })
                      }
                    >
                      Save
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="sp-feedback-settings__actions">
                    {item.kind === "less_like_this" ? (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(item.id);
                          setEditReason(item.reason ?? "");
                        }}
                      >
                        Edit reason
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={undoMutation.isPending}
                      onClick={() => undoMutation.mutate(item.id)}
                    >
                      Remove
                    </button>
                    {undoMutation.isError ? (
                      <span role="alert">Could not remove this preference. Try again.</span>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
