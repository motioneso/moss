import { useMemo } from "react";

import type {
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanDto,
  DayPlanTaskSummary,
  LocaleSettingsDto
} from "@moss/shared";

import { Button } from "@moss/ui";

import { buildDayItems } from "./day-plan-view-model.js";
import { ReviewRow } from "./day-plan-review.js";
import type { DayPlanReviewController } from "./day-plan-review-controller.js";
import {
  EVENING_REVIEW_CHANGES_HEADING,
  EVENING_REVIEW_KEEP_HEADING,
  EVENING_REVIEW_MESSAGE,
  EVENING_REVIEW_NO_CHANGES,
  EVENING_REVIEW_NO_CHANGE_HEADING,
  EVENING_REVIEW_NOTE,
  EVENING_SPEAKER_NAME,
  timeLabel
} from "./today-labels.js";
import type { EveningPlanningController } from "./evening-planning-controller.js";
import type { CommitmentRow } from "./evening-planning-model.js";

function blockTitle(block: DayPlanBlockDto, tasks: readonly DayPlanTaskSummary[]): string {
  if (block.taskId === null) return block.title ?? "Untitled block";
  return tasks.find((task) => task.id === block.taskId)?.title ?? block.title ?? "Untitled block";
}

/** Review step: grouped saved blocks plus undecided commitments, preview and confirm below. */
export function ReviewSection(props: {
  readonly evening: EveningPlanningController;
  readonly review: DayPlanReviewController;
  readonly plan: DayPlanDto | null;
  readonly rows: readonly CommitmentRow[];
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
  const changed = useMemo(
    () => (plan ? plan.blocks.filter((block) => block.pendingChange !== null) : []),
    [plan]
  );
  const kept = useMemo(
    () => (plan ? plan.blocks.filter((block) => block.pendingChange === null) : []),
    [plan]
  );
  const noChangeRows = useMemo(
    () =>
      props.rows.filter((row) => {
        const current = evening.decisions[row.task.id]?.decision ?? row.decided;
        return current === null || current === "unscheduled";
      }),
    [props.rows, evening.decisions]
  );
  function reviewRow(block: DayPlanBlockDto) {
    return (
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
        unavailable={block.taskId !== null && props.unavailableTaskIds.includes(block.taskId)}
        controller={review}
        plan={plan!}
        locale={props.locale}
        onOpenTask={props.onOpenTask}
      />
    );
  }
  return (
    <section className="evening-plan__section" id="evening-review" aria-label="Review">
      <h3 id="evening-review-heading" tabIndex={-1} className="evening-plan__heading">
        Review
      </h3>
      <div className="evening-plan__speaker">
        <span className="evening-plan__initial" aria-hidden="true">
          {EVENING_SPEAKER_NAME.slice(0, 1)}
        </span>
        <div>
          {EVENING_SPEAKER_NAME}
          <small>{EVENING_REVIEW_NOTE}</small>
        </div>
      </div>
      <p className="evening-plan__lede" tabIndex={-1}>
        {EVENING_REVIEW_MESSAGE}
      </p>
      {!plan ? (
        <p className="cmd-empty">The review appears after the first save.</p>
      ) : (
        <>
          {changed.length > 0 ? (
            <section className="evening-plan__group" aria-label={EVENING_REVIEW_CHANGES_HEADING}>
              <h4 className="evening-plan__eyebrow">{EVENING_REVIEW_CHANGES_HEADING}</h4>
              <ul className="plan-review__rows">{changed.map(reviewRow)}</ul>
            </section>
          ) : (
            <section className="evening-plan__group" aria-label={EVENING_REVIEW_CHANGES_HEADING}>
              <h4 className="evening-plan__eyebrow">{EVENING_REVIEW_CHANGES_HEADING}</h4>
              <p className="cmd-empty">{EVENING_REVIEW_NO_CHANGES}</p>
            </section>
          )}
          {kept.length > 0 ? (
            <section className="evening-plan__group" aria-label={EVENING_REVIEW_KEEP_HEADING}>
              <h4 className="evening-plan__eyebrow">{EVENING_REVIEW_KEEP_HEADING}</h4>
              <ul className="plan-review__rows">{kept.map(reviewRow)}</ul>
            </section>
          ) : null}
          {noChangeRows.length > 0 ? (
            <section className="evening-plan__group" aria-label={EVENING_REVIEW_NO_CHANGE_HEADING}>
              <h4 className="evening-plan__eyebrow">{EVENING_REVIEW_NO_CHANGE_HEADING}</h4>
              <ul className="evening-plan__rows">
                {noChangeRows.map((row) => {
                  const current = evening.decisions[row.task.id]?.decision ?? row.decided;
                  return (
                    <li className="evening-plan__row" key={row.task.id}>
                      <div>
                        <div className="evening-plan__title">{row.task.title}</div>
                        <div className="evening-plan__state">
                          {current === "unscheduled" ? "Keep on the list" : "Undecided"}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
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
