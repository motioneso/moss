import { MeetingSourceLink } from "./meeting-source-link";
import { useState } from "react";
import type { AnswerSourceSupportCard } from "@moss/shared";
import { formatDate, useUserLocale } from "../locale/locale-format";

/** Matches [[S1]] through [[S99]] — same regex as backend. */
const MARKER_RE = /\[\[S(\d{1,2})\]\]/g;

export function stripDisplayMarkers(text: string, validIds: ReadonlySet<string>): string {
  return text.replace(MARKER_RE, (match, digits) => {
    const id = `S${parseInt(digits, 10)}`;
    return validIds.has(id) ? "" : match;
  });
}

const STATE_LABELS: Record<string, string> = {
  confirmed_source: "Source",
  inferred_memory: "Inferred memory",
  pending_candidate: "Pending review",
  ambiguous_identity: "Ambiguous person",
  unverified_context: "Context checked"
};

const SOURCE_ICONS: Record<string, string> = {
  email: "✉",
  calendar: "📅",
  note: "📝",
  task: "✓",
  memory: "◎",
  commitment: "⟳",
  person: "⚇",
  goal: "◎",
  briefing: "◎"
};

interface SourceTrayProps {
  card: AnswerSourceSupportCard;
  onClose: () => void;
}

export function SourceTray({ card, onClose }: SourceTrayProps) {
  const locale = useUserLocale();
  const stateLabel = STATE_LABELS[card.state] ?? card.state;
  const icon = SOURCE_ICONS[card.sourceKind] ?? "◎";

  return (
    <div className="source-tray" role="dialog" aria-label={`Source: ${card.title}`}>
      <button className="source-tray__close" onClick={onClose} aria-label="Close source">
        ×
      </button>
      <div className="source-tray__kind">
        <span aria-hidden="true">{icon}</span> {card.sourceKind}
      </div>
      <div className="source-tray__label">{card.sourceLabel}</div>
      <div className="source-tray__title">{card.title}</div>
      <div className="source-tray__state">{stateLabel}</div>
      {card.confidenceTier && <div className="source-tray__confidence">{card.confidenceTier}</div>}
      {card.occurredAt && (
        <time className="source-tray__time" dateTime={card.occurredAt}>
          {formatDate(card.occurredAt, locale)}
        </time>
      )}
      {card.snippet && <p className="source-tray__snippet">{card.snippet}</p>}
    </div>
  );
}

interface SourceChipsProps {
  messageId?: string;
  cards: readonly AnswerSourceSupportCard[];
  citedIds?: readonly string[];
}

export function SourceChips({ cards, citedIds, messageId }: SourceChipsProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  const citedSet = new Set(citedIds ?? []);
  const visibleCards = citedIds != null ? cards.filter((c) => citedSet.has(c.supportId)) : cards;

  if (visibleCards.length === 0) return null;

  const openCard = openId != null ? cards.find((c) => c.supportId === openId) : null;
  const icon = (kind: string) => SOURCE_ICONS[kind] ?? "◎";

  return (
    <div className="source-chips">
      <div className="source-chips__row" role="list">
        {visibleCards.map((card) =>
          card.sourceKind === "meeting" ? (
            <MeetingSourceLink key={card.supportId} card={card} messageId={messageId} />
          ) : (
            <button
              key={card.supportId}
              role="listitem"
              className={`source-chip source-chip--${card.sourceKind}`}
              onClick={() => setOpenId(openId === card.supportId ? null : card.supportId)}
              aria-expanded={openId === card.supportId}
              aria-label={`${STATE_LABELS[card.state] ?? card.state}: ${card.title}`}
            >
              <span aria-hidden="true">{icon(card.sourceKind)}</span>
              <span className="source-chip__label">{card.sourceLabel}</span>
            </button>
          )
        )}
      </div>
      {openCard && <SourceTray card={openCard} onClose={() => setOpenId(null)} />}
    </div>
  );
}
