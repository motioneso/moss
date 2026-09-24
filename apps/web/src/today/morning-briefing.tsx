import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  isNewsBriefingEvidence,
  isSportsBriefingEvidence,
  readPlanContext,
  type BriefingPlanContextV1,
  type BriefingRunDto,
  type CalendarEventDto,
  type GetBriefingRunResponse,
  type GetDayPlanResponse,
  type LocaleSettingsDto,
  type SportsBriefingEvidenceGameV1,
  type TaskDto
} from "@moss/shared";

import { Button } from "@moss/ui";

import { getBriefingRun, getCalendarBriefingSettings, requestJson } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { formatDate, formatTime } from "../locale/locale-format.js";
import { joinActionRowsToTasks, type DisplayedActionRow } from "./briefing-action-rows.js";
import {
  EditorialBlock,
  BriefingReportShell,
  readEditorial,
  readGaps
} from "./briefing-report-shell.js";
import { calloutCopy, findChangedBlocks } from "./briefing-callout.js";
import { splitHeadline } from "./today-hero.js";
import type { DayPlanReviewController } from "./day-plan-review-controller.js";
import { acceptAllSelectionFor, hasOtherPendingEdits } from "./day-plan-review-model.js";
import * as acceptLabels from "./today-labels.js";
import { BriefingProse } from "./evening-mode.js";
import {
  BriefingFreshnessList,
  BriefingStaleBanner,
  parseBriefingFreshness
} from "./briefing-freshness.js";
import { DayPlanSection } from "./day-plan.js";

export interface MorningBriefingReaderProps {
  readonly definitionId: string;
  readonly initialRunId: string;
  readonly runs: readonly BriefingRunDto[];
  readonly tasks: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly dayPlan: GetDayPlanResponse | undefined;
  readonly events: readonly CalendarEventDto[];
  readonly now: Date;
  readonly dayPlanLoading: boolean;
  readonly dayPlanError: boolean;
  readonly calendarError: boolean;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onReview: (anchor: HTMLElement) => void;
  readonly controller: DayPlanReviewController;
}

/** Full morning report for one run, from the run response only. Nothing here writes. */
export function MorningBriefingReader(props: MorningBriefingReaderProps) {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState(props.initialRunId);
  const detailQuery = useQuery({
    queryKey: queryKeys.briefings.run(props.definitionId, selectedRunId),
    queryFn: () => getBriefingRun(props.definitionId, selectedRunId)
  });
  const retryMutation = useMutation({
    mutationFn: () =>
      requestJson<{ jobId: string; runId: string }>(
        `/api/briefings/definitions/${encodeURIComponent(props.definitionId)}/run`,
        { method: "POST", body: {} }
      ),
    onSuccess: (data) => {
      for (const queryKey of [
        queryKeys.briefings.runs(props.definitionId),
        queryKeys.briefings.run(props.definitionId, data.runId)
      ])
        void queryClient.invalidateQueries({ queryKey });
      setSelectedRunId(data.runId);
    }
  });

  const settingsQuery = useQuery({
    queryKey: ["calendar", "briefing-settings"],
    queryFn: getCalendarBriefingSettings,
    retry: false
  });
  const isAutoMode = settingsQuery.data?.settings?.timeBlockMode === "auto";
  // The Read tab always reads "Review task blocks"; only the footer's own
  // secondary button keeps the auto-mode wording (B10).
  const reviewTabLabel = "Review task blocks";
  const footerReviewLabel = isAutoMode ? "Adjust task blocks" : "Review task blocks";
  // Every Read-tab state (proposed or automatic) takes the same wide frame;
  // the attribute just names which one this report is.
  const hasAutomaticPlacement = (props.dayPlan?.plan?.blocks ?? []).some(
    (block) => block.pendingChange === null && block.actualPlacement?.startsAt != null
  );
  const briefingSurface = hasAutomaticPlacement ? "automatic-read" : "proposed-read";
  const { choiceFor, touchedIds } = props.controller;
  const acceptPlan = props.dayPlan?.plan ?? null;
  const acceptSelection = acceptPlan
    ? acceptAllSelectionFor(acceptPlan, choiceFor, touchedIds)
    : [];
  const acceptBlocked =
    acceptPlan !== null && hasOtherPendingEdits(acceptPlan, choiceFor, touchedIds);
  const acceptStatus = acceptLabels.acceptAllStatus(props.controller);
  const [acceptPhase, setAcceptPhase] = useState<"idle" | "busy" | "done">("idle");
  const accepting = acceptPhase === "busy";
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  const acceptReviewRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (acceptPhase === "done")
      (acceptReviewRef.current ?? acceptRef.current ?? backRef.current)?.focus();
  }, [acceptPhase, acceptSelection.length]);
  const runAcceptAll = async () => {
    setAcceptPhase("busy");
    await props.controller.acceptAllAdditions();
    setAcceptPhase("done");
  };
  const openReaderReview = (event: { currentTarget: HTMLElement }) =>
    props.onReview(event.currentTarget);
  const acceptReviewButton = acceptStatus.needsReview ? (
    <Button variant="quiet" size="sm" ref={acceptReviewRef} onClick={openReaderReview}>
      {acceptLabels.REVIEW_CHANGES_LABEL}
    </Button>
  ) : null;
  const acceptPrimaryButton =
    acceptBlocked || acceptSelection.length > 0 ? (
      <Button
        variant="primary"
        ref={acceptRef}
        aria-busy={accepting}
        disabled={!acceptBlocked && (accepting || props.controller.busy)}
        onClick={acceptBlocked ? openReaderReview : () => void runAcceptAll()}
      >
        {acceptBlocked
          ? acceptLabels.REVIEW_CHANGES_LABEL
          : accepting
            ? acceptLabels.ACCEPTING_LABEL
            : acceptLabels.ACCEPT_ALL_LABEL}
      </Button>
    ) : null;
  const detail = detailQuery.data ?? null;
  const failed =
    detailQuery.isError ||
    detail?.state === "failed" ||
    (detail?.state === "ready" && (detail.run === null || detail.run.status !== "succeeded"));

  const readyRun = detail?.state === "ready" ? detail.run : null;
  const newsPreview =
    readyRun && readEditorial(readyRun.sourceMetadata, "news", isNewsBriefingEvidence);
  const sportsPreview =
    readyRun && readEditorial(readyRun.sourceMetadata, "sports", isSportsBriefingEvidence);

  return (
    <BriefingReportShell
      eyebrow="Moss / Morning briefing"
      title="Your day, prepared."
      opener={props.opener}
      onClose={props.onClose}
      reviewTabLabel={reviewTabLabel}
      onSelectReviewTab={openReaderReview}
      jumpLinks={
        newsPreview || sportsPreview ? (
          <nav className="brief-reader__jump" aria-label="Report sections">
            {newsPreview ? <a href="#brief-reader-news">News ↓</a> : null}
            {sportsPreview ? <a href="#brief-reader-sports">Sports ↓</a> : null}
          </nav>
        ) : null
      }
      report={
        <div data-briefing-surface={briefingSurface}>
          {detail?.state === "ready" && detail.run !== null && detail.run.status === "succeeded" ? (
            <ReportBody
              detail={detail}
              run={detail.run}
              tasks={props.tasks}
              locale={props.locale}
              runs={props.runs}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
              onMoreOnToday={props.onClose}
            />
          ) : (
            <div>
              <p className="cmd-empty" role="status">
                {failed
                  ? "Your morning briefing isn't available."
                  : "Your morning briefing is being prepared."}
              </p>
              {failed ? (
                <Button
                  variant="secondary"
                  disabled={retryMutation.isPending}
                  onClick={() => retryMutation.mutate()}
                >
                  Try again
                </Button>
              ) : null}
            </div>
          )}
        </div>
      }
      railDateInput={readyRun?.createdAt ?? props.now}
      locale={props.locale}
      railHeading="Your day, in order."
      rail={
        <DayPlanSection
          dayPlan={props.dayPlan}
          events={props.events}
          locale={props.locale}
          now={props.now}
          loading={props.dayPlanLoading}
          error={props.dayPlanError}
          calendarError={props.calendarError}
          onOpenTask={props.onOpenTask}
          editorial
          showEditorialHeading={false}
          proposedCaption="short"
        />
      }
      footerActions={
        briefingSurface === "proposed-read" ? (
          <>
            <span className="brief-reader__review-link">
              <Button variant="quiet" onClick={openReaderReview}>
                {acceptLabels.REVIEW_PROPOSED_BLOCKS_LABEL}
              </Button>
            </span>
            {acceptPrimaryButton}
          </>
        ) : (
          <>
            {acceptPrimaryButton}
            <Button variant="secondary" onClick={openReaderReview}>
              {footerReviewLabel}
            </Button>
          </>
        )
      }
      footerStatus={
        acceptPhase !== "idle" ? (
          <p className="brief-reader__accept-status" role="status">
            {acceptStatus.line} {acceptReviewButton}
          </p>
        ) : null
      }
      footerBack={
        <Button variant="quiet" ref={backRef} onClick={props.onClose}>
          Back to Today
        </Button>
      }
    />
  );
}

// Sports paragraph copy (Q5): finished games as a "final" line with the
// scores in bold, up to two.
function finalsParagraphs(games: readonly SportsBriefingEvidenceGameV1[]) {
  return games
    .filter((game) => game.phase === "final")
    .slice(0, 2)
    .map((game) => (
      <>
        {game.awayShort} <strong>{game.awayScore}</strong>, {game.homeShort}{" "}
        <strong>{game.homeScore}</strong> final.
      </>
    ));
}

// Sports "Tonight" copy (Q5): tonight's games and their start times, or
// nothing when none are on tonight.
function tonightParagraph(
  games: readonly SportsBriefingEvidenceGameV1[],
  locale: LocaleSettingsDto
): { readonly heading: string; readonly paragraph: string } | null {
  const tonightGames = games.filter((game) => game.phase === "tonight");
  if (tonightGames.length === 0) return null;
  return {
    heading: "Tonight",
    paragraph: tonightGames
      .map((game) => `${game.awayShort} at ${game.homeShort}, ${formatTime(game.startsAt, locale)}`)
      .join("; ")
  };
}

function ReportBody(props: {
  readonly detail: GetBriefingRunResponse;
  readonly run: BriefingRunDto;
  readonly tasks: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly runs: readonly BriefingRunDto[];
  readonly selectedRunId: string;
  readonly onSelectRun: (runId: string) => void;
  readonly onMoreOnToday: () => void;
}) {
  const { run } = props;
  const headline = splitHeadline(run.summaryText);
  const planContext = readPlanContext(run.structuredPayload);
  const freshness = parseBriefingFreshness(run.sourceMetadata);
  const gaps = readGaps(run.sourceMetadata);
  const news = readEditorial(run.sourceMetadata, "news", isNewsBriefingEvidence);
  const sports = readEditorial(run.sourceMetadata, "sports", isSportsBriefingEvidence);

  return (
    <div>
      {!props.detail.latest ? (
        <p className="brief-reader__dated">
          Report from {formatDate(run.createdAt, props.locale, { month: "long", day: "numeric" })}.
        </p>
      ) : null}
      <p className="brief-reader__prepared">
        Prepared at {formatTime(run.createdAt, props.locale)}
      </p>
      {headline.headline ? <h3 className="brief-reader__headline">{headline.headline}</h3> : null}
      {headline.rest ? <BriefingProse summaryText={headline.rest} /> : null}
      {props.detail.plan?.status === "changed" || props.detail.plan?.status === "unavailable" ? (
        <BriefingCallout
          before={planContext}
          after={props.detail.plan.current}
          locale={props.locale}
        />
      ) : null}
      {freshness ? <BriefingStaleBanner freshness={freshness} /> : null}
      {run.structuredPayload.actionRows.length > 0 ? (
        <BriefingSections run={run} tasks={props.tasks} />
      ) : null}
      {news ? (
        <EditorialBlock
          id="brief-reader-news"
          sectionLabel="News"
          eyebrow="NEWS / THE BIG STORIES"
          headline={news.stories[0]?.title ?? null}
          photoUrl={news.stories[0]?.imageUrl ?? null}
          paragraphs={news.stories
            .slice(0, 2)
            .flatMap((story) => (story.summary ? [story.summary] : []))}
          ctaLabel="Read the stories ↗"
          onMoreOnToday={props.onMoreOnToday}
        />
      ) : null}
      {sports ? (
        <EditorialBlock
          id="brief-reader-sports"
          sectionLabel="Sports"
          eyebrow="SPORTS / YOUR TEAMS FIRST"
          headline={sports.stories[0]?.title ?? sports.games[0]?.headline ?? null}
          photoUrl={sports.stories[0]?.imageUrl ?? null}
          paragraphs={finalsParagraphs(sports.games)}
          tonight={tonightParagraph(sports.games, props.locale)}
          ctaLabel="See scores & tonight's games ↗"
          onMoreOnToday={props.onMoreOnToday}
        />
      ) : null}
      {freshness || gaps.length > 0 ? (
        <details className="brief-reader__sources">
          <summary>Sources</summary>
          {freshness ? <BriefingFreshnessList freshness={freshness} /> : null}
          {gaps.map((gap) => (
            <p key={gap.source} className="brief-reader__gap">
              {gap.source}: No longer available ({gap.reason}).
            </p>
          ))}
        </details>
      ) : null}
      {props.runs.length > 1 ? (
        <details className="brief-reader__earlier">
          <summary>Earlier reports</summary>
          <ul>
            {props.runs.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="jds-btn jds-btn--quiet"
                  disabled={entry.id === props.selectedRunId}
                  onClick={() => props.onSelectRun(entry.id)}
                >
                  Report from{" "}
                  {formatDate(entry.createdAt, props.locale, { month: "long", day: "numeric" })}
                  {entry.id === props.selectedRunId ? " (open)" : ""}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Q2 callout: names the plan block that moved since this report was
    prepared, with a keyboard-operable disclosure for the old and new time.
    Falls back to the plain sentence when nothing comparable by id moved. */
function BriefingCallout(props: {
  readonly before: BriefingPlanContextV1 | null;
  readonly after: BriefingPlanContextV1 | null;
  readonly locale: LocaleSettingsDto;
}) {
  const [open, setOpen] = useState(false);
  const changed = findChangedBlocks(props.before, props.after);
  const copy = calloutCopy(changed, props.locale);
  return (
    <div className="brief-reader__callout">
      <p className="brief-reader__callout-kicker">Changed overnight</p>
      {copy ? (
        <>
          <p className="brief-reader__callout-headline">{copy.headline}</p>
          <p className="brief-reader__plan-changed">{copy.sentence}</p>
          <button
            type="button"
            className="brief-reader__callout-disclosure"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "▾" : "▸"} {copy.disclosureLabel}
          </button>
          {open ? (
            <ul className="brief-reader__callout-detail">
              {copy.disclosureLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="brief-reader__plan-changed">The plan has changed since this report.</p>
      )}
    </div>
  );
}

/** Q3: each action row renders as a report section (heading, explanation as
    prose, a "View ↗" link for a view action), replacing the old flat list. */
function BriefingSections(props: {
  readonly run: BriefingRunDto;
  readonly tasks: readonly TaskDto[];
}) {
  const displayed = joinActionRowsToTasks(props.run.structuredPayload.actionRows, props.tasks);
  const shown = new Set(displayed.map((entry) => entry.row.taskId));
  const dropped = props.run.structuredPayload.actionRows.filter((row) => !shown.has(row.taskId));
  return (
    <div className="brief-reader__sections">
      {displayed.map((entry) => (
        <BriefingSection key={entry.row.taskId} entry={entry} />
      ))}
      {dropped.map((row) => (
        <p key={row.taskId} className="brief-reader__gap">
          No longer available
        </p>
      ))}
    </div>
  );
}

function BriefingSection(props: { readonly entry: DisplayedActionRow }) {
  const row = props.entry.row;
  return (
    <section className="brief-reader__section">
      <h4 className="brief-reader__section-heading">{row.title}</h4>
      <p className="brief-reader__section-prose">{row.explanation}</p>
      {row.primaryAction?.kind === "view" ? (
        <a
          className="brief-reader__section-link"
          href={row.primaryAction.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          View ↗
        </a>
      ) : null}
    </section>
  );
}
