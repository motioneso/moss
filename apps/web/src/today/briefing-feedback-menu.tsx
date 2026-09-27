import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import type { UsefulnessFeedbackDto, UsefulnessFeedbackKind } from "@moss/shared";
import { Menu } from "@moss/ui";

import { queryKeys } from "../api/query-keys.js";
import {
  createUsefulnessFeedback,
  undoUsefulnessFeedback
} from "../api/usefulness-feedback-client.js";

type BriefingRunFeedbackKind = Extract<
  UsefulnessFeedbackKind,
  "more_like_this" | "too_much" | "not_useful" | "dismiss"
>;

// Shared create/undo mutations for both the compact "…" menu and the inline
// Useful / Not useful control on the primary evening card (issue: broken evening
// review — the "…" disclosure was undiscoverable and read as an orphaned chip).
function useBriefingFeedback(props: {
  readonly targetRef: string;
  readonly onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [last, setLast] = useState<UsefulnessFeedbackDto | null>(null);
  const createMutation = useMutation({
    mutationFn: (kind: BriefingRunFeedbackKind) =>
      createUsefulnessFeedback({
        targetKind: "briefing_run",
        targetRef: props.targetRef,
        surface: "briefing",
        kind
      }),
    onSuccess: (response) => {
      setLast(response.feedback);
      props.onChanged();
      void queryClient.invalidateQueries({ queryKey: queryKeys.usefulnessFeedback.list });
    }
  });
  const undoMutation = useMutation({
    mutationFn: (id: string) => undoUsefulnessFeedback(id),
    onSuccess: () => {
      setLast(null);
      props.onChanged();
      void queryClient.invalidateQueries({ queryKey: queryKeys.usefulnessFeedback.list });
    }
  });
  return { last, createMutation, undoMutation };
}

export function BriefingFeedbackMenu(props: {
  readonly targetRef: string;
  readonly onChanged: () => void;
}) {
  const { last, createMutation, undoMutation } = useBriefingFeedback(props);

  return (
    <div className="today-feedback">
      <Menu
        triggerIcon={<MoreHorizontal size={14} aria-hidden="true" />}
        triggerLabel="Feedback"
        items={[
          {
            id: "more_like_this",
            label: "More like this",
            icon: <ThumbsUp size={13} aria-hidden="true" />,
            disabled: createMutation.isPending
          },
          { id: "too_much", label: "Too much", disabled: createMutation.isPending },
          {
            id: "not_useful",
            label: "Not useful",
            icon: <ThumbsDown size={13} aria-hidden="true" />,
            disabled: createMutation.isPending
          },
          { id: "dismiss", label: "Dismiss", disabled: createMutation.isPending }
        ]}
        onSelect={(id) => createMutation.mutate(id as BriefingRunFeedbackKind)}
      />
      {last ? (
        <span className="today-feedback__status">
          Saved
          <button
            type="button"
            onClick={() => undoMutation.mutate(last.id)}
            disabled={undoMutation.isPending}
          >
            Undo
          </button>
        </span>
      ) : null}
    </div>
  );
}
