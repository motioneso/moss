import type { ReactNode } from "react";

import { Button } from "@moss/ui";
import type { BriefingRunDto, LocaleSettingsDto, SourceFreshnessV1 } from "@moss/shared";

import { BriefingProse, EveningReviewSection, type TodayMode } from "./evening-mode.js";
import { BriefingStaleBanner } from "./briefing-freshness.js";
import { timeLabel } from "./today-labels.js";

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
    // evening lede, as on the base. While runs load, the section skeleton
    // shows; with a recap, the section renders the rest only, since the h1
    // already carries the first sentence.
    if (!input.assessmentShown || (!input.eveningLoading && !input.eveningSplit)) {
      return {
        headline: input.eveningSplit ? input.eveningSplit.headline : fallbackHeadline,
        summary: <span dangerouslySetInnerHTML={{ __html: input.ledeHtml }} />,
        preparedAt: null,
        readerControl: null
      };
    }
    const restRun =
      input.eveningRun && input.eveningSplit && input.eveningSplit.rest
        ? { ...input.eveningRun, summaryText: input.eveningSplit.rest }
        : input.eveningRun;
    return {
      headline: input.eveningSplit ? input.eveningSplit.headline : fallbackHeadline,
      summary: (
        <EveningReviewSection
          kind="primary"
          run={restRun}
          loading={input.eveningLoading}
          locale={input.locale}
          targetTime={input.eveningTargetTime}
          onFeedbackChanged={input.onFeedbackChanged}
        />
      ),
      // The section keeps its own not-ready text, so the prepared line only
      // names a real recap time.
      preparedAt: input.eveningRun
        ? `Prepared at ${timeLabel(input.eveningRun.createdAt, input.locale)}`
        : null,
      readerControl: null
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
        : "Your morning briefing is not ready yet.";
  return {
    headline: input.morningSplit ? input.morningSplit.headline : fallbackHeadline,
    summary,
    preparedAt,
    readerControl: morningReadable ? (
      <Button variant="secondary" onClick={(event) => input.onOpenReader(event.currentTarget)}>
        Read the full morning briefing
      </Button>
    ) : null
  };
}

/** Today-only hero band: eyebrow, display headline, assessment summary,
    prepared-at line with the reader control, rule, then the weather row. */
export function TodayHero(props: TodayHeroProps) {
  return (
    <section
      className={`today-hero${props.mode === "evening" ? " today-hero--evening" : ""}`}
      data-mode={props.mode}
    >
      <p className="today-hero__eyebrow">{props.eyebrow}</p>
      <h1 className="today-hero__title">{props.headline}</h1>
      <div className="today-hero__summary" id="assessment">
        {props.summary}
      </div>
      {props.preparedAt !== null ? (
        <p className="today-hero__prepared">
          {props.preparedAt} {props.readerControl}
        </p>
      ) : null}
      <hr className="today-hero__rule" />
      <div className="today-hero__weather" id="weather">
        {props.weather}
      </div>
    </section>
  );
}
