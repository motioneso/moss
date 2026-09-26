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

import { getBriefingRun, requestJson } from "../api/client.js";
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
  delayedEmailSource,
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

export function dayPlanReviewUnavailableMessage(input: {
  readonly dayPlan: GetDayPlanResponse | undefined;
  readonly loading: boolean;
  readonly error: boolean;
}): string | null {
  if (input.loading) return "Today's plan is still loading.";
  if (input.error) return "Today's plan couldn't be loaded.";
  if (input.dayPlan?.plan == null) return "There is no saved plan to review today.";
  return null;
}

/** Full morning report for one run, from the run response only. Nothing here writes. */
export function MorningBriefingReader(props: MorningBriefingReaderProps) {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState(props.initialRunId);
  const [retryRunId, setRetryRunId] = useState<string | null>(null);
  const detailQuery = useQuery({
    queryKey: queryKeys.briefings.run(props.definitionId, selectedRunId),
    queryFn: () => getBriefingRun(props.definitionId, selectedRunId),
    refetchInterval: (query) => {
      if (selectedRunId !== retryRunId) return false;
      const state = query.state.data?.state;
      return state === "ready" || state === "failed" ? false : 1000;
    }
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
      setRetryRunId(data.runId);
      setSelectedRunId(data.runId);
    }
  });
  const [reviewAttempted, setReviewAttempted] = useState(false);

  // The Read tab always reads "Review task blocks"; the automatic Read's
  // own footer button always reads "Adjust task blocks" (B10). This is
  // fixed wording for that surface, not the settings-level auto/suggest
  // mode — the footer button below only ever renders on the
  // automatic-read surface, never on proposed-read.
  const reviewTabLabel = "Review task blocks";
  const footerAdjustLabel = "Adjust task blocks";
  const reviewUnavailableMessage = reviewAttempted
    ? dayPlanReviewUnavailableMessage({
        dayPlan: props.dayPlan,
        loading: props.dayPlanLoading,
        error: props.dayPlanError
      })
    : null;
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
  const openReaderReview = (event: { currentTarget: HTMLElement }) => {
    if (
      dayPlanReviewUnavailableMessage({
        dayPlan: props.dayPlan,
        loading: props.dayPlanLoading,
        error: props.dayPlanError
      })
    ) {
      setReviewAttempted(true);
      return;
    }
    setReviewAttempted(false);
    props.onReview(event.currentTarget);
  };
  // Jump links scroll their section to the report top and move keyboard
  // focus to its heading, instead of leaving focus behind on the link.
  const jumpTo = (sectionId: string) => (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const section = document.getElementById(sectionId);
    // scrollIntoView is absent under jsdom (no layout engine), so guard the
    // call itself rather than just the element.
    section?.scrollIntoView?.({ block: "start" });
    section?.focus();
  };
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
  const retryingRun = selectedRunId === retryRunId;
  const failed =
    (detailQuery.isError && !retryingRun) ||
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
            {newsPreview ? (
              <a href="#brief-reader-news" onClick={jumpTo("brief-reader-news")}>
                News ↓
              </a>
            ) : null}
            {sportsPreview ? (
              <a href="#brief-reader-sports" onClick={jumpTo("brief-reader-sports")}>
                Sports ↓
              </a>
            ) : null}
          </nav>
        ) : null
      }
      report={
        <div data-briefing-surface={briefingSurface}>
          {reviewUnavailableMessage ? (
            <p className="cmd-empty" role="status">
              {reviewUnavailableMessage}
            </p>
          ) : null}
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
                <>
                  {retryMutation.isError ? (
                    <p className="brief-reader__retry-error" role="status">
                      The retry request couldn’t be confirmed. Your task-block choices are still
                      here; try again.
                    </p>
                  ) : null}
                  <Button
                    variant="secondary"
                    disabled={retryMutation.isPending}
                    onClick={() => retryMutation.mutate()}
                  >
                    Try again
                  </Button>
                </>
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
          snapshot
          showEditorialHeading={false}
          // Only the proposed Read says "Proposed" on a rail row: Moss has
          // already placed the automatic Read's blocks, so it keeps the
          // plain caption (Architect R1.2, F1).
          proposedCaption={briefingSurface === "proposed-read" ? "short" : undefined}
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
        ) : acceptPrimaryButton ? (
          <>
            <span className="brief-reader__review-link">
              <Button variant="quiet" onClick={openReaderReview}>
                {footerAdjustLabel}
              </Button>
            </span>
            {acceptPrimaryButton}
          </>
        ) : (
          // Nothing awaits acceptance: "Adjust task blocks" is the only
          // action, so it takes the primary button instead of leaving the
          // footer with no primary at all.
          <Button variant="primary" onClick={openReaderReview}>
            {footerAdjustLabel}
          </Button>
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
  const delayedEmail = delayedEmailSource(freshness);
  const gaps = readGaps(run.sourceMetadata);
  const dayPlanReadFailed = gaps.some(
    (gap) => gap.source === "day_plan" && gap.reason === "tool_failed"
  );
  const noEveningPlan =
    !dayPlanReadFailed &&
    (run.structuredPayload.planContext === null || planContext?.eveningIntent === null);
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
      {noEveningPlan ? (
        <p className="brief-reader__plan-source">
          No evening priorities were available for this briefing. Moss used today’s available
          sources, including tasks and calendar.
        </p>
      ) : null}
      {props.detail.plan?.status === "changed" || props.detail.plan?.status === "unavailable" ? (
        <BriefingCallout
          before={planContext}
          after={props.detail.plan.current}
          locale={props.locale}
        />
      ) : null}
      {delayedEmail ? (
        <div className="brief-reader__email-delay" role="note">
          <p>
            <strong>
              Email hasn’t updated since{" "}
              <time dateTime={delayedEmail.asOf}>
                {formatDate(delayedEmail.asOf, props.locale, { month: "long", day: "numeric" })} at{" "}
                {formatTime(delayedEmail.asOf, props.locale)}
              </time>
              .
            </strong>
          </p>
          <p>
            There may be newer replies this briefing hasn’t seen. Calendar and task details remain
            available.
          </p>
        </div>
      ) : null}
      {freshness ? (
        <BriefingStaleBanner freshness={freshness} excludeSources={delayedEmail ? ["email"] : []} />
      ) : null}
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
