import { CalendarDays, CheckCircle2, Clock, Target } from "lucide-react";

import type { BriefingRunDto, LocaleSettingsDto } from "@moss/shared";
import { AgendaRow, Card, StatTile } from "@moss/ui";

import { EveningPrepCard, EveningReviewSection, type TodayMode } from "./evening-mode.js";
import { TodayQuickActions } from "./today-quick-actions.js";
import type { ColorMode } from "../theme/color-mode.js";
import { ampm, countdownLabel, timeLabel } from "./today-labels.js";

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
}

/** Today right rail: quick actions first, then the next meeting, then the
    rest of the base blocks in their base order. Props only, no fetching. */
export function TodayRail(props: TodayRailProps) {
  const { nextEvent } = props;
  return (
    <aside className="cmd-aside" aria-label="Quick actions and widgets">
      <div className="cmd-aside__inner">
        <TodayQuickActions
          enabled={props.wellnessEnabled}
          theme={props.theme}
          timeZone={props.timeZone}
          disabledModuleIds={props.disabledModuleIds}
        />

        {nextEvent ? (
          <div className="cmd-next">
            {props.mode === "day" ? (
              <>
                <div className="rail-block__head">First meeting</div>
                <div className="cmd-next__v">
                  {timeLabel(nextEvent.startsAt, props.locale)}{" "}
                  {ampm(nextEvent.startsAt, props.locale)}
                </div>
                <div className="cmd-next__what">{nextEvent.title}</div>
              </>
            ) : (
              <>
                <div className="rail-block__head">
                  {props.nextStarted ? "Now" : "First meeting"}
                </div>
                <div className="cmd-next__k">
                  {props.nextStarted ? "Now · ends in" : "Next event in"}
                </div>
                <div className="cmd-next__v">
                  {countdownLabel(
                    props.nextStarted ? nextEvent.endsAt : nextEvent.startsAt,
                    props.now
                  )}
                </div>
                <div className="cmd-next__what">
                  {nextEvent.title} · {timeLabel(nextEvent.startsAt, props.locale)}
                  {ampm(nextEvent.startsAt, props.locale)}
                </div>
              </>
            )}
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

        {props.showEveningPrep ? (
          <EveningPrepCard
            onPlan={props.onPlan}
            interviewPending={props.interviewPending}
            onPrep={props.onPrep}
          />
        ) : null}
      </div>
    </aside>
  );
}
