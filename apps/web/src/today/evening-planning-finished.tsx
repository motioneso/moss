import type { DayPlanBlockInput, TaskDto } from "@moss/shared";

import type { EveningPlanningController } from "./evening-planning-controller.js";
import {
  EVENING_DONE_LABEL,
  EVENING_FINISHED_MESSAGE,
  EVENING_FINISHED_REPLY,
  EVENING_FINISHED_REPLY_TITLE,
  EVENING_HANDOFF_LINK,
  EVENING_HANDOFF_MESSAGE,
  EVENING_ADJUST_LINK
} from "./today-labels.js";

/** Replaces the step strip once the plan is saved. */
export function EveningDoneStrip(props: { readonly dateLabel: string }) {
  return (
    <div className="evening-plan__done-strip">
      {EVENING_DONE_LABEL}
      <span>{props.dateLabel}</span>
    </div>
  );
}

function blockTitle(block: DayPlanBlockInput, tasks: readonly TaskDto[]): string | null {
  if (block.taskId === null) return block.title ?? null;
  return tasks.find((task) => task.id === block.taskId)?.title ?? block.title ?? null;
}

/** Saved confirmation: what the plan is and where the morning picks it up. */
export function EveningFinishedStep(props: {
  readonly evening: EveningPlanningController;
  readonly onHandoff: () => void;
  readonly onAdjust: () => void;
}) {
  const { evening } = props;
  const lead =
    evening.activeCapacity === "light"
      ? "A lighter day is the plan."
      : evening.activePriority.length > 0
        ? "You have a clear priority and space around it."
        : "You have room around what is already fixed.";
  return (
    <section className="evening-plan__section" id="evening-finished" aria-label="Plan saved">
      <div className="evening-plan__finish-mark" aria-hidden="true">
        {"✓"}
      </div>
      <h3 id="evening-finished-heading" tabIndex={-1} className="evening-plan__lede">
        {EVENING_FINISHED_MESSAGE}
      </h3>
      <p className="evening-plan__prose" role="status">
        {`${lead} ${evening.status}`}
      </p>
      <div className="evening-plan__response">
        <strong>{EVENING_FINISHED_REPLY_TITLE}</strong>
        {EVENING_FINISHED_REPLY}
      </div>
      <button type="button" className="evening-plan__link" onClick={props.onHandoff}>
        {EVENING_HANDOFF_LINK}
      </button>
      <button type="button" className="evening-plan__link" onClick={props.onAdjust}>
        {EVENING_ADJUST_LINK}
      </button>
    </section>
  );
}

/** Preview of how tomorrow morning opens from tonight's plan. */
export function EveningHandoffStep(props: {
  readonly evening: EveningPlanningController;
  readonly tasks: readonly TaskDto[];
  readonly dateLabel: string;
}) {
  const { evening } = props;
  const light = evening.activeCapacity === "light";
  const first = evening.proposals
    .map((block) => blockTitle(block, props.tasks))
    .find((title) => title !== null);
  const prose =
    first !== undefined && first !== null
      ? `You chose ${first.toLowerCase()} as the place to start. ${
          light
            ? "You asked to keep the rest of the day deliberately light."
            : "You allowed room to follow through in the afternoon."
        }`
      : "You left the task list unscheduled. Your calendar holds the only fixed commitments.";
  const detail =
    first === undefined || first === null
      ? "No task blocks were added."
      : evening.policyMode === "auto"
        ? "Task blocks are scheduled."
        : "Task blocks still await your acceptance.";
  return (
    <section className="evening-plan__section" id="evening-handoff" aria-label="Morning handoff">
      <span className="evening-plan__handoff-date">{`${props.dateLabel} / Morning`}</span>
      <h3 id="evening-handoff-heading" tabIndex={-1} className="evening-plan__lede">
        {EVENING_HANDOFF_MESSAGE}
      </h3>
      <p className="evening-plan__prose">{prose}</p>
      <div className="evening-plan__record">
        <span>Carried from last night</span>
        <strong>{light ? "Keep the day light" : "Protect time for the main priority"}</strong>
        <small>{detail}</small>
      </div>
    </section>
  );
}
