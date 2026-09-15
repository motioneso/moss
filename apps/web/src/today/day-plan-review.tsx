import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type {
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanDto,
  DayPlanTaskSummary,
  LocaleSettingsDto
} from "@moss/shared";

import { Button, Select } from "@moss/ui";

import { getCalendarBriefingSettings } from "../api/client.js";
import { DayPlanSection } from "./day-plan.js";
import { BriefingDialog } from "./briefing-dialog.js";
import { buildDayItems } from "./day-plan-view-model.js";
import { ACCEPT_ALL_LABEL, shortDate, timeLabel } from "./today-labels.js";
import type { DayPlanReviewController } from "./day-plan-review-controller.js";
import {
  acceptAllSelectionFor,
  blockDuration,
  conflictText,
  effectivePending,
  hasOtherPendingEdits,
  ineligibleWord,
  isoToLocalTime,
  localTimeToIso,
  outcomeWord,
  previewSelectionFor,
  samePending,
  transientWord,
  type BlockChoice,
  type ReviewPlacement
} from "./day-plan-review-model.js";

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
}

const PLACEMENT_OPTIONS: Record<"scheduled" | "open", { value: ReviewPlacement; label: string }[]> =
  {
    scheduled: [
      { value: "keep", label: "Keep as is" },
      { value: "move", label: "Move" },
      { value: "remove", label: "Remove" }
    ],
    open: [
      { value: "add", label: "Add to calendar" },
      { value: "keep-proposed", label: "Keep proposed" },
      { value: "leave", label: "Leave unscheduled" }
    ]
  };

function rowTitle(block: DayPlanBlockDto, tasks: readonly DayPlanTaskSummary[]): string {
  if (block.taskId === null) return block.title ?? "Untitled block";
  return tasks.find((task) => task.id === block.taskId)?.title ?? block.title ?? "Untitled block";
}

function approvalTitle(
  blockId: string,
  plan: DayPlanDto,
  tasks: readonly DayPlanTaskSummary[]
): string {
  const block = plan.blocks.find((entry) => entry.id === blockId);
  return block ? rowTitle(block, tasks) : "A block";
}

function ReviewRow(props: {
  readonly block: DayPlanBlockDto;
  readonly title: string;
  readonly savedLabel: string;
  readonly choice: BlockChoice;
  readonly changed: boolean;
  readonly task: DayPlanTaskSummary | undefined;
  readonly unavailable: boolean;
  readonly controller: DayPlanReviewController;
  readonly plan: DayPlanDto;
  readonly locale: LocaleSettingsDto;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const { block, controller } = props;
  if (props.unavailable) {
    return (
      <li className="plan-review__row">
        <div className="plan-review__title">{props.title}</div>
        <div className="plan-review__state">No longer available</div>
      </li>
    );
  }
  const onCalendar = block.actualPlacement?.startsAt != null;
  const effective = effectivePending(block, props.choice);
  const changed = effective !== undefined && !samePending(effective, block.pendingChange ?? null);
  const transient = transientWord(changed, effective?.kind, onCalendar);
  const detail = controller.preview?.blocks.find((entry) => entry.blockId === block.id) ?? null;
  const conflicts = (controller.preview?.conflicts ?? []).filter(
    (conflict) => conflict.blockId === block.id
  );
  const outcome = controller.outcomes[block.id] ?? null;
  const schedulable = blockDuration(block) !== null;
  const timeValue = props.choice.startsAt
    ? isoToLocalTime(props.choice.startsAt, props.plan.timeZone)
    : "";
  return (
    <li className="plan-review__row">
      <div>
        {block.taskId !== null ? (
          <button
            type="button"
            className="plan-review__titlelink"
            onClick={() => props.onOpenTask(block.taskId!)}
          >
            {props.title}
          </button>
        ) : (
          <div className="plan-review__title">{props.title}</div>
        )}
        <div className="plan-review__state">{transient ?? props.savedLabel}</div>
        {props.changed ? (
          <div className="plan-review__changed">Changed since you started</div>
        ) : null}
        {props.choice.placement === "leave" && props.task?.dueAt ? (
          <div className="plan-review__hint">
            Due {shortDate(props.task.dueAt, props.locale)}, no time set
          </div>
        ) : null}
        {detail && !detail.eligible ? (
          <div className="plan-review__hint">{ineligibleWord(detail.ineligibleReason)}</div>
        ) : null}
        {detail?.deadlineRisk ? <div className="plan-review__hint">Deadline risk</div> : null}
        {conflicts.map((conflict) => (
          <div
            className="plan-review__hint"
            key={`${conflict.kind}-${conflict.withBlockId ?? "cal"}`}
          >
            {conflictText(conflict, props.locale)}
          </div>
        ))}
        {outcome ? <div className="plan-review__hint">{outcomeWord(outcome)}</div> : null}
      </div>
      <div className="plan-review__controls">
        <Select
          aria-label={`${props.title}: placement`}
          value={props.choice.placement}
          onChange={(event) =>
            controller.setPlacement(
              block.id,
              event.target.value as ReviewPlacement,
              block.pendingChange?.kind !== "remove"
                ? (block.pendingChange?.startsAt ?? block.actualPlacement?.startsAt ?? null)
                : null
            )
          }
        >
          {PLACEMENT_OPTIONS[onCalendar ? "scheduled" : "open"].map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={!schedulable && (option.value === "add" || option.value === "move")}
            >
              {option.label}
            </option>
          ))}
        </Select>
        {props.choice.placement === "add" || props.choice.placement === "move" ? (
          <input
            type="time"
            aria-label={`${props.title}: start time`}
            className="plan-review__time"
            disabled={!schedulable || controller.busy}
            value={timeValue}
            onChange={(event) => {
              const iso = localTimeToIso(
                props.plan.localDay,
                event.target.value,
                props.plan.timeZone
              );
              controller.setTime(block.id, iso);
            }}
          />
        ) : null}
      </div>
    </li>
  );
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
    <BriefingDialog
      title={title}
      opener={props.opener}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            Back to Today
          </Button>
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
    >
      <div className="plan-review__grid">
        <div>
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
          {changes.length > 0 ? (
            <div className="plan-review__changes">
              <h3 className="plan-review__changes-title">Changes</h3>
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
            </div>
          ) : null}
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
            <div className="plan-review__outcomes">
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
        <div className="plan-review__schedule">
          <DayPlanSection
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
          />
        </div>
      </div>
    </BriefingDialog>
  );
}
