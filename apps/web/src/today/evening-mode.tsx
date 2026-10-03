import {
  localDay,
  type BriefingDefinitionDto,
  type BriefingRunDto,
  type CalendarEventDto,
  type LocaleSettingsDto,
  type TaskDto
} from "@moss/shared";
import { Check } from "lucide-react";
import { useState } from "react";

import { Button, Card, Eyebrow, RowButton, SectionHead } from "@moss/ui";

import { useAssistantName } from "../api/use-assistant-name.js";
import { targetTimeFor } from "../briefings/briefing-settings-model.js";
import {
  DEFAULT_LOCALE,
  formatDate,
  formatTime,
  isValidTimeZone,
  zonedClockParts,
  zonedClockMinutes
} from "../locale/locale-format.js";
import { BriefingFeedbackMenu } from "./briefing-feedback-menu.js";
import { BriefingStaleBanner, parseBriefingFreshness } from "./briefing-freshness.js";
import {
  EVENING_OPEN_LOOPS_EMPTY,
  EVENING_OPEN_LOOPS_HEADING,
  EVENING_RECAP_HEADING,
  EVENING_RAIL_HEADING,
  EVENING_RECAP_KICKER,
  eventCaptureText,
  joinClauses,
  PLAN_TOMORROW_LABEL
} from "./today-labels.js";

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
        locale={props.locale}
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
  readonly locale: LocaleSettingsDto;
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
      <SectionHead
        className="ev-head"
        align="center"
        number={EVENING_RECAP_KICKER}
        title={EVENING_RECAP_HEADING}
        titleClassName="ev-head__title"
        meta={props.dateLabel !== "" ? props.dateLabel : null}
      />
      {props.loading ? (
        <div className="agenda-clear" role="status">
          Gathering your evening review…
        </div>
      ) : (
        <>
          {prose !== "" ? <p className="ev-recap__intro">{prose}</p> : null}
          <EveningRecapRows
            tasks={props.completedToday}
            locale={props.locale}
            hideEmpty={prose !== ""}
            onOpenTask={props.onOpenTask}
          />
        </>
      )}
    </section>
  );
}

/** Completed-today rows: checkmark, bold title and a one-line note. The note is
    the task's own description, or when it has none the time it was completed.
    A task with neither shows no note. The empty-list line is hidden when the
    report's own recap prose already says the day. */
function EveningRecapRows(props: {
  readonly tasks: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly hideEmpty: boolean;
  readonly onOpenTask?: (taskId: string) => void;
}) {
  if (props.tasks.length === 0) {
    if (props.hideEmpty) return null;
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
          <RowButton className="ev-done__main" onClick={() => props.onOpenTask?.(task.id)}>
            <span className="ev-done__title">{task.title}</span>
            {doneNote(task, props.locale) ? (
              <span className="ev-done__sub">{doneNote(task, props.locale)}</span>
            ) : null}
          </RowButton>
        </div>
      ))}
    </div>
  );
}

function doneNote(task: TaskDto, locale: LocaleSettingsDto): string | null {
  const description = task.description?.trim();
  if (description) return description;
  if (task.completedAt === null) return null;
  return `Completed at ${timeLabel(task.completedAt, locale)} ${ampm(task.completedAt, locale)}`;
}

export function BriefingProse({ summaryText }: { readonly summaryText: string }) {
  return <div className="jds-brief__body">{summaryText}</div>;
}

export type EveningLoopDecision =
  | { readonly kind: "tomorrow" }
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "drop" };

/** Reason line for an open loop, read only from the task's own due date. */
export function eveningLoopReason(
  task: TaskDto,
  locale: LocaleSettingsDto
): { readonly topic: string; readonly reason: string } | null {
  if (task.dueAt === null) return null;
  const today = localDay(new Date(), locale.timezone);
  const dueKey = localDay(task.dueAt, locale.timezone);
  const dueLabel = formatDate(task.dueAt, locale, { month: "short", day: "numeric" });
  if (dueKey < today) {
    return { topic: "Needs a new time", reason: `Was due ${dueLabel} and is still open.` };
  }
  if (dueKey === today) {
    return { topic: "Needs a new time", reason: "Due today and still open." };
  }
  return { topic: "Coming up", reason: `Due ${dueLabel}.` };
}

export function EveningSupportSections(props: {
  readonly openLoopsDek: string | null;
  readonly carryingForward: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly busyTaskId: string | null;
  readonly onOpenTask: (taskId: string) => void;
  readonly onDecide: (taskId: string, decision: EveningLoopDecision) => Promise<unknown>;
}) {
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [pickedDate, setPickedDate] = useState("");
  const [moved, setMoved] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const decide = async (task: TaskDto, decision: EveningLoopDecision, note: string) => {
    setFailed((prev) => ({ ...prev, [task.id]: false }));
    try {
      await props.onDecide(task.id, decision);
      setMoved((prev) => ({ ...prev, [task.id]: note }));
    } catch {
      setFailed((prev) => ({ ...prev, [task.id]: true }));
    }
  };
  return (
    <section className="ev-study ev-loops" id="evening-open-loops">
      <h2 className="ev-loops__title">{EVENING_OPEN_LOOPS_HEADING}</h2>
      {props.openLoopsDek !== null ? <p className="ev-loops__dek">{props.openLoopsDek}</p> : null}
      {props.carryingForward.length > 0 ? (
        <div className="ev-loops__list">
          {props.carryingForward.slice(0, 3).map((task) => {
            const why = eveningLoopReason(task, props.locale);
            const busy = props.busyTaskId === task.id;
            return (
              <div className="ev-loop" key={task.id}>
                {why ? <span className="ev-loop__topic">{why.topic}</span> : null}
                <RowButton className="ev-loop__open" onClick={() => props.onOpenTask(task.id)}>
                  <span className="ev-loop__title">{task.title}</span>
                </RowButton>
                {why ? <span className="ev-loop__sub">{why.reason}</span> : null}
                {moved[task.id] ? (
                  <span className="ev-loop__moved" role="status">
                    {moved[task.id]}
                  </span>
                ) : null}
                {failed[task.id] ? (
                  <span className="ev-loop__error" role="status">
                    Could not save that. Try again.
                  </span>
                ) : null}
                {moved[task.id] === undefined ? (
                  <div className="ev-loop__actions">
                    <Button
                      variant="chip"
                      disabled={busy}
                      onClick={() => void decide(task, { kind: "tomorrow" }, "Moved to tomorrow.")}
                    >
                      Tomorrow
                    </Button>
                    <Button
                      variant="chip"
                      disabled={busy}
                      aria-expanded={pickingId === task.id}
                      onClick={() => {
                        setPickedDate("");
                        setPickingId(pickingId === task.id ? null : task.id);
                      }}
                    >
                      Choose a day
                    </Button>
                    <Button
                      variant="chip"
                      disabled={busy}
                      onClick={() => void decide(task, { kind: "drop" }, "Let go.")}
                    >
                      Let it go
                    </Button>
                  </div>
                ) : null}
                {pickingId === task.id ? (
                  <div className="ev-loop__picker">
                    <input
                      type="date"
                      aria-label={`New day for ${task.title}`}
                      value={pickedDate}
                      onChange={(event) => setPickedDate(event.target.value)}
                    />
                    <Button
                      variant="chip"
                      disabled={busy || pickedDate === ""}
                      onClick={() => {
                        void decide(
                          task,
                          { kind: "date", date: pickedDate },
                          `Moved to ${formatDate(`${pickedDate}T12:00:00Z`, props.locale, { month: "short", day: "numeric", timeZone: "UTC" })}.`
                        );
                        setPickingId(null);
                      }}
                    >
                      Save day
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : props.openLoopsDek === null ? (
        <p className="ev-loops__dek">{EVENING_OPEN_LOOPS_EMPTY}</p>
      ) : null}
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
      <Eyebrow tone="accent" className="ev-tomorrow__eyebrow">
        {props.dateLabel}
      </Eyebrow>
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
        <RowButton
          className="ev-tomorrow__item"
          key={task.id}
          onClick={() => props.onOpenTask(task.id)}
        >
          <strong>Due tomorrow / Task</strong>
          {task.title}
          {task.source ? <small>{task.source}</small> : null}
        </RowButton>
      ))}
      <p className="ev-tomorrow__note">Nothing new is committed until you plan tomorrow.</p>
      <Button size="sm" block onClick={(event) => props.onPlan(event.currentTarget)}>
        {PLAN_TOMORROW_LABEL}
      </Button>
      <Button variant="link" disabled={props.interviewPending} onClick={props.onPrep}>
        {assistantName ? `Chat with ${assistantName}` : "Chat"} ↗
      </Button>
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

export function parseTargetMinutes(value: string): number | null {
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
