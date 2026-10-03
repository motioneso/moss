import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, X } from "lucide-react";

import { IconButton } from "@moss/ui";

import type { ProactiveCardDto } from "@moss/shared";

import { getProactiveCards } from "../api/client";
import { createUsefulnessFeedback } from "../api/usefulness-feedback-client";
import { queryKeys } from "../api/query-keys";

const SOURCE_LABEL: Record<string, string> = {
  tasks: "Tasks",
  calendar: "Calendar",
  email: "Email",
  notes: "Notes"
};

export function ProactiveCards() {
  const queryClient = useQueryClient();
  const cardsQuery = useQuery({
    queryKey: queryKeys.proactiveMonitoring.cards,
    queryFn: getProactiveCards
  });

  const dismissMutation = useMutation({
    mutationFn: (cardId: string) =>
      createUsefulnessFeedback({
        targetKind: "proactive_card",
        targetRef: cardId,
        surface: "proactive",
        kind: "dismiss"
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.proactiveMonitoring.cards });
    }
  });

  const cards = (cardsQuery.data?.cards ?? []).filter((c) => c.status === "active");

  if (cardsQuery.isPending || cards.length === 0) return null;

  return (
    <section className="jds-brief" aria-label="Proactive monitoring">
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">
          <Bell size={12} aria-hidden="true" style={{ marginRight: 4 }} />
          On your radar
        </span>
      </div>
      <div className="jds-brief__title">Things worth your attention</div>
      <div className="top3" style={{ marginTop: 4 }}>
        {cards.map((card) => (
          <ProactiveCardRow
            key={card.id}
            card={card}
            onDismiss={() => dismissMutation.mutate(card.id)}
            isDismissing={dismissMutation.isPending && dismissMutation.variables === card.id}
          />
        ))}
      </div>
    </section>
  );
}

function ProactiveCardRow(props: {
  readonly card: ProactiveCardDto;
  readonly onDismiss: () => void;
  readonly isDismissing: boolean;
}) {
  const { card } = props;
  const sourceLabel = SOURCE_LABEL[card.source] ?? card.source;

  return (
    <div className="jds-task jds-task--p2">
      <span className="jds-task__prio" />
      <div className="jds-task__main">
        <div className="jds-task__title">{card.title}</div>
        <div className="jds-task__meta">
          <span className="jds-task__source">{sourceLabel}</span>
          {card.summary ? <span className="jds-task__time">{card.summary}</span> : null}
        </div>
      </div>
      <IconButton
        size="sm"
        aria-label={`Dismiss: ${card.title}`}
        disabled={props.isDismissing}
        onClick={props.onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </IconButton>
    </div>
  );
}
