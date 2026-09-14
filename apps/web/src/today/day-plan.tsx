import type { CalendarEventDto, GetDayPlanResponse, LocaleSettingsDto } from "@moss/shared";

import { ampm, eventCaptureText, timeLabel } from "./today-labels.js";
import { buildDayItems } from "./day-plan-view-model.js";

export interface DayPlanSectionProps {
  readonly dayPlan: GetDayPlanResponse | undefined;
  readonly events: readonly CalendarEventDto[];
  readonly locale: LocaleSettingsDto;
  readonly now: Date;
  readonly loading: boolean;
  readonly error: boolean;
  readonly onOpenTask: (taskId: string) => void;
}

function durationText(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Today schedule: the saved day plan merged with today's calendar events. */
export function DayPlanSection(props: DayPlanSectionProps) {
  if (props.loading) {
    return (
      <section className="jds-brief" id="schedule">
        <div className="jds-brief__head">
          <span className="jds-brief__kicker">Walking the day</span>
        </div>
        <div className="jds-brief__title">Schedule and preparation</div>
        <div className="agenda-clear">Gathering your day plan…</div>
      </section>
    );
  }

  const items = buildDayItems({
    plan: props.dayPlan?.plan ?? null,
    tasks: props.dayPlan?.tasks ?? [],
    unavailableTaskIds: props.dayPlan?.unavailableTaskIds ?? [],
    events: props.events,
    locale: props.locale,
    now: props.now
  });

  return (
    <section className="jds-brief" id="schedule">
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">Walking the day</span>
      </div>
      <div className="jds-brief__title">Schedule and preparation</div>
      {props.error ? (
        <p className="cmd-empty">Saved plan unavailable; showing calendar events only</p>
      ) : null}
      {items.length === 0 ? (
        <p className="cmd-empty">Nothing on the schedule yet.</p>
      ) : (
        <div className="day-list">
          {items.map((item) =>
            item.eventId !== null ? (
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
            ) : (
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
            )
          )}
        </div>
      )}
    </section>
  );
}
