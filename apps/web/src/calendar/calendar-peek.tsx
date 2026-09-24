import { CalendarCheck, Clock, GitCommitHorizontal, MapPin, Users, X } from "lucide-react";
import { CategoryDot, HeldBanner, PeekCloseButton, PeekPanel } from "@moss/ui";
import { useAssistantName } from "../api/use-assistant-name.js";
import { fmtDateLabel, fmtDur, fmtTime, type CalendarViewEvent } from "./calendar-model.js";

interface CalendarPeekProps {
  readonly event: CalendarViewEvent | null;
  readonly onClose: () => void;
}

export function CalendarPeek({ event, onClose }: CalendarPeekProps) {
  const assistantName = useAssistantName();
  if (!event) return null;
  const isBlock = event.kind === "block";
  const isTentative = event.status === "needsAction" || event.status === "tentative";
  const evColor = isBlock ? "var(--accent-fg)" : "var(--steel)";

  return (
    <>
      <div className="cal-peek-scrim" onClick={onClose} />
      <PeekPanel aria-label="Event details">
        <div className="cal-peek__head">
          {isBlock ? (
            <span className="cal-peek__kind cal-peek__kind--block">
              <GitCommitHorizontal size={13} />
              {assistantName} is holding this
            </span>
          ) : (
            <span className="cal-peek__kind">
              <CalendarCheck size={13} />
              {isTentative ? "Awaiting RSVP" : "On your calendar"}
            </span>
          )}
          <PeekCloseButton aria-label="Close" onClick={onClose}>
            <X size={17} />
          </PeekCloseButton>
        </div>
        <div className="cal-peek__titlewrap">
          <span className="cal-peek__mark" style={{ "--ev": evColor } as React.CSSProperties}>
            {isBlock ? <GitCommitHorizontal size={18} /> : <CalendarCheck size={18} />}
          </span>
          <h3 className="cal-peek__title">{event.title}</h3>
        </div>
        <div className="cal-peek__rows">
          <div className="cal-peek__row">
            <span className="ic">
              <Clock size={15} />
            </span>
            <div>
              <div className="cal-peek__rowmain">
                {event.allDay ? "All day" : fmtTime(event.startMin) + " – " + fmtTime(event.endMin)}
                {!event.allDay ? (
                  <span className="cal-peek__dur"> · {fmtDur(event.endMin - event.startMin)}</span>
                ) : null}
              </div>
              <div className="cal-peek__rowsub">{fmtDateLabel(event.date)}</div>
            </div>
          </div>
          {event.where ? (
            <div className="cal-peek__row">
              <span className="ic">
                <MapPin size={15} />
              </span>
              <div className="cal-peek__rowmain">{event.where}</div>
            </div>
          ) : null}
          {event.attendeeCount > 0 ? (
            <div className="cal-peek__row">
              <span className="ic">
                <Users size={15} />
              </span>
              <div className="cal-peek__rowmain">
                {event.attendeeCount} {event.attendeeCount === 1 ? "person" : "people"}
              </div>
            </div>
          ) : null}
          <div className="cal-peek__row">
            <span className="ic" style={{ paddingTop: 2 }}>
              <CategoryDot color={evColor} />
            </span>
            <div className="cal-peek__rowmain">
              {isBlock ? `${assistantName} focus block` : isTentative ? "Pending RSVP" : "Accepted"}
            </div>
          </div>
        </div>
        {isBlock ? (
          <HeldBanner icon={<GitCommitHorizontal size={14} />}>
            {assistantName} can move or shorten this block when your day changes. Hard events always
            come first.
          </HeldBanner>
        ) : null}
      </PeekPanel>
    </>
  );
}
