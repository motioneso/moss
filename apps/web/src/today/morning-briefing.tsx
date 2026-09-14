import { useState } from "react";
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
import { formatDate } from "../locale/locale-format.js";
import { joinActionRowsToTasks, type DisplayedActionRow } from "./briefing-action-rows.js";
import { BriefingDialog } from "./briefing-dialog.js";
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

  const detail = detailQuery.data ?? null;
  const failed =
    detailQuery.isError ||
    detail?.state === "failed" ||
    (detail?.state === "ready" && (detail.run === null || detail.run.status !== "succeeded"));

  return (
    <BriefingDialog
      title="Morning briefing"
      opener={props.opener}
      onClose={props.onClose}
      footer={
        <Button variant="primary" onClick={props.onClose}>
          Back to Today
        </Button>
      }
    >
      <div className="brief-reader__grid">
        <div className="brief-reader__report">
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
        <details
          className="brief-reader__schedule"
          ref={(node) => {
            // Desktop starts open; the phone starts closed.
            if (!node || node.hasAttribute("data-brief-schedule")) return;
            node.toggleAttribute("data-brief-schedule", true);
            if (typeof window !== "undefined" && typeof window.matchMedia === "function")
              node.open = window.matchMedia("(min-width: 1081px)").matches;
          }}
        >
          <summary className="brief-reader__schedule-cap">Schedule</summary>
          <DayPlanSection
            dayPlan={props.dayPlan}
            events={props.events}
            locale={props.locale}
            now={props.now}
            loading={props.dayPlanLoading}
            error={props.dayPlanError}
            calendarError={props.calendarError}
            onOpenTask={props.onOpenTask}
          />
        </details>
      </div>
    </BriefingDialog>
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
      {props.detail.plan?.status === "changed" || props.detail.plan?.status === "unavailable" ? (
        <p className="brief-reader__plan-changed">The plan has changed since this report.</p>
      ) : null}
      {run.summaryText.trim() ? <BriefingProse summaryText={run.summaryText} /> : null}
      {freshness ? <BriefingStaleBanner freshness={freshness} /> : null}
      {news || sports ? (
        <nav className="brief-reader__jump" aria-label="Report sections">
          {news ? <a href="#brief-reader-news">News</a> : null}
          {sports ? <a href="#brief-reader-sports">Sports</a> : null}
        </nav>
      ) : null}
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

function EditorialBlock(props: {
  readonly id: string;
  readonly title: string;
  readonly games?: readonly SportsBriefingEvidenceGameV1[] | null;
  readonly stories: readonly {
    readonly title: string;
    readonly url: string;
    readonly imageUrl: string | null;
    readonly meta: string;
  }[];
  readonly onMoreOnToday: () => void;
}) {
  return (
    <section className="brief-reader__editorial" id={props.id} aria-label={props.title}>
      <div className="jds-brief__title">{props.title}</div>
      {props.games?.map((game) => (
        <div className="brief-reader__game" key={game.id}>
          <div className="loose-row__title">{game.headline}</div>
          <div className="loose-row__meta">
            {game.awayShort} {game.awayScore ?? ""} · {game.homeShort} {game.homeScore ?? ""} ·{" "}
            {game.statusDetail}
          </div>
        </div>
      ))}
      {props.stories.map((story) => (
        <article className="brief-reader__story" key={story.url}>
          {story.imageUrl ? (
            <img src={story.imageUrl} alt="" className="brief-reader__photo" loading="lazy" />
          ) : null}
          <a href={story.url} target="_blank" rel="noopener noreferrer">
            {story.title}
          </a>
          <div className="loose-row__meta">{story.meta}</div>
        </article>
      ))}
      <Button variant="quiet" size="sm" onClick={props.onMoreOnToday}>
        More on Today
      </Button>
    </section>
  );
}

function readGaps(
  sourceMetadata: Record<string, unknown>
): readonly { source: string; reason: string }[] {
  const gaps = sourceMetadata.gaps;
  if (!Array.isArray(gaps)) return [];
  return gaps.flatMap((gap): readonly { source: string; reason: string }[] => {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) return [];
    const record = gap as Record<string, unknown>;
    if (typeof record.source !== "string" || typeof record.reason !== "string") return [];
    return [{ source: record.source, reason: record.reason }];
  });
}

function readEditorial<T>(
  sourceMetadata: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T
): T | null {
  const editorial = sourceMetadata.editorial;
  if (!editorial || typeof editorial !== "object" || Array.isArray(editorial)) return null;
  const block = (editorial as Record<string, unknown>)[key];
  return guard(block) ? block : null;
}
