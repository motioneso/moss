import { useQuery } from "@tanstack/react-query";

import type { CalendarEventDto, GetDayPlanResponse, LocaleSettingsDto } from "@moss/shared";

import { Button } from "@moss/ui";

import { getCalendarBriefingSettings } from "../api/client.js";
import { ampm, eventCaptureText, timeLabel } from "./today-labels.js";
import { buildDayItems, type DayItem } from "./day-plan-view-model.js";

export interface DayPlanSectionProps {
  readonly dayPlan: GetDayPlanResponse | undefined;
  readonly events: readonly CalendarEventDto[];
  readonly locale: LocaleSettingsDto;
  readonly now: Date;
  readonly loading: boolean;
  readonly error: boolean;
  readonly calendarError: boolean;
  readonly onOpenTask: (taskId: string) => void;
  readonly onReview?: (anchor: HTMLElement) => void;
}

function ReviewButton(props: { readonly onReview: (anchor: HTMLElement) => void }) {
  const settingsQuery = useQuery({
    queryKey: ["calendar", "briefing-settings"],
    queryFn: getCalendarBriefingSettings,
    retry: false
  });
  const label =
    settingsQuery.data?.settings?.timeBlockMode === "auto"
      ? "Adjust task blocks"
      : "Review task blocks";
  return (
    <Button variant="secondary" onClick={(event) => props.onReview(event.currentTarget)}>
      {label}
    </Button>
  );
}

function durationText(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

function DayItemRow(props: {
  readonly item: DayItem;
  readonly locale: LocaleSettingsDto;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const { item } = props;
  if (item.eventId !== null) {
    return (
      <div
        className="day-ev"
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
        <div className="day-ev__t">
          {timeLabel(item.startsAt!, props.locale)}
          <span className="ap"> {ampm(item.startsAt!, props.locale)}</span>
        </div>
        <div>
          <div className="day-ev__title">{item.title}</div>
          {item.location ? <div className="day-ev__where">{item.location}</div> : null}
        </div>
        <div className="day-ev__who">{durationText(item.durationMinutes)}</div>
      </div>
    );
  }
  return (
    <div className="jds-task" key={item.key} data-state={item.state}>
      <div className="day-ev__t">
        {item.startsAt !== null ? (
          <>
            {timeLabel(item.startsAt, props.locale)}
            <span className="ap"> {ampm(item.startsAt, props.locale)}</span>
          </>
        ) : (
          "No time yet"
        )}
      </div>
      <div>
        {item.taskId !== null && !item.unavailable ? (
          <button
            type="button"
            className="jds-task__main"
            onClick={() => props.onOpenTask(item.taskId!)}
          >
            <div className="jds-task__title">{item.title}</div>
            <div className="jds-task__meta">
              {item.kindLabel !== null ? (
                <span className="jds-task__source">{item.kindLabel}</span>
              ) : null}
              <span className="jds-task__state">{item.label}</span>
            </div>
          </button>
        ) : (
          <div className="jds-task__main">
            <div className="jds-task__title">{item.title}</div>
            <div className="jds-task__meta">
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
      <div className="day-ev__who">{durationText(item.durationMinutes)}</div>
    </div>
  );
}

function SectionHead() {
  return (
    <>
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">Walking the day</span>
      </div>
      <div className="jds-brief__title">Schedule and preparation</div>
    </>
  );
}

/** Today schedule: the saved day plan merged with today's calendar events. */
export function DayPlanSection(props: DayPlanSectionProps) {
  if (props.loading) {
    if (props.events.length === 0) {
      return (
        <section className="jds-brief" id="schedule">
          <SectionHead />
          <div className="agenda-clear" role="status">
            Gathering your day plan…
          </div>
        </section>
      );
    }
    const loaded = buildDayItems({
      plan: null,
      tasks: [],
      unavailableTaskIds: [],
      events: props.events,
      locale: props.locale,
      now: props.now
    });
    return (
      <section className="jds-brief" id="schedule">
        <SectionHead />
        <div className="agenda-clear" role="status">
          Gathering your day plan…
        </div>
        <div className="day-list">
          {loaded.map((item) => (
            <DayItemRow
              key={item.key}
              item={item}
              locale={props.locale}
              onOpenTask={props.onOpenTask}
            />
          ))}
        </div>
      </section>
    );
  }

  if (props.calendarError && props.error) {
    return (
      <section className="jds-brief" id="schedule">
        <SectionHead />
        <p className="cmd-empty" role="status">
          Calendar and saved plan aren&apos;t available right now.
        </p>
      </section>
    );
  }

  const items = buildDayItems({
    plan: props.dayPlan?.plan ?? null,
    tasks: props.dayPlan?.tasks ?? [],
    unavailableTaskIds: props.dayPlan?.unavailableTaskIds ?? [],
    events: props.calendarError ? [] : props.events,
    locale: props.locale,
    now: props.now
  });

  const taskBlocks = (props.dayPlan?.plan?.blocks ?? []).filter((block) => block.taskId !== null);

  return (
    <section className="jds-brief" id="schedule">
      <SectionHead />
      {props.onReview && taskBlocks.length > 0 ? (
        <div className="day-review-open">
          <ReviewButton onReview={props.onReview} />
        </div>
      ) : null}
      {props.calendarError ? (
        <p className="cmd-empty" role="status">
          Calendar isn&apos;t available right now; showing your saved plan.
        </p>
      ) : props.error ? (
        <p className="cmd-empty" role="status">
          Saved plan unavailable; showing calendar events only
        </p>
      ) : null}
      {items.length === 0 ? (
        props.calendarError ? null : (
          <p className="cmd-empty">Nothing on the schedule yet.</p>
        )
      ) : (
        <div className="day-list">
          {items.map((item) => (
            <DayItemRow
              key={item.key}
              item={item}
              locale={props.locale}
              onOpenTask={props.onOpenTask}
            />
          ))}
        </div>
      )}
    </section>
  );
}
