import type { ReactNode } from "react";

import type { BriefingRunDto, LocaleSettingsDto, SourceFreshnessV1 } from "@moss/shared";

import { BriefingProse, type TodayMode } from "./evening-mode.js";
import { BriefingStaleBanner } from "./briefing-freshness.js";
import { plainBriefingText } from "./briefing-markdown.js";
import {
  BRIEFING_BLOCKED_REASON,
  BRIEFING_FAILED_REASON,
  BRIEFING_NOT_READY_LABEL,
  BRIEFING_OFF_REASON,
  briefingScheduledReason,
  EVENING_READ_FULL_LABEL,
  EVENING_SOURCES_LABEL,
  MORNING_READ_FULL_LABEL,
  MORNING_SOURCES_LABEL,
  preparedAtLabel
} from "./today-labels.js";

/** Split briefing prose into a headline (first sentence) and the rest. Some
    generated summaries carry no sentence punctuation, so a first line without
    a terminator falls back to the line break. */
export function splitHeadline(text: string): { readonly headline: string; readonly rest: string } {
  const split = splitFirstSentence(stripOpeningLabel(text));
  return { headline: plainBriefingText(split.headline), rest: stripOpeningLabel(split.rest) };
}

const OPENING_LABEL_LINE =
  /^\s*(?:#{1,6}[ \t]+)?(?:\*\*|__)?(?:headline|lead)(?:\*\*|__)?[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*\r?\n/i;
const OPENING_LABEL =
  /^\s*(?:\*\*|__)?(?:headline|lead)[ \t]*(?:(?:\*\*|__)[ \t]*:|:[ \t]*(?:\*\*|__)?)[ \t]*/i;

/** Writers sometimes open the headline or the lead with a label ("Headline:",
    "**Lead:**", or the label alone on its own line). Drop it from the opening only. */
export function stripOpeningLabel(text: string): string {
  return text.replace(OPENING_LABEL_LINE, "").replace(OPENING_LABEL, "").trim();
}

function splitFirstSentence(text: string): { readonly headline: string; readonly rest: string } {
  // The morning writer puts the whole headline on its own short first line, which may hold
  // two sentences ("A clear morning. A full afternoon.") or an abbreviation. A long first
  // line is a lead paragraph from an older report, and so is a short first paragraph followed
  // straight by a heading, because the new layout always puts a lead before the first heading.
  const ownLine = text.trim().match(/^([^\n]+)\r?\n\s*\n([\s\S]*)$/);
  const firstLine = ownLine?.[1]?.trim() ?? "";
  const rest = (ownLine?.[2] ?? "").trim();
  if (
    ownLine &&
    firstLine.length <= 140 &&
    !/^#{1,6}\s/.test(firstLine) &&
    rest !== "" &&
    !/^(#{1,6}\s|\*\*[^*\n]+\*\*\s*(\n|$))/.test(rest)
  ) {
    return { headline: firstLine, rest };
  }
  const match = text.match(/^(.*?[.!?])(\s+|$)([\s\S]*)$/);
  if (match) return { headline: (match[1] ?? "").trim(), rest: (match[3] ?? "").trim() };
  const line = text.match(/^(.*?)(\r?\n|$)([\s\S]*)$/);
  if (line && (line[1] ?? "").trim()) {
    return { headline: (line[1] ?? "").trim(), rest: (line[3] ?? "").trim() };
  }
  return { headline: text.trim(), rest: "" };
}

/** Today previews the saved report's lead; Read keeps the complete report. */
export function morningReportLead(text: string): string {
  return (
    text
      .trim()
      .split(/\n\s*\n|\n(?=#{1,3}\s)/)[0]
      ?.trim() ?? ""
  );
}

export interface TodayHeroProps {
  readonly mode: TodayMode;
  readonly eyebrow: string;
  readonly headline: ReactNode;
  readonly summary: ReactNode;
  readonly preparedAt: string | null;
  readonly readerControl: ReactNode | null;
  readonly notReadyReason?: string | null;
  readonly weather: ReactNode;
  readonly sectionLinks?: ReactNode;
}

export interface TodayHeroContentInput {
  readonly mode: TodayMode;
  readonly assessmentShown: boolean;
  readonly morningLoading: boolean;
  readonly morningRun: BriefingRunDto | null;
  readonly morningDefinitionId: string | null;
  /** Schedule state for the not-ready reason; omitted means no reason is shown. */
  readonly morningSchedule?: {
    readonly enabled: boolean;
    readonly targetTime: string;
    readonly pastTarget: boolean;
  };
  readonly morningSplit: { readonly headline: string; readonly rest: string } | null;
  readonly morningFreshness: SourceFreshnessV1 | null;
  readonly eveningRun: BriefingRunDto | null;
  readonly eveningSplit: { readonly headline: string; readonly rest: string } | null;
  readonly eveningLoading: boolean;
  readonly eveningTargetTime: string;
  readonly fallbackTop: string;
  readonly fallbackAccent: string;
  readonly ledeHtml: string;
  readonly locale: LocaleSettingsDto;
  readonly onFeedbackChanged: () => void;
  readonly onOpenReader: (anchor: HTMLElement) => void;
  readonly onOpenEveningReader: (anchor: HTMLElement, section?: "sources") => void;
}

export interface TodayHeroContent {
  readonly headline: ReactNode;
  readonly summary: ReactNode;
  readonly preparedAt: string | null;
  readonly readerControl: ReactNode;
  readonly notReadyReason: string | null;
}

/** Why the day briefing has no readable report: switched off, failed, or still to run. */
export function morningNotReadyReason(
  run: BriefingRunDto | null,
  schedule: TodayHeroContentInput["morningSchedule"]
): string | null {
  if (!schedule) return null;
  if (!schedule.enabled) return BRIEFING_OFF_REASON;
  if (run?.status === "failed") return BRIEFING_FAILED_REASON;
  if (run?.status === "blocked") return BRIEFING_BLOCKED_REASON;
  return briefingScheduledReason(schedule.targetTime, schedule.pastTarget);
}

/** Assemble the hero's headline, summary, prepared line and reader control
    from the page's queries. Pure presentational mapping: no fetching. */
export function buildTodayHeroContent(input: TodayHeroContentInput): TodayHeroContent {
  const isEvening = input.mode === "evening";
  const morningReadable =
    input.morningRun && input.morningRun.summaryText.trim() && input.morningDefinitionId
      ? input.morningRun
      : null;
  const fallbackHeadline = (
    <>
      <span>{input.fallbackTop}</span>{" "}
      <span className="today-hero__accent">{input.fallbackAccent}</span>
    </>
  );
  if (isEvening) {
    // Without a run, or when the assessment is hidden, the summary is the
    // evening lede, as on the base. With a run the h1 carries the verdict's
    // first sentence and the dek the remainder; a run without a verdict keeps
    // the fallback headline but still shows its links and prepared line.
    const eveningReadable = Boolean(input.eveningRun?.summaryText.trim());
    if (!input.assessmentShown || (!input.eveningLoading && !eveningReadable)) {
      return {
        headline: input.eveningSplit ? input.eveningSplit.headline : fallbackHeadline,
        summary: <span dangerouslySetInnerHTML={{ __html: input.ledeHtml }} />,
        preparedAt: null,
        readerControl: null,
        notReadyReason: null
      };
    }
    const rest = input.eveningSplit?.rest.trim() ?? "";
    return {
      headline: input.eveningSplit ? input.eveningSplit.headline : fallbackHeadline,
      summary:
        rest !== "" ? (
          <BriefingProse summaryText={plainBriefingText(rest).replace(/\s+/g, " ")} />
        ) : (
          <span dangerouslySetInnerHTML={{ __html: input.ledeHtml }} />
        ),
      preparedAt: input.eveningRun
        ? preparedAtLabel(input.eveningRun.createdAt, input.locale)
        : null,
      readerControl: input.eveningRun ? (
        <EveningHeroLinks onOpenReader={input.onOpenEveningReader} />
      ) : null,
      notReadyReason: null
    };
  }
  // The stale banner shows whenever freshness data exists, including with a
  // reader-less, summary-less run.
  const summary = !input.assessmentShown ? (
    <span dangerouslySetInnerHTML={{ __html: input.ledeHtml }} />
  ) : input.morningLoading ? (
    <div className="agenda-clear" role="status">
      Gathering your morning briefing…
    </div>
  ) : (
    <>
      {input.morningFreshness ? <BriefingStaleBanner freshness={input.morningFreshness} /> : null}
      {morningReadable && input.morningSplit && input.morningSplit.rest ? (
        <BriefingProse
          summaryText={plainBriefingText(morningReportLead(input.morningSplit.rest))}
        />
      ) : (
        <span dangerouslySetInnerHTML={{ __html: input.ledeHtml }} />
      )}
    </>
  );
  // The moved not-ready text becomes the prepared line.
  const preparedAt =
    !input.assessmentShown || input.morningLoading
      ? null
      : morningReadable
        ? preparedAtLabel(morningReadable.createdAt, input.locale)
        : BRIEFING_NOT_READY_LABEL;
  return {
    headline: input.morningSplit ? input.morningSplit.headline : fallbackHeadline,
    summary,
    preparedAt,
    readerControl: morningReadable ? <MorningHeroLinks onOpenReader={input.onOpenReader} /> : null,
    // Independent of assessmentShown: a switched-off briefing hides the assessment
    // but still has no report, and that is exactly when the reason matters.
    notReadyReason:
      input.morningLoading || morningReadable
        ? null
        : morningNotReadyReason(input.morningRun, input.morningSchedule)
  };
}

function MorningHeroLinks(props: { readonly onOpenReader: (anchor: HTMLElement) => void }) {
  return (
    <>
      <button
        type="button"
        className="today-hero__link"
        onClick={(event) => props.onOpenReader(event.currentTarget)}
      >
        {MORNING_READ_FULL_LABEL}
      </button>
      <button
        type="button"
        className="today-hero__link"
        onClick={(event) => props.onOpenReader(event.currentTarget)}
      >
        {MORNING_SOURCES_LABEL}
      </button>
    </>
  );
}

/** Evening hero report links. Both open the briefing reader on the latest
    evening run; the sources link opens it at the source list. */
export function EveningHeroLinks(props: {
  readonly onOpenReader: (anchor: HTMLElement, section?: "sources") => void;
}) {
  return (
    <>
      <button
        type="button"
        className="today-hero__link"
        onClick={(event) => props.onOpenReader(event.currentTarget)}
      >
        {EVENING_READ_FULL_LABEL}
      </button>
      <button
        type="button"
        className="today-hero__link"
        onClick={(event) => props.onOpenReader(event.currentTarget, "sources")}
      >
        {EVENING_SOURCES_LABEL}
      </button>
    </>
  );
}

/** Today-only hero band: eyebrow, display headline, assessment summary,
    weather, then the reader links and prepared time. */
export function TodayHero(props: TodayHeroProps) {
  const isNotReadyString = props.preparedAt === BRIEFING_NOT_READY_LABEL;
  const preparedTime = isNotReadyString ? null : props.preparedAt;

  return (
    <>
      <section className="today-hero" data-mode={props.mode}>
        <p className="today-hero__eyebrow">{props.eyebrow}</p>
        <h1 className="today-hero__title">{props.headline}</h1>
        <div className="today-hero__summary" id="assessment">
          {props.summary}
        </div>
        <hr className="today-hero__hairline" />
        <div className="today-hero__weather" id="weather">
          {props.weather}
        </div>
        <div className="today-hero__prepared">
          {props.readerControl ? (
            <div className="today-hero__links">{props.readerControl}</div>
          ) : (
            <span className="today-hero__not-ready">
              {props.notReadyReason
                ? `${BRIEFING_NOT_READY_LABEL}. ${props.notReadyReason}`
                : BRIEFING_NOT_READY_LABEL}
            </span>
          )}
          {preparedTime !== null ? (
            <span className="today-hero__prepared-time">{preparedTime}</span>
          ) : null}
        </div>
      </section>
      {props.sectionLinks ?? null}
    </>
  );
}
