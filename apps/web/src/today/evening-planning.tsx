import { useMemo } from "react";

import type {
  BriefingRunDto,
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanDto,
  DayPlanTaskSummary,
  LocaleSettingsDto,
  TaskDto
} from "@moss/shared";

import { Button } from "@moss/ui";

import { BriefingDialog } from "./briefing-dialog.js";
import { DayPlanSection } from "./day-plan.js";
import { buildDayItems } from "./day-plan-view-model.js";
import { ReviewRow } from "./day-plan-review.js";
import type { DayPlanReviewController } from "./day-plan-review-controller.js";
import { EVENING_REVIEW_NOT_READY, SAVE_TOMORROW_LABEL, timeLabel } from "./today-labels.js";
import type { EveningPlanningController } from "./evening-planning-controller.js";
import { CommitSection, ReflectSection, ShapeSection } from "./evening-planning-sections.js";

export interface EveningPlanningDialogProps {
  readonly evening: EveningPlanningController;
  readonly review: DayPlanReviewController;
  readonly tasks: readonly TaskDto[];
  readonly taskSummaries: readonly DayPlanTaskSummary[];
  readonly unavailableTaskIds: readonly string[];
  readonly tomorrowEvents: readonly CalendarEventDto[];
  readonly completedToday: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly now: Date;
  readonly tomorrowKey: string;
  readonly eveningRun: BriefingRunDto | null;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
}

const SECTIONS = ["Reflect", "Commitments", "Shape", "Review"] as const;

function summaryFor(taskId: string, tasks: readonly TaskDto[]): DayPlanTaskSummary | undefined {
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task) return undefined;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    dueAt: task.dueAt,
    doAt: task.doAt,
    effort: task.effort
  };
}

function blockTitle(block: DayPlanBlockDto, tasks: readonly DayPlanTaskSummary[]): string {
  if (block.taskId === null) return block.title ?? "Untitled block";
  return tasks.find((task) => task.id === block.taskId)?.title ?? block.title ?? "Untitled block";
}

function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ block: "start" });
}

function ReviewSection(props: {
  readonly evening: EveningPlanningController;
  readonly review: DayPlanReviewController;
  readonly plan: DayPlanDto | null;
  readonly summaries: readonly DayPlanTaskSummary[];
  readonly unavailableTaskIds: readonly string[];
  readonly tomorrowEvents: readonly CalendarEventDto[];
  readonly locale: LocaleSettingsDto;
  readonly now: Date;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const { evening, review, plan } = props;
  const savedLabels = useMemo(() => {
    if (!plan) return new Map<string, string>();
    const items = buildDayItems({
      plan,
      tasks: props.summaries,
      unavailableTaskIds: props.unavailableTaskIds,
      events: props.tomorrowEvents,
      locale: props.locale,
      now: props.now
    });
    return new Map(items.map((item) => [item.key, item.label]));
  }, [
    plan,
    props.summaries,
    props.unavailableTaskIds,
    props.tomorrowEvents,
    props.locale,
    props.now
  ]);
  return (
    <section className="evening-plan__section" id="evening-review" aria-label="Review">
      <h3 className="evening-plan__heading">Review</h3>
      {!plan ? (
        <p className="cmd-empty">The review appears after the first save.</p>
      ) : (
        <>
          <ul className="plan-review__rows">
            {plan.blocks.map((block) => (
              <ReviewRow
                key={block.id}
                block={block}
                title={blockTitle(block, props.summaries)}
                savedLabel={savedLabels.get(`block:${block.id}`) ?? ""}
                choice={review.choiceFor(block)}
                changed={review.changedIds.includes(block.id)}
                task={
                  block.taskId !== null
                    ? props.summaries.find((entry) => entry.id === block.taskId)
                    : undefined
                }
                unavailable={
                  block.taskId !== null && props.unavailableTaskIds.includes(block.taskId)
                }
                controller={review}
                plan={plan}
                locale={props.locale}
                onOpenTask={props.onOpenTask}
              />
            ))}
          </ul>
          <div className="evening-plan__controls">
            <Button
              variant="secondary"
              disabled={review.busy || evening.busy}
              onClick={() => void review.runPreview()}
            >
              Preview changes
            </Button>
            {Object.values(review.outcomes).some(
              (item) => item.outcome === "failed" || item.outcome === "unknown"
            ) ? (
              <Button
                variant="secondary"
                disabled={review.busy}
                onClick={() => void review.retry()}
              >
                Retry
              </Button>
            ) : null}
          </div>
          {review.approval ? (
            <section className="plan-review__confirm" aria-labelledby="evening-plan-confirm">
              <h3 id="evening-plan-confirm">Confirm calendar changes</h3>
              <ul>
                {review.approval.changes.map((entry) => (
                  <li key={entry.blockId}>
                    {entry.kind === "add" ? "Add" : entry.kind === "move" ? "Move" : "Remove"}{" "}
                    {blockTitle(
                      plan.blocks.find((block) => block.id === entry.blockId) ?? {
                        id: entry.blockId,
                        kind: "focus",
                        taskId: null,
                        title: null,
                        position: 0,
                        actualPlacement: null,
                        pendingChange: null
                      },
                      props.summaries
                    )}
                    {entry.startsAt ? ` at ${timeLabel(entry.startsAt, props.locale)}` : null}
                  </li>
                ))}
              </ul>
              <p>The tasks themselves remain on your list.</p>
              <div className="plan-review__confirm-actions">
                <Button
                  variant="primary"
                  disabled={review.busy}
                  onClick={() => void evening.confirmSave()}
                >
                  Confirm
                </Button>
                <Button variant="secondary" onClick={() => evening.cancelConfirm()}>
                  Keep reviewing
                </Button>
              </div>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Evening planning dialog: reflect, commit, shape, review, one save. */
export function EveningPlanningDialog(props: EveningPlanningDialogProps) {
  const { evening, review } = props;
  const summaries = useMemo(() => {
    const known = new Map(props.taskSummaries.map((entry) => [entry.id, entry]));
    for (const task of props.tasks) {
      if (!known.has(task.id)) {
        const found = summaryFor(task.id, props.tasks);
        if (found) known.set(task.id, found);
      }
    }
    return [...known.values()];
  }, [props.taskSummaries, props.tasks]);
  const reflectTasks = useMemo(() => {
    const seen = new Set(props.completedToday.map((task) => task.id));
    const open = evening.rows
      .filter((row) => row.marked === null && row.task.status === "todo")
      .map((row) => row.task)
      .filter((task) => {
        if (seen.has(task.id)) return false;
        seen.add(task.id);
        return true;
      });
    return [...props.completedToday, ...open];
  }, [props.completedToday, evening.rows]);
  const committed = useMemo(
    () =>
      evening.rows
        .filter(
          (row) =>
            row.marked === null &&
            (evening.decisions[row.task.id]?.decision ?? row.decided) === "tomorrow"
        )
        .map((row) => row.task),
    [evening.rows, evening.decisions]
  );
  return (
    <BriefingDialog
      title="Plan tomorrow"
      opener={props.opener}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            Back to Today
          </Button>
          <Button variant="primary" disabled={evening.busy} onClick={() => void evening.save()}>
            {SAVE_TOMORROW_LABEL}
          </Button>
          <span className="evening-plan__status" role="status">
            {evening.status}
          </span>
          {evening.reviewNotice ? (
            <span className="evening-plan__notice" role="status">
              {evening.reviewNotice}
            </span>
          ) : null}
        </>
      }
    >
      <nav className="evening-plan__nav" aria-label="Plan sections">
        {SECTIONS.map((section) => (
          <Button
            key={section}
            variant="secondary"
            onClick={() => scrollToSection(`evening-${section.toLowerCase()}`)}
          >
            {section}
          </Button>
        ))}
      </nav>
      {props.eveningRun?.summaryText.trim() ? (
        <p className="evening-plan__prose">{props.eveningRun.summaryText}</p>
      ) : (
        <p className="evening-plan__prose" role="status">
          {EVENING_REVIEW_NOT_READY}
        </p>
      )}
      <div className="evening-plan__grid">
        <div>
          <ReflectSection evening={evening} tasks={reflectTasks} locale={props.locale} />
          <CommitSection
            evening={evening}
            rows={evening.rows}
            tomorrowKey={props.tomorrowKey}
            timeZone={props.locale.timezone}
          />
          <ShapeSection
            evening={evening}
            committed={committed}
            tasks={props.tasks}
            locale={props.locale}
          />
          <ReviewSection
            evening={evening}
            review={review}
            plan={evening.plan}
            summaries={summaries}
            unavailableTaskIds={props.unavailableTaskIds}
            tomorrowEvents={props.tomorrowEvents}
            locale={props.locale}
            now={props.now}
            onOpenTask={props.onOpenTask}
          />
        </div>
        <div className="evening-plan__summary">
          <details
            className="evening-plan__details"
            ref={(node) => {
              if (!node || node.hasAttribute("data-evening-plan")) return;
              node.toggleAttribute("data-evening-plan", true);
              if (typeof window !== "undefined" && typeof window.matchMedia === "function")
                node.open = window.matchMedia("(min-width: 1081px)").matches;
            }}
          >
            <summary className="evening-plan__details-cap">Tomorrow&apos;s plan</summary>
            {evening.plan ? (
              <DayPlanSection
                dayPlan={{
                  plan: evening.plan,
                  tasks: [...summaries],
                  unavailableTaskIds: [...props.unavailableTaskIds],
                  sourceRun: null,
                  sourceRunUnavailable: false
                }}
                events={props.tomorrowEvents}
                locale={props.locale}
                now={props.now}
                loading={false}
                error={false}
                calendarError={false}
                onOpenTask={props.onOpenTask}
              />
            ) : (
              <p className="cmd-empty">Nothing saved for tomorrow yet.</p>
            )}
          </details>
        </div>
      </div>
    </BriefingDialog>
  );
}
