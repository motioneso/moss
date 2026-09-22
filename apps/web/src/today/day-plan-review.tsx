import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type {
  CalendarEventDto,
  DayPlanDto,
  DayPlanTaskSummary,
  LocaleSettingsDto
} from "@moss/shared";

import { Button } from "@moss/ui";

import { getCalendarBriefingSettings } from "../api/client.js";
import { DayPlanSection } from "./day-plan.js";
import { buildDayItems } from "./day-plan-view-model.js";
import {
  ACCEPT_ALL_LABEL,
  REVIEW_NO_CHANGES_SELECTED,
  REVIEW_WHAT_WILL_CHANGE_HEADING,
  timeLabel
} from "./today-labels.js";
import type { DayPlanReviewController } from "./day-plan-review-controller.js";
import {
  acceptAllSelectionFor,
  effectivePending,
  hasOtherPendingEdits,
  previewSelectionFor
} from "./day-plan-review-model.js";
import { BriefingReportShell } from "./briefing-report-shell.js";
import { ReviewRow, rowTitle } from "./day-plan-review-row.js";

export interface DayPlanReviewProps {
  readonly controller: DayPlanReviewController;
  readonly plan: DayPlanDto;
  readonly tasks: readonly DayPlanTaskSummary[];
  readonly unavailableTaskIds: readonly string[];
  readonly events: readonly CalendarEventDto[];
  readonly locale: LocaleSettingsDto;
  readonly now: Date;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onSelectBriefingTab?: (event: { currentTarget: HTMLElement }) => void;
}

/** Evening planning still renders rows from the review file (T20). */
export { ReviewRow } from "./day-plan-review-row.js";

function approvalTitle(
  blockId: string,
  plan: DayPlanDto,
  tasks: readonly DayPlanTaskSummary[]
): string {
  const block = plan.blocks.find((entry) => entry.id === blockId);
  return block ? rowTitle(block, tasks) : "A block";
}

/** Individual review of the plan's task blocks inside the briefing dialog shell. */
export function DayPlanReview(props: DayPlanReviewProps) {
  const { controller, plan } = props;
  const settingsQuery = useQuery({
    queryKey: ["calendar", "briefing-settings"],
    queryFn: getCalendarBriefingSettings,
    retry: false
  });
  const automatic = settingsQuery.data?.settings?.timeBlockMode === "auto";
  const title = automatic ? "Adjust task blocks" : "Review task blocks";
  const savedLabels = useMemo(() => {
    const items = buildDayItems({
      plan,
      tasks: props.tasks,
      unavailableTaskIds: props.unavailableTaskIds,
      events: props.events,
      locale: props.locale,
      now: props.now
    });
    return new Map(items.map((item) => [item.key, item.label]));
  }, [plan, props.tasks, props.unavailableTaskIds, props.events, props.locale, props.now]);

  const touched = new Set(controller.touchedIds);
  const changes = plan.blocks.flatMap((block) => {
    if (!touched.has(block.id)) return [];
    const effective = effectivePending(block, controller.choiceFor(block));
    if (effective === undefined || effective === null) return [];
    return [{ block, title: rowTitle(block, props.tasks), change: effective }];
  });
  const selectedCount = previewSelectionFor(
    plan,
    controller.choiceFor,
    controller.touchedIds
  ).length;
  const acceptBlocked = hasOtherPendingEdits(plan, controller.choiceFor, controller.touchedIds);
  const acceptSelection = acceptBlocked
    ? []
    : acceptAllSelectionFor(plan, controller.choiceFor, controller.touchedIds);
  const conflicted = new Set((controller.preview?.conflicts ?? []).map((e) => e.blockId));
  const raw =
    !controller.preview || controller.stalePreview ? [] : controller.preview.eligibleBlockIds;
  const eligible = raw.filter((id) => !conflicted.has(id));
  const unavailableCalendar = controller.preview?.calendarAvailability === "unavailable";
  const items = Object.values(controller.outcomes);
  const applied = items.filter((item) => item.outcome === "applied").length;
  const failed = items.filter((item) => item.outcome === "failed").length;
  const pending = items.filter(
    (item) => item.outcome === "pending" || item.outcome === "unknown"
  ).length;

  return (
    <BriefingReportShell
      eyebrow="Moss / Morning briefing"
      title={title}
      opener={props.opener}
      onClose={props.onClose}
      reviewTabLabel={title}
      onSelectReviewTab={() => undefined}
      selectedTab="review"
      onSelectBriefingTab={props.onSelectBriefingTab}
      jumpLinks={null}
      report={
        <div data-briefing-surface="review">
          <h3 className="brief-reader__headline">Make the plan fit.</h3>
          <p className="plan-review__lede">
            Meetings, lunch, and travel stay in place. Adjust the task blocks around them.
          </p>
          <ul className="plan-review__rows">
            {plan.blocks.map((block) => {
              const task =
                block.taskId !== null
                  ? props.tasks.find((entry) => entry.id === block.taskId)
                  : undefined;
              return (
                <ReviewRow
                  key={block.id}
                  block={block}
                  title={rowTitle(block, props.tasks)}
                  savedLabel={savedLabels.get(`block:${block.id}`) ?? ""}
                  choice={controller.choiceFor(block)}
                  changed={controller.changedIds.includes(block.id)}
                  task={task}
                  unavailable={
                    block.taskId !== null && props.unavailableTaskIds.includes(block.taskId)
                  }
                  controller={controller}
                  plan={plan}
                  locale={props.locale}
                  onOpenTask={props.onOpenTask}
                  calendarTimeField
                />
              );
            })}
          </ul>
          {controller.preview?.calendarAvailability === "stale" ? (
            <p className="plan-review__hint">
              Calendar data may be stale; conflicts are not confirmed live.
            </p>
          ) : null}
          {unavailableCalendar ? (
            <p className="plan-review__hint" role="status">
              The calendar is unavailable, so nothing can be applied until it returns.
            </p>
          ) : null}
          <div className="plan-review__changes">
            <h3 className="plan-review__changes-title">{REVIEW_WHAT_WILL_CHANGE_HEADING}</h3>
            {changes.length > 0 ? (
              <ul>
                {changes.map(({ block, title: name, change }) => (
                  <li key={block.id}>
                    {change.kind === "add" ? "Add" : change.kind === "move" ? "Move" : "Remove"}{" "}
                    {name}
                    {change.kind !== "remove" && change.startsAt
                      ? ` at ${timeLabel(change.startsAt, props.locale)}`
                      : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="plan-review__empty">{REVIEW_NO_CHANGES_SELECTED}</p>
            )}
          </div>
          {controller.approval ? (
            <section className="plan-review__confirm" aria-labelledby="plan-review-confirm">
              <h3 id="plan-review-confirm">Confirm calendar changes</h3>
              <ul>
                {controller.approval.changes.map((entry) => (
                  <li key={entry.blockId}>
                    {entry.kind === "add" ? "Add" : entry.kind === "move" ? "Move" : "Remove"}{" "}
                    {approvalTitle(entry.blockId, plan, props.tasks)}
                    {entry.startsAt ? ` at ${timeLabel(entry.startsAt, props.locale)}` : null}
                  </li>
                ))}
              </ul>
              <p>The tasks themselves remain on your list.</p>
              <div className="plan-review__confirm-actions">
                <Button
                  variant="primary"
                  disabled={controller.busy}
                  onClick={() => void controller.confirm()}
                >
                  Confirm
                </Button>
                <Button variant="secondary" onClick={() => controller.dismissApproval()}>
                  Keep reviewing
                </Button>
              </div>
            </section>
          ) : null}
          {items.length > 0 ? (
            <div className="plan-review__status">
              <p role="status">
                Applied {applied}; {failed} failed; {pending} pending.
                {applied > 0 && failed + pending > 0
                  ? " Partially applied; applied writes stand."
                  : null}
              </p>
              {items.some((item) => item.outcome === "failed" || item.outcome === "unknown") ? (
                <Button
                  variant="secondary"
                  disabled={controller.busy}
                  onClick={() => void controller.retry()}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
          {controller.notice ? (
            <p className="plan-review__hint" role="status">
              {controller.notice}
            </p>
          ) : null}
        </div>
      }
      railDateInput={props.now}
      locale={props.locale}
      railHeading="Your day, in order."
      rail={
        <DayPlanSection
          showEditorialHeading={false}
          dayPlan={{
            plan,
            tasks: [...props.tasks],
            unavailableTaskIds: [...props.unavailableTaskIds],
            sourceRun: null,
            sourceRunUnavailable: false
          }}
          events={props.events}
          locale={props.locale}
          now={props.now}
          loading={false}
          error={false}
          calendarError={false}
          onOpenTask={props.onOpenTask}
          editorial
        />
      }
      footerBack={
        <Button variant="secondary" onClick={props.onClose}>
          Back to Today
        </Button>
      }
      footerActions={
        <>
          <Button
            variant="secondary"
            disabled={controller.busy || selectedCount === 0}
            onClick={() => void controller.runPreview()}
          >
            Preview changes
          </Button>
          <Button
            variant="primary"
            disabled={
              controller.busy ||
              controller.preview === null ||
              controller.stalePreview ||
              eligible.length === 0 ||
              unavailableCalendar
            }
            onClick={() => void controller.apply(eligible)}
          >
            Apply changes
          </Button>
          {acceptSelection.length > 0 ? (
            <Button
              variant="primary"
              disabled={controller.busy}
              onClick={() => void controller.acceptAllAdditions()}
            >
              {ACCEPT_ALL_LABEL}
            </Button>
          ) : null}
        </>
      }
    />
  );
}
