import { CalendarDays, CheckCircle2, Clock, Target } from "lucide-react";

import type { BriefingRunDto, LocaleSettingsDto } from "@moss/shared";
import { AgendaRow, Card, StatTile } from "@moss/ui";

import type { CalendarEventDto, TaskDto } from "@moss/shared";

import { EveningReviewSection, EveningTomorrowSection, type TodayMode } from "./evening-mode.js";
import { TodayQuickActions } from "./today-quick-actions.js";
import type { ColorMode } from "../theme/color-mode.js";
import { ampm, timeLabel } from "./today-labels.js";

export interface RailAgendaRow {
  readonly id: string;
  readonly time: string;
  readonly title: string;
  readonly location: string | null;
}

export interface RailNextEvent {
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location?: string | null;
}

export interface TodayRailProps {
  readonly mode: TodayMode;
  readonly now: Date;
  readonly locale: LocaleSettingsDto;
  readonly nextEvent: RailNextEvent | null;
  readonly nextStarted: boolean;
  readonly hasStatSignal: boolean;
  readonly prioritiesCount: number;
  readonly atRiskCount: number;
  readonly eventsCount: number;
  readonly doneToday: number;
  readonly agenda: readonly RailAgendaRow[];
  readonly onNavigate: (path: string) => void;
  readonly showEveningReview: boolean;
  readonly showEveningPrep: boolean;
  readonly latestEveningRun: BriefingRunDto | null;
  readonly eveningRunsPending: boolean;
  readonly eveningTargetTime: string;
  readonly onEveningFeedback: () => void;
  readonly interviewPending: boolean;
  readonly onPrep: () => void;
  readonly onPlan: (anchor: HTMLElement) => void;
  readonly wellnessEnabled: boolean;
  readonly theme: ColorMode;
  readonly timeZone: string;
  readonly disabledModuleIds: readonly string[];
  readonly tomorrowLabel?: string;
  readonly tomorrowEvents?: readonly CalendarEventDto[];
  readonly tomorrowTasks?: readonly TaskDto[];
  readonly onOpenTask?: (taskId: string) => void;
}

type TodayDockProps = Pick<
  TodayRailProps,
  "wellnessEnabled" | "theme" | "timeZone" | "disabledModuleIds"
>;

/** Morning quick actions dock. It sits before the main column in the DOM, so
    phones read dock, day plan, then the rail; desktop places it atop the rail. */
export function TodayDock(props: TodayDockProps) {
  return (
    <section className="cmd-dock" aria-label="Quick actions">
      <TodayQuickActions
        enabled={props.wellnessEnabled}
        theme={props.theme}
        timeZone={props.timeZone}
        disabledModuleIds={props.disabledModuleIds}
      />
    </section>
  );
}

/** "30 minutes · Room 4": the first meeting's length and place. */
function meetingNote(event: RailNextEvent): string {
  const minutes = Math.max(
    0,
    Math.round((Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 60000)
  );
  const length =
    minutes % 60 === 0 && minutes > 0
      ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`
      : `${minutes} minutes`;
  return event.location ? `${length} · ${event.location}` : length;
}

/** Today right rail. Day: the next meeting, then glance, agenda and the
    evening review. Evening: tomorrow and the planning actions. Quick actions
    live in TodayDock in both modes. Props only, no fetching. */
export function TodayRail(props: TodayRailProps) {
  const { nextEvent } = props;
  const day = props.mode === "day";
  if (!day) {
    return (
      <aside className="cmd-aside" aria-label="Tomorrow and evening planning">
        <div className="cmd-aside__inner">
          {props.showEveningPrep ? (
            <EveningTomorrowSection
              dateLabel={props.tomorrowLabel ?? ""}
              events={props.tomorrowEvents ?? []}
              tasks={props.tomorrowTasks ?? []}
              locale={props.locale}
              interviewPending={props.interviewPending}
              onPlan={props.onPlan}
              onPrep={props.onPrep}
              onOpenTask={props.onOpenTask ?? (() => undefined)}
            />
          ) : null}
        </div>
      </aside>
    );
  }
  return (
    <aside className="cmd-aside" aria-label="Today widgets">
      <div className="cmd-aside__inner">
        {nextEvent ? (
          <div className="cmd-next">
            <div className="rail-block__head">First meeting</div>
            <div className="cmd-next__v">
              {timeLabel(nextEvent.startsAt, props.locale)}{" "}
              <small>{ampm(nextEvent.startsAt, props.locale)}</small>
            </div>
            <div className="cmd-next__what">{nextEvent.title}</div>
            <p className="cmd-next__note">{meetingNote(nextEvent)}</p>
            <button
              type="button"
              className="cmd-next__link"
              onClick={() => props.onNavigate("/calendar")}
            >
              Open in calendar ↗
            </button>
          </div>
        ) : null}

        {props.hasStatSignal ? (
          <div className="cmd-glance">
            <div className="cmd-glance__title">At a glance</div>
            <div className="cmd-glance__grid">
              <StatTile
                label="Priorities"
                value={props.prioritiesCount}
                icon={<Target size={12} aria-hidden="true" />}
                onClick={() => props.onNavigate("/tasks?focus=priorities")}
              />
              <StatTile
                label="At risk"
                value={props.atRiskCount}
                warn={props.atRiskCount > 0}
                icon={<Clock size={12} aria-hidden="true" />}
                onClick={() => props.onNavigate("/tasks?focus=atrisk")}
              />
              <StatTile
                label="Events"
                value={props.eventsCount}
                icon={<CalendarDays size={12} aria-hidden="true" />}
                onClick={() => props.onNavigate("/calendar")}
              />
              <StatTile
                label="Done today"
                value={props.doneToday}
                icon={<CheckCircle2 size={12} aria-hidden="true" />}
                onClick={() => props.onNavigate("/tasks?focus=donetoday")}
              />
            </div>
          </div>
        ) : null}

        <Card title="Today's agenda" meta={`${props.agenda.length} left`} padding="sm">
          {props.agenda.length > 0 ? (
            <div>
              {props.agenda.map((event, index) => (
                <AgendaRow
                  key={event.id}
                  time={event.time}
                  title={event.title}
                  location={event.location}
                  status={index === 0 ? "now" : "default"}
                />
              ))}
            </div>
          ) : (
            <div className="agenda-clear" role="status">
              Nothing left on the calendar today. <b>Enjoy the evening.</b>
            </div>
          )}
        </Card>

        {props.showEveningReview ? (
          <EveningReviewSection
            kind="compact"
            run={props.latestEveningRun}
            loading={props.eveningRunsPending}
            locale={props.locale}
            targetTime={props.eveningTargetTime}
            onFeedbackChanged={props.onEveningFeedback}
          />
        ) : null}
      </div>
    </aside>
  );
}
