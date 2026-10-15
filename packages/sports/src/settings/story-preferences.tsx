import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Note } from "@moss/settings-ui";
import { Button, Field, FormLabel, SectionHead } from "@moss/ui";
import type { UsefulnessFeedbackDto } from "@moss/shared";

import { formatDate, useUserLocale } from "../web/locale.js";
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
  const sectionId = useId();
  const queryClient = useQueryClient();
  const locale = useUserLocale();
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
    <section className="sp-feedback-settings" aria-labelledby={sectionId}>
      <SectionHead title="Story preferences" titleAs="h3" titleId={sectionId} />
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
            const reasonId = `${sectionId}-${item.id}-reason`;
            return (
              <article className="sp-feedback-settings__row" key={item.id}>
                <div className="sp-feedback-settings__details">
                  <strong className="jds-label">
                    {item.kind === "more_like_this" ? "More" : "Less"}
                  </strong>
                  <span className="jds-section-sub">{headline}</span>
                  {source ? <span className="jds-caption">{source}</span> : null}
                  {item.reason ? <span className="jds-section-sub">{item.reason}</span> : null}
                  <time className="jds-caption" dateTime={item.updatedAt}>
                    {formatDate(item.updatedAt || item.createdAt, locale)}
                  </time>
                </div>
                {isEditing ? (
                  <div className="sp-feedback-settings__editor">
                    <Field>
                      <FormLabel htmlFor={reasonId}>Reason for {headline}</FormLabel>
                      <textarea
                        id={reasonId}
                        className="jds-textarea"
                        value={editReason}
                        maxLength={500}
                        onChange={(event) => setEditReason(event.currentTarget.value)}
                      />
                    </Field>
                    {editMutation.isError ? (
                      <span className="jds-hint jds-hint--error" role="alert">
                        Could not update this preference. Try again.
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      disabled={editMutation.isPending || editReason.trim().length === 0}
                      onClick={() =>
                        editMutation.mutate({ id: item.id, reason: editReason.trim() })
                      }
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="sp-feedback-settings__actions">
                    {item.kind === "less_like_this" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setEditingId(item.id);
                          setEditReason(item.reason ?? "");
                        }}
                      >
                        Edit reason
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={undoMutation.isPending}
                      onClick={() => undoMutation.mutate(item.id)}
                    >
                      Remove
                    </Button>
                    {undoMutation.isError ? (
                      <span className="jds-hint jds-hint--error" role="alert">
                        Could not remove this preference. Try again.
                      </span>
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
