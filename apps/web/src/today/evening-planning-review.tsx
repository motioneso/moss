import { useMemo } from "react";

import type {
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanDto,
  DayPlanTaskSummary,
  LocaleSettingsDto
} from "@moss/shared";

import { localDay } from "@moss/shared";

import { Button } from "@moss/ui";

import { buildDayItems } from "./day-plan-view-model.js";
import { draftBlocksFor } from "./day-plan-review-model.js";
import { ReviewRow } from "./day-plan-review.js";
import type { DayPlanReviewController } from "./day-plan-review-controller.js";
import {
  EVENING_REVIEW_BLOCKS_AUTO,
  EVENING_REVIEW_BLOCKS_PROPOSE,
  EVENING_REVIEW_CHANGES_AUTO,
  EVENING_REVIEW_CHANGES_PROPOSE,
  EVENING_REVIEW_EXISTING_STAY,
  EVENING_REVIEW_FOOTNOTE,
  EVENING_REVIEW_KEEP_HEADING,
  EVENING_REVIEW_MESSAGE,
  EVENING_REVIEW_NO_CHANGES,
  EVENING_REVIEW_NO_CHANGE_HEADING,
  EVENING_REVIEW_NOTE,
  EVENING_REVIEW_NOTES_HEADING,
  EVENING_REVIEW_PROSE_AUTO,
  EVENING_REVIEW_PROSE_PROPOSE,
  EVENING_REVIEW_UNSCHEDULED_HEADING,
  timeLabel
} from "./today-labels.js";
import { StepIntro } from "./evening-planning-sections.js";
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
  readonly tomorrowKey: string;
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
  const effectivePendingChanges = new Map(
    plan
      ? draftBlocksFor(plan, review.choiceFor).map(
          (block) => [block.id, block.pendingChange] as const
        )
      : []
  );
  const reviewedBlocks = plan
    ? plan.blocks.map((block) => ({
        ...block,
        pendingChange: effectivePendingChanges.get(block.id) ?? null
      }))
    : [];
  const changed = reviewedBlocks.filter((block) => block.pendingChange !== null);
  const kept = reviewedBlocks.filter((block) => block.pendingChange === null);
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
  const fixedEvents = props.tomorrowEvents.filter(
    (event) => localDay(event.startsAt, props.locale.timezone) === props.tomorrowKey
  );
  const notes = evening.activeNotes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const failed = Object.values(review.outcomes).some(
    (item) => item.outcome === "failed" || item.outcome === "unknown"
  );
  return (
    <section className="evening-plan__section" id="evening-review" aria-label="Review">
      <StepIntro
        note={EVENING_REVIEW_NOTE}
        message={EVENING_REVIEW_MESSAGE}
        headingId="evening-review-heading"
      />
      <p className="evening-plan__prose">
        {evening.policyMode === "auto" ? EVENING_REVIEW_PROSE_AUTO : EVENING_REVIEW_PROSE_PROPOSE}
      </p>
      {fixedEvents.length > 0 ? (
        <div className="evening-plan__record">
          <span>{EVENING_REVIEW_KEEP_HEADING}</span>
          <strong>{fixedEvents.map((event) => event.title).join(", ")}</strong>
        </div>
      ) : null}
      {!plan ? (
        <p className="evening-plan__muted">The review appears after the first save.</p>
      ) : (
        <>
          <section className="evening-plan__actions" aria-labelledby="evening-review-blocks">
            <h4 id="evening-review-blocks">
              {evening.policyMode === "auto"
                ? EVENING_REVIEW_BLOCKS_AUTO
                : EVENING_REVIEW_BLOCKS_PROPOSE}
            </h4>
            {plan.blocks.length > 0 ? (
              <ul className="plan-review__rows">
                {changed.map(reviewRow)}
                {kept.map(reviewRow)}
              </ul>
            ) : (
              <p className="evening-plan__muted">{EVENING_REVIEW_NO_CHANGES}</p>
            )}
          </section>
          {noChangeRows.map((row) => {
            const current = evening.decisions[row.task.id]?.decision ?? row.decided;
            return (
              <div className="evening-plan__record" key={row.task.id}>
                <span>
                  {current === "unscheduled"
                    ? EVENING_REVIEW_UNSCHEDULED_HEADING
                    : EVENING_REVIEW_NO_CHANGE_HEADING}
                </span>
                <strong>
                  {current === "unscheduled"
                    ? `${row.task.title} stays on your task list`
                    : `${row.task.title} is still undecided`}
                </strong>
              </div>
            );
          })}
          {review.approval ? (
            <section className="evening-plan__notes" aria-labelledby="evening-plan-confirm">
              <h4 id="evening-plan-confirm">Confirm calendar changes</h4>
              {review.approval.changes.map((entry) => (
                <p key={entry.blockId}>
                  {entry.kind === "add" ? "Add" : entry.kind === "move" ? "Move" : "Remove"}{" "}
                  {`\u201c${blockTitle(
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
                  )}\u201d`}
                  {entry.startsAt ? ` at ${timeLabel(entry.startsAt, props.locale)}` : null}.
                </p>
              ))}
              <p>The tasks themselves remain on your list.</p>
              <div className="evening-plan__confirm-actions">
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
          {!review.approval ? (
            <div className="evening-plan__notes">
              <h4>
                {evening.policyMode === "auto"
                  ? EVENING_REVIEW_CHANGES_AUTO
                  : EVENING_REVIEW_CHANGES_PROPOSE}
              </h4>
              {changed.length > 0 ? (
                changed.map((block) => {
                  const pending = block.pendingChange!;
                  const title = `\u201c${blockTitle(block, props.summaries)}\u201d`;
                  return (
                    <p key={block.id}>
                      {pending.kind === "remove"
                        ? `Remove ${title}.`
                        : `${pending.kind === "add" ? "Add" : "Move"} ${title} ${
                            pending.kind === "add" ? "at" : "to"
                          } ${timeLabel(pending.startsAt, props.locale)}.`}
                    </p>
                  );
                })
              ) : (
                <p>{EVENING_REVIEW_NO_CHANGES}</p>
              )}
              {evening.policyMode !== "auto" && kept.length + changed.length > 0 ? (
                <p>{EVENING_REVIEW_EXISTING_STAY}</p>
              ) : null}
            </div>
          ) : null}
          <div className="evening-plan__review-links">
            <button
              type="button"
              className="evening-plan__link"
              disabled={review.busy || evening.busy}
              onClick={() => void review.runPreview()}
            >
              Preview changes
            </button>
            {failed ? (
              <button
                type="button"
                className="evening-plan__link"
                disabled={review.busy}
                onClick={() => void review.retry()}
              >
                Retry
              </button>
            ) : null}
          </div>
          {notes.length > 0 ? (
            <div className="evening-plan__notes">
              <h4>{EVENING_REVIEW_NOTES_HEADING}</h4>
              {notes.map((note, index) => (
                <p key={index}>{note}</p>
              ))}
            </div>
          ) : null}
          <p className="evening-plan__muted">{EVENING_REVIEW_FOOTNOTE}</p>
        </>
      )}
    </section>
  );
}
