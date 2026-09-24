import {
  localDay,
  type BriefingDefinitionDto,
  type BriefingRunDto,
  type CalendarEventDto,
  type LocaleSettingsDto,
  type TaskDto
} from "@moss/shared";
import { Check } from "lucide-react";

import { Card } from "@moss/ui";

import { useAssistantName } from "../api/use-assistant-name";
import { targetTimeFor } from "../briefings/briefing-settings-model";
import {
  DEFAULT_LOCALE,
  formatDate,
  formatTime,
  isValidTimeZone,
  zonedClockParts,
  zonedClockMinutes
} from "../locale/locale-format";
import { BriefingFeedbackMenu } from "./briefing-feedback-menu";
import { BriefingStaleBanner, parseBriefingFreshness } from "./briefing-freshness";
import {
  EVENING_OPEN_LOOPS_EMPTY,
  EVENING_OPEN_LOOPS_HEADING,
  EVENING_RECAP_HEADING,
  EVENING_RAIL_HEADING,
  EVENING_RECAP_KICKER,
  eventCaptureText,
  joinClauses,
  PLAN_TOMORROW_LABEL
} from "./today-labels";

export type TodayMode = "day" | "evening";

export function deriveTodayMode(
  eveningDefinition: BriefingDefinitionDto | undefined,
  locale: LocaleSettingsDto,
  now: Date = new Date(Date.now())
): TodayMode {
  if (!eveningDefinition?.enabled) return "day";
  const targetMinutes = parseTargetMinutes(targetTimeFor(eveningDefinition, "evening")) ?? 19 * 60;
  const zone = effectiveEveningTimeZone(eveningDefinition, locale);
  return (zonedClockMinutes(now, zone) ?? 0) >= targetMinutes ? "evening" : "day";
}

export function scheduleTodayModeRefresh(
  eveningDefinition: BriefingDefinitionDto | undefined,
  locale: LocaleSettingsDto,
  onRefresh: () => void,
  now: Date = new Date(Date.now())
): () => void {
  const delay = millisecondsUntilNextTodayModeRefresh(eveningDefinition, locale, now);
  if (delay === null) return () => undefined;
  const timer = setTimeout(onRefresh, delay);
  return () => clearTimeout(timer);
}

export function millisecondsUntilNextTodayModeRefresh(
  eveningDefinition: BriefingDefinitionDto | undefined,
  locale: LocaleSettingsDto,
  now: Date = new Date(Date.now())
): number | null {
  if (!eveningDefinition?.enabled) return null;
  const targetMinutes = parseTargetMinutes(targetTimeFor(eveningDefinition, "evening")) ?? 19 * 60;
  const parts = zonedClockParts(now, effectiveEveningTimeZone(eveningDefinition, locale));
  if (!parts) return null;
  const elapsedMs =
    ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 + now.getMilliseconds();
  const targetMs = targetMinutes * 60_000;
  const delay = elapsedMs < targetMs ? targetMs - elapsedMs : 86_400_000 - elapsedMs;
  return Math.max(1, delay);
}

export function effectiveBriefingTimeZone(
  definition: BriefingDefinitionDto | undefined,
  locale: LocaleSettingsDto
): string | undefined {
  const raw = definition?.scheduleMetadata.timezone;
  if (typeof raw === "string" && isValidTimeZone(raw.trim())) return raw.trim();
  if (isValidTimeZone(locale.timezone)) return locale.timezone;
  return DEFAULT_LOCALE.timezone;
}

export function effectiveEveningTimeZone(
  definition: BriefingDefinitionDto | undefined,
  locale: LocaleSettingsDto
): string | undefined {
  return effectiveBriefingTimeZone(definition, locale);
}

export function latestBriefingRunForToday(
  runs: readonly BriefingRunDto[],
  briefingType: "morning" | "evening",
  timeZone: string | undefined,
  now: Date = new Date(Date.now())
): BriefingRunDto | null {
  const todayKey = localDay(now, timeZone);
  return (
    [...runs]
      .filter(
        (run) => run.briefingType === briefingType && localDay(run.createdAt, timeZone) === todayKey
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null
  );
}

export function latestEveningRunForToday(
  runs: readonly BriefingRunDto[],
  timeZone: string | undefined,
  now: Date = new Date(Date.now())
): BriefingRunDto | null {
  return latestBriefingRunForToday(runs, "evening", timeZone, now);
}

export function addDaysToKey(key: string, days: number): string {
  const time = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(time)) return key;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

export function buildEveningLede(
  completed: number,
  carrying: number,
  tomorrowEvents: number
): string {
  const parts = [
    completed > 0
      ? `<b>${completed}</b> ${completed === 1 ? "thing is" : "things are"} complete`
      : "The day is ready to close",
    carrying > 0
      ? `<b>${carrying}</b> ${carrying === 1 ? "thing is" : "things are"} carrying forward`
      : "nothing urgent is carrying forward"
  ];
  if (tomorrowEvents > 0) {
    parts.push(`${tomorrowEvents} ${tomorrowEvents === 1 ? "event" : "events"} tomorrow`);
  }
  // Oxford join, not `parts.join(", and ")` — the latter double-printed "and" between
  // every clause ("complete, and carrying, and events"); Ben 2026-07-07: drop the first "and".
  return `${joinClauses(parts)}.`;
}

export function EveningReviewSection(props: {
  readonly kind: "primary" | "compact";
  readonly run: BriefingRunDto | null;
  readonly loading?: boolean;
  readonly locale: LocaleSettingsDto;
  readonly targetTime: string;
  readonly onFeedbackChanged: () => void;
  readonly completedToday?: readonly TaskDto[];
  readonly recapProse?: string;
  readonly recapDateLabel?: string;
  readonly onOpenTask?: (taskId: string) => void;
}) {
  if (props.kind === "primary") {
    return (
      <EveningRecapSection
        run={props.run}
        loading={props.loading}
        completedToday={props.completedToday ?? []}
        proseText={props.recapProse ?? ""}
        dateLabel={props.recapDateLabel ?? ""}
        onOpenTask={props.onOpenTask}
      />
    );
  }
  const freshness = props.run ? parseBriefingFreshness(props.run.sourceMetadata) : null;
  const hasSummary = Boolean(props.run?.summaryText.trim());
  const metaText = props.run
    ? shortDate(props.run.createdAt, props.locale)
    : `Ready at ${targetTimeLabel(props.targetTime)}`;
  const content = (
    <>
      {freshness ? <BriefingStaleBanner freshness={freshness} /> : null}
      {props.loading ? (
        <div className="agenda-clear" role="status">
          Gathering your evening review…
        </div>
      ) : props.run && hasSummary ? (
        <>
          <p className="cmd-empty">{compactSummary(props.run.summaryText)}</p>
          {/* Compact tiles keep the terse "…" feedback menu inline; the primary
              recap is read-only prose. Tomorrow's planning actions live in the
              evening rail. */}
          <BriefingFeedbackMenu targetRef={props.run.id} onChanged={props.onFeedbackChanged} />
        </>
      ) : (
        <div className="agenda-clear">No evening review yet.</div>
      )}
    </>
  );

  return (
    <Card title="Evening review" meta={metaText} padding="sm">
      {content}
    </Card>
  );
}

/** Body recap section: the run's first section under the evening hero, fed by
    the completed-today tasks. Loading and not-ready copy match the old hero
    section word for word. */
function EveningRecapSection(props: {
  readonly run: BriefingRunDto | null;
  readonly loading?: boolean;
  readonly completedToday: readonly TaskDto[];
  readonly proseText: string;
  readonly dateLabel: string;
  readonly onOpenTask?: (taskId: string) => void;
}) {
  const hasSummary = Boolean(props.run?.summaryText.trim());
  const prose = props.proseText.trim();
  // Without a readable run the evening page shows the hero lede and no recap
  // section at all; the loading skeleton above covers the pending state.
  if (!props.loading && !hasSummary) return null;
  return (
    <section className="ev-study ev-recap" id="evening-recap">
      <div className="ev-head">
        <span className="ev-head__number">{EVENING_RECAP_KICKER}</span>
        <h2 className="ev-head__title">{EVENING_RECAP_HEADING}</h2>
        {props.dateLabel !== "" ? <span className="ev-head__meta">{props.dateLabel}</span> : null}
      </div>
      {props.loading ? (
        <div className="agenda-clear" role="status">
          Gathering your evening review…
        </div>
      ) : (
        <>
          {prose !== "" ? <p className="ev-recap__intro">{prose}</p> : null}
          <EveningRecapRows tasks={props.completedToday} onOpenTask={props.onOpenTask} />
        </>
      )}
    </section>
  );
}

/** Completed-today rows: checkmark, bold title and the task's own description
    as a one-line sub-line. A task without one keeps an empty sub-line of the
    same height so the row geometry holds. */
function EveningRecapRows(props: {
  readonly tasks: readonly TaskDto[];
  readonly onOpenTask?: (taskId: string) => void;
}) {
  if (props.tasks.length === 0) {
    return <p className="cmd-empty">No completed tasks logged today.</p>;
  }
  return (
    <div className="ev-recap__list">
      {props.tasks.map((task) => (
        <div
          className="ev-done"
          key={task.id}
          data-jarvis-capture-text={`Task: ${task.title} — done`}
        >
          <span className="ev-done__check" aria-hidden="true">
            <Check size={15} strokeWidth={2.25} />
          </span>
          <button
            type="button"
            className="ev-done__main"
            onClick={() => props.onOpenTask?.(task.id)}
          >
            <span className="ev-done__title">{task.title}</span>
            {task.description ? <span className="ev-done__sub">{task.description}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}

export function BriefingProse({ summaryText }: { readonly summaryText: string }) {
  return <div className="jds-brief__body">{summaryText}</div>;
}

export function EveningSupportSections(props: {
  readonly openLoopsDek: string | null;
  readonly carryingForward: readonly TaskDto[];
  readonly onOpenTask: (taskId: string) => void;
}) {
  return (
    <section className="ev-study ev-loops" id="evening-open-loops">
      <h2 className="ev-loops__title">{EVENING_OPEN_LOOPS_HEADING}</h2>
      {props.openLoopsDek !== null ? <p className="ev-loops__dek">{props.openLoopsDek}</p> : null}
      {props.carryingForward.length > 0 ? (
        <div className="ev-loops__list">
          {props.carryingForward.slice(0, 3).map((task) => (
            <button
              type="button"
              className="ev-loop"
              key={task.id}
              onClick={() => props.onOpenTask(task.id)}
            >
              <span className="ev-loop__topic">{task.source}</span>
              <span className="ev-loop__title">{task.title}</span>
              {task.description ? <span className="ev-loop__sub">{task.description}</span> : null}
            </button>
          ))}
        </div>
      ) : (
        <p className="ev-loops__dek">{EVENING_OPEN_LOOPS_EMPTY}</p>
      )}
    </section>
  );
}

/** Evening rail: tomorrow's calendar and due tasks, then the planning actions. */
export function EveningTomorrowSection(props: {
  readonly dateLabel: string;
  readonly events: readonly CalendarEventDto[];
  readonly tasks: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly interviewPending: boolean;
  readonly onPlan: (anchor: HTMLElement) => void;
  readonly onPrep: () => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const assistantName = useAssistantName("");
  const empty = props.events.length === 0 && props.tasks.length === 0;
  return (
    <section className="ev-tomorrow" aria-label="Tomorrow">
      <span className="ev-tomorrow__eyebrow">{props.dateLabel}</span>
      <h3 className="ev-tomorrow__title">{EVENING_RAIL_HEADING}</h3>
      <p className="ev-tomorrow__dek">
        {empty ? "No events or due tasks found for tomorrow." : tomorrowCountText(props)}
      </p>
      {props.events.slice(0, 3).map((event) => (
        <div
          className="ev-tomorrow__item"
          key={event.id}
          data-jarvis-capture-text={`Tomorrow: ${eventCaptureText(event, props.locale)}`}
        >
          <strong>
            {timeLabel(event.startsAt, props.locale)}
            {ampm(event.startsAt, props.locale)} / Calendar
          </strong>
          {event.title}
          <small>{[longDurationLabel(event), event.location].filter(Boolean).join(" · ")}</small>
        </div>
      ))}
      {props.tasks.slice(0, 3).map((task) => (
        <button
          type="button"
          className="ev-tomorrow__item"
          key={task.id}
          onClick={() => props.onOpenTask(task.id)}
        >
          <strong>Due tomorrow / Task</strong>
          {task.title}
          {task.source ? <small>{task.source}</small> : null}
        </button>
      ))}
      <p className="ev-tomorrow__note">Nothing new is committed until you plan tomorrow.</p>
      <button
        type="button"
        className="ev-tomorrow__plan"
        onClick={(event) => props.onPlan(event.currentTarget)}
      >
        {PLAN_TOMORROW_LABEL}
      </button>
      <button
        type="button"
        className="ev-tomorrow__chat"
        disabled={props.interviewPending}
        onClick={props.onPrep}
      >
        {assistantName ? `Chat with ${assistantName}` : "Chat"} ↗
      </button>
    </section>
  );
}

function tomorrowCountText(props: {
  readonly events: readonly CalendarEventDto[];
  readonly tasks: readonly TaskDto[];
}): string {
  const parts: string[] = [];
  if (props.events.length > 0)
    parts.push(`${props.events.length} ${props.events.length === 1 ? "event" : "events"}`);
  if (props.tasks.length > 0)
    parts.push(`${props.tasks.length} ${props.tasks.length === 1 ? "task" : "tasks"} due`);
  return `${parts.join(" and ")} on the calendar so far.`;
}

function longDurationLabel(event: CalendarEventDto): string {
  const mins = Math.round(
    (new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()) / 60000
  );
  if (mins <= 0) return "";
  if (mins % 60 !== 0) return `${mins} minutes`;
  return mins === 60 ? "1 hour" : `${mins / 60} hours`;
}

function compactSummary(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= 220) return text;
  return `${text.slice(0, 217).trimEnd()}...`;
}

function parseTargetMinutes(value: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function targetTimeLabel(value: string): string {
  const minutes = parseTargetMinutes(value) ?? 19 * 60;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return minute === 0
    ? `${displayHour} ${suffix}`
    : `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function timeLabel(iso: string, locale: LocaleSettingsDto): string {
  return formatTime(iso, locale, { hour: "numeric", minute: "2-digit", hour12: true }).replace(
    /\s?[AP]M$/i,
    ""
  );
}

function ampm(iso: string, locale: LocaleSettingsDto): string {
  return /pm$/i.test(formatTime(iso, locale, { hour: "numeric", hour12: true })) ? "pm" : "am";
}

function shortDate(iso: string, locale: LocaleSettingsDto): string {
  return formatDate(iso, locale, { month: "short", day: "numeric" });
}

/**
 * Which briefing run supplies the action rows for the current Today mode. The evening briefing
 * carries what is still outstanding at end of day, so evening mode must never fall back to the
 * morning run — a stale morning row would read as "still needs you" hours after it was handled.
 */
export function selectActionRowsRun(
  mode: TodayMode,
  morningRun: BriefingRunDto | null,
  eveningRun: BriefingRunDto | null
): BriefingRunDto | null {
  return mode === "day" ? morningRun : eveningRun;
}
