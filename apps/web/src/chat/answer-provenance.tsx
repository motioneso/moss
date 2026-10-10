import { MeetingSourceLink } from "./meeting-source-link";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useDialogLifecycle } from "@moss/ui";
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
  id?: string;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

export function SourceTray({ card, onClose, id, returnFocusRef }: SourceTrayProps) {
  const trayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onKeyDown = useDialogLifecycle({
    ref: trayRef,
    modal: false,
    onClose,
    initialFocusRef: closeRef,
    returnFocusRef
  });
  useEffect(() => {
    // Click runs after pointer focus has moved, so closing must not pull focus
    // away from the outside control the user chose. The opener owns its toggle.
    const closeOutside = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !trayRef.current?.contains(event.target) &&
        !returnFocusRef?.current?.contains(event.target)
      )
        onClose();
    };
    document.addEventListener("click", closeOutside);
    return () => document.removeEventListener("click", closeOutside);
  }, [onClose, returnFocusRef]);
  const locale = useUserLocale();
  const stateLabel = STATE_LABELS[card.state] ?? card.state;
  const icon = SOURCE_ICONS[card.sourceKind] ?? "◎";

  return (
    <div
      id={id}
      ref={trayRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="source-tray"
      role="dialog"
      aria-label={`Source: ${card.title}`}
    >
      <button
        ref={closeRef}
        type="button"
        className="source-tray__close"
        onClick={onClose}
        aria-label="Close source"
      >
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
  const trayId = useId();
  const openerRef = useRef<HTMLButtonElement>(null);

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
            <span key={card.supportId} role="listitem" style={{ minWidth: 0, maxWidth: "100%" }}>
              <button
                type="button"
                className={`source-chip source-chip--${card.sourceKind}`}
                onClick={(event) => {
                  openerRef.current = event.currentTarget;
                  setOpenId(openId === card.supportId ? null : card.supportId);
                }}
                aria-haspopup="dialog"
                aria-controls={openId === card.supportId ? trayId : undefined}
                aria-expanded={openId === card.supportId}
                aria-label={`${STATE_LABELS[card.state] ?? card.state}: ${card.title}`}
              >
                <span aria-hidden="true">{icon(card.sourceKind)}</span>
                <span className="source-chip__label">{card.sourceLabel}</span>
              </button>
            </span>
          )
        )}
      </div>
      {openCard && (
        <SourceTray
          key={openCard.supportId}
          id={trayId}
          card={openCard}
          returnFocusRef={openerRef}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
