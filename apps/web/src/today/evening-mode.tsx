import {
  localDay,
  type BriefingDefinitionDto,
  type BriefingRunDto,
  type CalendarEventDto,
  type LocaleSettingsDto,
  type TaskDto
} from "@moss/shared";
import { MessageSquareText } from "lucide-react";
import type { ReactNode } from "react";

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
import { eventCaptureText, joinClauses } from "./today-labels";

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
}) {
  const freshness = props.run ? parseBriefingFreshness(props.run.sourceMetadata) : null;
  const hasSummary = Boolean(props.run?.summaryText.trim());
  const metaText = props.run
    ? shortDate(props.run.createdAt, props.locale)
    : `Ready at ${targetTimeLabel(props.targetTime)}`;
  const content = (
    <>
      {props.kind === "primary" ? (
        <div className="jds-brief__head">
          <span className="jds-brief__kicker">Evening review</span>
          <span className="jds-brief__kicker">{metaText}</span>
        </div>
      ) : null}
      {props.kind === "primary" ? (
        <div className="jds-brief__title">What happened today</div>
      ) : null}
      {freshness ? <BriefingStaleBanner freshness={freshness} /> : null}
      {props.loading ? (
        <div className="agenda-clear">Gathering your evening review…</div>
      ) : props.run && hasSummary ? (
        <>
          {props.kind === "primary" ? <BriefingProse summaryText={props.run.summaryText} /> : null}
          {props.kind === "compact" ? (
            <p className="cmd-empty">{compactSummary(props.run.summaryText)}</p>
          ) : null}
          {/* Compact tiles keep the terse "…" feedback menu inline; the primary
              recap is read-only prose. The "Prep for tomorrow" CTA now lives in
              the right rail as its own evening-only card (Ben: the button wasn't
              in the right spot on the recap card). */}
          {props.kind === "compact" ? (
            <BriefingFeedbackMenu targetRef={props.run.id} onChanged={props.onFeedbackChanged} />
          ) : null}
        </>
      ) : (
        <div className="agenda-clear">
          {props.kind === "primary"
            ? "Your evening review is not ready yet."
            : "No evening review yet."}
        </div>
      )}
    </>
  );

  return props.kind === "primary" ? (
    <section className="jds-brief">{content}</section>
  ) : (
    <Card title="Evening review" meta={metaText} padding="sm">
      {content}
    </Card>
  );
}

export function BriefingProse({ summaryText }: { readonly summaryText: string }) {
  return <div className="jds-brief__body">{summaryText}</div>;
}

// Evening-only right-rail CTA. Split out of the recap card so "Prep for
// tomorrow" reads as its own action in the rail instead of hanging off the
// bottom of the "What happened today" recap (Ben: the button wasn't in the
// right spot). Rendered only in evening mode, so the action is time-bound.
export function EveningPrepCard(props: {
  readonly interviewPending: boolean;
  readonly onPrep: () => void;
}) {
  // Button opens the evening interview chat, so it's labelled by the assistant
  // (Ben: "Chat with {assistantName}") rather than the generic "Prep for tomorrow".
  const assistantName = useAssistantName("");
  return (
    <Card title="Prep for tomorrow" padding="sm">
      <p className="cmd-empty">Close out today and set up tomorrow in a quick chat.</p>
      <button
        type="button"
        className="primary-button evening-prep__btn"
        disabled={props.interviewPending}
        onClick={props.onPrep}
      >
        <MessageSquareText size={14} aria-hidden="true" />
        {assistantName ? `Chat with ${assistantName}` : "Chat"}
      </button>
    </Card>
  );
}

export function EveningSupportSections(props: {
  readonly completedToday: readonly TaskDto[];
  readonly carryingForward: readonly TaskDto[];
  readonly tomorrowEvents: readonly CalendarEventDto[];
  readonly tomorrowTasks: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly renderTask: (task: TaskDto) => ReactNode;
}) {
  return (
    <>
      <section className="jds-brief">
        <div className="jds-brief__head">
          <span className="jds-brief__kicker">Accomplished today</span>
        </div>
        {props.completedToday.length > 0 ? (
          <div className="top3" style={{ marginTop: 4 }}>
            {props.completedToday.slice(0, 3).map(props.renderTask)}
          </div>
        ) : (
          <p className="cmd-empty">No completed tasks logged today.</p>
        )}
      </section>

      <section className="jds-brief">
        <div className="jds-brief__head">
          <span className="jds-brief__kicker">Carrying forward</span>
        </div>
        {props.carryingForward.length > 0 ? (
          <div className="top3" style={{ marginTop: 4 }}>
            {props.carryingForward.slice(0, 3).map(props.renderTask)}
          </div>
        ) : (
          <p className="cmd-empty">Nothing urgent is carrying forward.</p>
        )}
      </section>

      <section className="jds-brief">
        <div className="jds-brief__head">
          <span className="jds-brief__kicker">Tomorrow</span>
        </div>
        {props.tomorrowEvents.length > 0 || props.tomorrowTasks.length > 0 ? (
          <>
            {props.tomorrowEvents.length > 0 ? (
              <div className="day-list">
                {props.tomorrowEvents.slice(0, 3).map((event) => (
                  <div
                    className="day-ev"
                    key={event.id}
                    data-jarvis-capture-text={`Tomorrow: ${eventCaptureText(event, props.locale)}`}
                  >
                    <div className="day-ev__t">
                      {timeLabel(event.startsAt, props.locale)}
                      <span className="ap"> {ampm(event.startsAt, props.locale)}</span>
                    </div>
                    <div>
                      <div className="day-ev__title">{event.title}</div>
                      {event.location ? (
                        <div className="day-ev__where">{event.location}</div>
                      ) : null}
                    </div>
                    <div className="day-ev__who">{durationLabel(event)}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {props.tomorrowTasks.length > 0 ? (
              <div className="top3" style={{ marginTop: 10 }}>
                {props.tomorrowTasks.map(props.renderTask)}
              </div>
            ) : null}
          </>
        ) : (
          <p className="cmd-empty">No events or due tasks found for tomorrow.</p>
        )}
      </section>
    </>
  );
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

function durationLabel(event: CalendarEventDto): string {
  const mins = Math.round(
    (new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()) / 60000
  );
  if (mins <= 0) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
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
