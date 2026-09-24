import type { CalendarEventDto, LocaleSettingsDto } from "@moss/shared";

import { ampm, eventCaptureText, timeLabel } from "./today-labels.js";
import type { DayItem } from "./day-plan-view-model.js";

export function durationText(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Study meta wording: "45 min", "1 hour", "2 hours". */
export function blockLengthText(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "";
  if (minutes % 60 !== 0) return `${minutes} min`;
  return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
}

function MetaLength(props: { readonly minutes: number | null }) {
  const text = blockLengthText(props.minutes);
  if (text === "") return null;
  return (
    <>
      <span className="tl-meta-len">{text}</span>
      <span className="tl-meta-divider" aria-hidden="true">
        ·
      </span>
    </>
  );
}

/** Today-only timeline row: time column, rule with marker, block. Task
    rows keep their button, state label and data-state; events stay plain. */
export function TimelineRow(props: {
  readonly item: DayItem;
  readonly locale: LocaleSettingsDto;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const { item } = props;
  if (item.eventId !== null) {
    return (
      <div
        className="day-ev tl-slot tl-slot--event"
        key={item.key}
        data-jarvis-capture-text={eventCaptureText(
          {
            id: item.eventId,
            startsAt: item.startsAt!,
            endsAt: item.endsAt ?? item.startsAt!,
            title: item.title,
            location: item.location
          } as CalendarEventDto,
          props.locale
        )}
      >
        <TimelineTime item={item} locale={props.locale} />
        <div className="tl-body">
          <div className="tl-block">
            <div className="day-ev__title">{item.title}</div>
            {item.location || blockLengthText(item.durationMinutes) ? (
              <div className="day-ev__where">
                {[blockLengthText(item.durationMinutes), item.location].filter(Boolean).join(" · ")}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className={`jds-task tl-slot tl-slot--${item.state}`}
      key={item.key}
      data-state={item.state}
    >
      <TimelineTime item={item} locale={props.locale} />
      <div className="tl-body">
        {item.taskId !== null && !item.unavailable ? (
          <button
            type="button"
            className="jds-task__main"
            onClick={() => props.onOpenTask(item.taskId!)}
          >
            <div className={`jds-task__title${item.state === "completed" ? " tl-done" : ""}`}>
              {item.title}
            </div>
            <div className="jds-task__meta">
              <MetaLength minutes={item.durationMinutes} />
              {item.kindLabel !== null ? (
                <span className="jds-task__source">{item.kindLabel}</span>
              ) : null}
              <span className="jds-task__state">{item.label}</span>
            </div>
          </button>
        ) : (
          <div className="jds-task__main">
            <div className={`jds-task__title${item.state === "completed" ? " tl-done" : ""}`}>
              {item.title}
            </div>
            <div className="jds-task__meta">
              <MetaLength minutes={item.durationMinutes} />
              {item.kindLabel !== null ? (
                <span className="jds-task__source">{item.kindLabel}</span>
              ) : null}
              <span className="jds-task__state">{item.label}</span>
              {item.unavailable ? (
                <span className="jds-task__source">Task no longer visible</span>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function TimelineLegend(props: { readonly proposed?: boolean }) {
  return (
    <div className="tl-legend">
      <span>
        <i className="tl-legend__filled" aria-hidden="true" />
        {props.proposed === true ? "Proposed task" : "Moss-planned task"}
      </span>
      <span>
        <i className="tl-legend__open" aria-hidden="true" />
        Calendar commitment
      </span>
    </div>
  );
}

/** End time for the timeline's small line: events carry endsAt, task blocks
    carry only a start plus a duration. */
function rowEndAt(item: DayItem): string | null {
  if (item.endsAt !== null) return item.endsAt;
  if (item.startsAt !== null && item.durationMinutes !== null && item.durationMinutes > 0) {
    return new Date(Date.parse(item.startsAt) + item.durationMinutes * 60000).toISOString();
  }
  return null;
}

function TimelineTime(props: { readonly item: DayItem; readonly locale: LocaleSettingsDto }) {
  const { item } = props;
  const endAt = rowEndAt(item);
  return (
    <div className="day-ev__t tl-time">
      {item.startsAt !== null ? (
        <>
          {timeLabel(item.startsAt, props.locale)}
          <span className="ap"> {ampm(item.startsAt, props.locale)}</span>
        </>
      ) : (
        "No time yet"
      )}
      {endAt !== null ? (
        <small>
          {timeLabel(endAt, props.locale)}
          <span className="ap"> {ampm(endAt, props.locale)}</span>
        </small>
      ) : item.durationMinutes !== null && item.durationMinutes > 0 ? (
        <small>{durationText(item.durationMinutes)}</small>
      ) : null}
    </div>
  );
}

function compactTime(iso: string, locale: LocaleSettingsDto): string {
  return `${timeLabel(iso, locale)}${ampm(iso, locale)}`;
}

/** Morning reader rail row: start time, then title over "end · state".
    Task rows keep their button and data-state; events stay plain. */
export function SnapshotRow(props: {
  readonly item: DayItem;
  readonly locale: LocaleSettingsDto;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const { item } = props;
  const endAt = rowEndAt(item);
  const endText = endAt !== null ? compactTime(endAt, props.locale) : null;
  const start = item.startsAt !== null ? compactTime(item.startsAt, props.locale) : "No time yet";
  if (item.eventId !== null) {
    return (
      <div
        className="day-ev brief-snapshot__row"
        key={item.key}
        data-jarvis-capture-text={eventCaptureText(
          {
            id: item.eventId,
            startsAt: item.startsAt!,
            endsAt: item.endsAt ?? item.startsAt!,
            title: item.title,
            location: item.location
          } as CalendarEventDto,
          props.locale
        )}
      >
        <span className="brief-snapshot__time">{start}</span>
        <div className="brief-snapshot__main">
          <span className="day-ev__title">{item.title}</span>
          <small>{[endText, "Calendar"].filter(Boolean).join(" · ")}</small>
        </div>
      </div>
    );
  }

  // The reader's short caption already leads with the end time.
  const meta = item.label.includes(" · ")
    ? item.label
    : [endText, item.label].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className={`jds-task__title${item.state === "completed" ? " tl-done" : ""}`}>
        {item.title}
      </span>
      <small className="jds-task__state">
        {meta}
        {item.unavailable ? " · Task no longer visible" : null}
      </small>
    </>
  );
  return (
    <div
      className="jds-task brief-snapshot__row brief-snapshot__row--task"
      key={item.key}
      data-state={item.state}
    >
      <span className="brief-snapshot__time">{start}</span>
      {item.taskId !== null && !item.unavailable ? (
        <button
          type="button"
          className="brief-snapshot__main"
          onClick={() => props.onOpenTask(item.taskId!)}
        >
          {body}
        </button>
      ) : (
        <div className="brief-snapshot__main">{body}</div>
      )}
    </div>
  );
}
