import type { BriefingRunDto, LocaleSettingsDto } from "@moss/shared";
import type { CalendarEventDto, TaskDto } from "@moss/shared";

import { EveningReviewSection, EveningTomorrowSection, type TodayMode } from "./evening-mode.js";
import { TodayQuickActions } from "./today-quick-actions.js";
import type { ColorMode } from "../theme/color-mode.js";
import { ampm, timeLabel } from "./today-labels.js";
import type { ChangedBriefingBlock } from "./briefing-callout.js";
import { SinceLastNight } from "./since-last-night.js";
import { PracticalNote } from "./practical-note.js";

export interface RailNextEvent {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location?: string | null;
}

const PREPARATION_TITLE = /\bprep(are|aration)?\b/i;

/** A real, adjacent, self-declared preparation block's length in minutes, or
    null when nothing backs one. A Moss block touching the meeting's start is
    not itself evidence of preparation - only its own title says what it is
    for. */
export function preparationBlockMinutes(
  nextEvent: RailNextEvent,
  precedingEvents: readonly CalendarEventDto[]
): number | null {
  const block = precedingEvents.find(
    (event) =>
      event.isMossBlock &&
      event.endsAt === nextEvent.startsAt &&
      PREPARATION_TITLE.test(event.title)
  );
  if (!block) return null;
  return Math.max(0, Math.round((Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 60000));
}

/** "You have a 30-minute preparation block before this meeting." */
function preparationNote(minutes: number): string {
  const length =
    minutes % 60 === 0 && minutes > 0
      ? `${minutes / 60}-${minutes === 60 ? "hour" : "hours"}`
      : `${minutes}-minute`;
  return `You have a ${length} preparation block before this meeting.`;
}

export interface TodayRailProps {
  readonly mode: TodayMode;
  readonly now: Date;
  readonly locale: LocaleSettingsDto;
  readonly nextEvent: RailNextEvent | null;
  readonly precedingEvents: readonly CalendarEventDto[];
  readonly nextStarted: boolean;
  readonly changedSinceLastNight: readonly ChangedBriefingBlock[];
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

/** Today right rail. Day: the next meeting, what moved since last night, a practical
    note and the evening review. Evening: tomorrow and the planning actions. Quick actions
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
            {(() => {
              const minutes = preparationBlockMinutes(nextEvent, props.precedingEvents);
              return minutes === null ? null : (
                <p className="cmd-next__note">{preparationNote(minutes)}</p>
              );
            })()}
            <button
              type="button"
              className="cmd-next__link"
              onClick={() =>
                props.onNavigate(`/calendar?event=${encodeURIComponent(nextEvent.id)}`)
              }
            >
              See meeting ↗
            </button>
          </div>
        ) : null}

        <SinceLastNight changed={props.changedSinceLastNight} locale={props.locale} />

        <PracticalNote
          events={props.precedingEvents}
          now={props.now}
          excludeEventId={nextEvent?.id ?? null}
          locale={props.locale}
        />

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
