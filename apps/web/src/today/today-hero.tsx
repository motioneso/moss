import type { ReactNode } from "react";

import type { BriefingRunDto, LocaleSettingsDto, SourceFreshnessV1 } from "@moss/shared";

import { BriefingProse, type TodayMode } from "./evening-mode.js";
import { BriefingStaleBanner } from "./briefing-freshness.js";
import {
  BRIEFING_NOT_READY_LABEL,
  EVENING_READ_FULL_LABEL,
  EVENING_SOURCES_LABEL,
  MORNING_READ_FULL_LABEL,
  MORNING_SOURCES_LABEL,
  timeLabel
} from "./today-labels.js";

/** Split briefing prose into a headline (first sentence) and the rest. Some
    generated summaries carry no sentence punctuation, so a first line without
    a terminator falls back to the line break. */
export function splitHeadline(text: string): { readonly headline: string; readonly rest: string } {
  const match = text.match(/^(.*?[.!?])(\s+|$)([\s\S]*)$/);
  if (match) return { headline: (match[1] ?? "").trim(), rest: (match[3] ?? "").trim() };
  const line = text.match(/^(.*?)(\r?\n|$)([\s\S]*)$/);
  if (line && (line[1] ?? "").trim()) {
    return { headline: (line[1] ?? "").trim(), rest: (line[3] ?? "").trim() };
  }
  return { headline: text.trim(), rest: "" };
}

export interface TodayHeroProps {
  readonly mode: TodayMode;
  readonly eyebrow: string;
  readonly headline: ReactNode;
  readonly summary: ReactNode;
  readonly preparedAt: string | null;
  readonly readerControl: ReactNode | null;
  readonly weather: ReactNode;
  readonly sectionLinks?: ReactNode;
}

export interface TodayHeroContentInput {
  readonly mode: TodayMode;
  readonly assessmentShown: boolean;
  readonly morningLoading: boolean;
  readonly morningRun: BriefingRunDto | null;
  readonly morningDefinitionId: string | null;
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
}

export interface TodayHeroContent {
  readonly headline: ReactNode;
  readonly summary: ReactNode;
  readonly preparedAt: string | null;
  readonly readerControl: ReactNode;
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
    // evening lede, as on the base. With a recap the h1 carries the first
    // sentence and the dek the remainder; the recap section itself moved to
    // the body, so the hero keeps headline, dek, links and prepared line only.
    if (!input.assessmentShown || (!input.eveningLoading && !input.eveningSplit)) {
      return {
        headline: input.eveningSplit ? input.eveningSplit.headline : fallbackHeadline,
        summary: <span dangerouslySetInnerHTML={{ __html: input.ledeHtml }} />,
        preparedAt: null,
        readerControl: null
      };
    }
    const rest = input.eveningSplit?.rest.trim() ?? "";
    return {
      headline: input.eveningSplit ? input.eveningSplit.headline : fallbackHeadline,
      summary:
        rest !== "" ? (
          <BriefingProse summaryText={rest} />
        ) : (
          <span dangerouslySetInnerHTML={{ __html: input.ledeHtml }} />
        ),
      preparedAt: input.eveningRun
        ? `Prepared at ${timeLabel(input.eveningRun.createdAt, input.locale)}`
        : null,
      readerControl: input.eveningRun ? <EveningHeroLinks /> : null
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
        <BriefingProse summaryText={input.morningSplit.rest} />
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
        ? `Prepared at ${timeLabel(morningReadable.createdAt, input.locale)}`
        : BRIEFING_NOT_READY_LABEL;
  return {
    headline: input.morningSplit ? input.morningSplit.headline : fallbackHeadline,
    summary,
    preparedAt,
    readerControl: morningReadable ? <MorningHeroLinks onOpenReader={input.onOpenReader} /> : null
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

/** Evening hero report links. No evening briefing reader or sources view exists
    yet, so these render named but unwired; the wiring is a recorded finding for
    Architect and must not be invented here. */
export function EveningHeroLinks() {
  return (
    <>
      <button type="button" className="today-hero__link">
        {EVENING_READ_FULL_LABEL}
      </button>
      <button type="button" className="today-hero__link">
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
            <span className="today-hero__not-ready">{BRIEFING_NOT_READY_LABEL}</span>
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
