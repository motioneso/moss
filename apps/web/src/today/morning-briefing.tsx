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
  const reviewLabel =
    settingsQuery.data?.settings?.timeBlockMode === "auto"
      ? "Adjust task blocks"
      : "Review task blocks";
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
      reviewTabLabel={reviewLabel}
      onSelectReviewTab={openReaderReview}
      jumpLinks={
        newsPreview || sportsPreview ? (
          <nav className="brief-reader__jump" aria-label="Report sections">
            {newsPreview ? <a href="#brief-reader-news">News</a> : null}
            {sportsPreview ? <a href="#brief-reader-sports">Sports</a> : null}
          </nav>
        ) : null
      }
      report={
        detail?.state === "ready" && detail.run !== null && detail.run.status === "succeeded" ? (
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
        )
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
        />
      }
      footerActions={
        <>
          {acceptBlocked || acceptSelection.length > 0 ? (
            <Button
              variant="primary"
              ref={acceptRef}
              disabled={!acceptBlocked && (accepting || props.controller.busy)}
              onClick={acceptBlocked ? openReaderReview : () => void runAcceptAll()}
            >
              {acceptBlocked
                ? acceptLabels.REVIEW_CHANGES_LABEL
                : accepting
                  ? acceptLabels.ACCEPTING_LABEL
                  : acceptLabels.ACCEPT_ALL_LABEL}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={openReaderReview}>
            {reviewLabel}
          </Button>
          {acceptPhase !== "idle" ? (
            <p className="brief-reader__accept-status" role="status">
              {acceptStatus.line} {acceptReviewButton}
            </p>
          ) : null}
        </>
      }
      footerBack={
        <Button variant="primary" ref={backRef} onClick={props.onClose}>
          Back to Today
        </Button>
      }
    />
  );
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
  const tasksById = new Map(props.tasks.map((task) => [task.id, task]));

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
        <div className="brief-reader__callout">
          <p className="brief-reader__callout-kicker">Changed overnight</p>
          <p className="brief-reader__plan-changed">The plan has changed since this report.</p>
        </div>
      ) : null}
      {freshness ? <BriefingStaleBanner freshness={freshness} /> : null}
      {planContext ? <PlanContextBlock planContext={planContext} tasksById={tasksById} /> : null}
      {run.structuredPayload.actionRows.length > 0 ? (
        <ActionRowsBlock run={run} tasks={props.tasks} />
      ) : null}
      {news ? (
        <EditorialBlock
          id="brief-reader-news"
          title="News"
          stories={news.stories.map((story) => ({
            title: story.title,
            url: story.url,
            imageUrl: story.imageUrl,
            meta: `${story.sourceLabel}${story.summary ? ` · ${story.summary}` : ""}`
          }))}
          onMoreOnToday={props.onMoreOnToday}
        />
      ) : null}
      {sports ? (
        <EditorialBlock
          id="brief-reader-sports"
          title="Sports"
          games={sports.games}
          stories={sports.stories.map((story) => ({
            title: story.title,
            url: story.url,
            imageUrl: story.imageUrl,
            meta: story.publisherLabel
          }))}
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

function PlanContextBlock(props: {
  readonly planContext: BriefingPlanContextV1;
  readonly tasksById: ReadonlyMap<string, TaskDto>;
}) {
  const intent = props.planContext.eveningIntent;
  if (!intent && props.planContext.blocks.length === 0) return null;
  return (
    <div className="brief-reader__plan">
      {intent ? (
        <>
          <span className="jds-brief__kicker">Evening intent</span>
          {intent.capacity ? <p>Capacity: {intent.capacity}</p> : null}
          {intent.notes ? <p>{intent.notes}</p> : null}
          {intent.priorityTaskIds.length > 0 ? (
            <ul>
              {intent.priorityTaskIds.map((taskId) => (
                <li key={taskId}>{props.tasksById.get(taskId)?.title ?? "No longer available"}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {props.planContext.blocks.length > 0 ? (
        <>
          <span className="jds-brief__kicker">Plan</span>
          <ul>
            {props.planContext.blocks.map((block) => (
              <li key={block.id}>
                {block.title ?? block.kind} · {block.pendingChange ? "proposed" : "committed"}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function ActionRowsBlock(props: {
  readonly run: BriefingRunDto;
  readonly tasks: readonly TaskDto[];
}) {
  const displayed = joinActionRowsToTasks(props.run.structuredPayload.actionRows, props.tasks);
  const shown = new Set(displayed.map((entry) => entry.row.taskId));
  const dropped = props.run.structuredPayload.actionRows.filter((row) => !shown.has(row.taskId));
  return (
    <div className="brief-reader__rows">
      <span className="jds-brief__kicker">Needs you</span>
      {displayed.map((entry) => (
        <JoinedRow key={entry.row.taskId} entry={entry} />
      ))}
      {dropped.map((row) => (
        <p key={row.taskId} className="brief-reader__gap">
          No longer available
        </p>
      ))}
    </div>
  );
}

function JoinedRow(props: { readonly entry: DisplayedActionRow }) {
  const row = props.entry.row;
  return (
    <div className="loose-row">
      <div className="loose-row__main">
        <div className="loose-row__title">{row.title}</div>
        <div className="loose-row__meta">{row.explanation}</div>
        <div className="loose-row__meta">{row.sourceLabel}</div>
      </div>
      {row.primaryAction?.kind === "view" ? (
        <a
          className="jds-btn jds-btn--sm jds-btn--quiet"
          href={row.primaryAction.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          View
        </a>
      ) : null}
    </div>
  );
}
