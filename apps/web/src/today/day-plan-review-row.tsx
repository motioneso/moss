import { Select } from "@moss/ui";

import { localDay } from "@moss/shared";

import type {
  DayPlanBlockDto,
  DayPlanDto,
  DayPlanTaskSummary,
  LocaleSettingsDto
} from "@moss/shared";

import type { DayPlanReviewController } from "./day-plan-review-controller.js";
import {
  blockDuration,
  conflictText,
  effectivePending,
  ineligibleWord,
  isoToLocalTime,
  localTimeToIso,
  outcomeWord,
  samePending,
  transientWord,
  type BlockChoice,
  type ReviewPlacement
} from "./day-plan-review-model.js";
import { REVIEW_KEEP_ON_CALENDAR_LABEL, shortDate } from "./today-labels.js";

/** Row list shared with the evening planning dialog (T20). Moved verbatim
    from day-plan-review.tsx in V6; the controls gained visible labels. */
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

export function rowTitle(block: DayPlanBlockDto, tasks: readonly DayPlanTaskSummary[]): string {
  if (block.taskId === null) return block.title ?? "Untitled block";
  return tasks.find((task) => task.id === block.taskId)?.title ?? block.title ?? "Untitled block";
}

/** Row list shared with the evening planning dialog (T20). */
export function ReviewRow(props: {
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
  readonly calendarTimeField?: boolean;
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
  const readerMode = props.calendarTimeField === true;
  const readerCalendar = readerMode && onCalendar;
  const readerDuration = readerMode ? blockDuration(block) : null;
  const pendingStartsAt =
    block.pendingChange !== null &&
    block.pendingChange.kind !== "remove" &&
    "startsAt" in block.pendingChange
      ? (block.pendingChange.startsAt ?? null)
      : null;
  const readerTimeIso =
    props.choice.startsAt ?? pendingStartsAt ?? block.actualPlacement?.startsAt ?? null;
  const readerTimeValue =
    readerTimeIso !== null ? isoToLocalTime(readerTimeIso, props.plan.timeZone) : "";
  const effective = effectivePending(block, props.choice);
  const changed = effective !== undefined && !samePending(effective, block.pendingChange ?? null);
  const transient = transientWord(changed, effective?.kind, onCalendar);
  const stateWord = transient ?? props.savedLabel;
  const dueReason =
    props.task?.dueAt !== undefined && props.task?.dueAt !== null
      ? localDay(props.task.dueAt, props.plan.timeZone) === props.plan.localDay
        ? "Due today"
        : `Due ${shortDate(props.task.dueAt, props.locale)}`
      : null;
  const metaReason = dueReason ?? stateWord;
  const showTime = readerMode
    ? blockDuration(block) !== null
    : props.choice.placement === "add" || props.choice.placement === "move";
  const timeDisabled =
    blockDuration(block) === null ||
    controller.busy ||
    (readerMode && (props.choice.placement === "leave" || props.choice.placement === "remove"));
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
        {readerMode && readerDuration !== null ? (
          <div className="plan-review__meta">
            {readerDuration} minutes · {metaReason}
          </div>
        ) : (
          <div className="plan-review__state">{stateWord}</div>
        )}
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
      <div className="plan-review__fields">
        {showTime ? (
          <div className="plan-review__field">
            <label className="plan-review__label" htmlFor={`${block.id}-time`}>
              Time
            </label>
            <input
              type="time"
              id={`${block.id}-time`}
              aria-label={`${props.title}: start time`}
              className="plan-review__time"
              disabled={timeDisabled}
              value={readerMode ? readerTimeValue : timeValue}
              onChange={(event) => {
                const iso = localTimeToIso(
                  props.plan.localDay,
                  event.target.value,
                  props.plan.timeZone
                );
                if (readerMode) {
                  controller.setPlacement(block.id, onCalendar ? "move" : "add", iso);
                  controller.setTime(block.id, iso);
                  return;
                }
                controller.setTime(block.id, iso);
              }}
            />
          </div>
        ) : null}
        <div className="plan-review__field">
          <label className="plan-review__label" htmlFor={`${block.id}-placement`}>
            Placement
          </label>
          <Select
            id={`${block.id}-placement`}
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
                {readerCalendar && option.value === "keep"
                  ? REVIEW_KEEP_ON_CALENDAR_LABEL
                  : option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </li>
  );
}
