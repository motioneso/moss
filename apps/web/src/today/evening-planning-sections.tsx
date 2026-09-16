import type { ReactNode } from "react";

import type { LocaleSettingsDto, TaskDto } from "@moss/shared";

import { localDay } from "@moss/shared";

import { Button, Select } from "@moss/ui";

import {
  EVENING_COMMIT_MESSAGE,
  EVENING_COMMIT_NOTE,
  EVENING_REFLECT_QUESTION,
  EVENING_REVIEW_NOT_READY,
  EVENING_SHAPE_MESSAGE,
  EVENING_SHAPE_NOTE,
  EVENING_SPEAKER_NAME,
  EVENING_SPEAKER_NOTE,
  NO_ROOM_FOUND,
  shortDate,
  timeLabel
} from "./today-labels.js";
import type { EveningPlanningController } from "./evening-planning-controller.js";
import type { CommitmentRow } from "./evening-planning-model.js";

function PlanSection(props: { id: string; label: string; children: ReactNode }) {
  return (
    <section className="evening-plan__section" id={props.id} aria-label={props.label}>
      <h3 id={`${props.id}-heading`} tabIndex={-1} className="evening-plan__heading">
        {props.label}
      </h3>
      {props.children}
    </section>
  );
}

const COMMIT_OPTIONS = [
  ["tomorrow", "Tomorrow"],
  ["another-date", "Another date"],
  ["unscheduled", "Keep on the list"]
] as const;

const CAPACITY_OPTIONS = [
  ["light", "Lighter day"],
  ["normal", "Steady day"],
  ["full", "Full day"]
] as const;

/** Today's recap with per-task actor corrections; nothing here writes tasks. */
export function ReflectSection(props: {
  readonly evening: EveningPlanningController;
  readonly tasks: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
}) {
  const { evening } = props;
  return (
    <PlanSection id="evening-reflect" label="Reflect">
      <ul className="evening-plan__rows">
        {props.tasks.map((task) => (
          <li className="evening-plan__row" key={task.id}>
            <div>
              <div className="evening-plan__title">{task.title}</div>
              <div className="evening-plan__state">
                {task.status === "todo"
                  ? task.dueAt !== null
                    ? `Due ${shortDate(task.dueAt, props.locale)}`
                    : "Open"
                  : "Done"}
              </div>
              {evening.corrections
                .filter((entry) => entry.taskId === task.id)
                .map((entry, index) => (
                  <div className="evening-plan__hint" key={index}>
                    Noted: {entry.note}
                  </div>
                ))}
            </div>
            <div className="evening-plan__controls">
              <input
                type="text"
                aria-label={`${task.title}: correction`}
                value={evening.noteDrafts[task.id] ?? ""}
                placeholder="Add a correction"
                onChange={(event) => evening.setNote(task.id, event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={evening.busy}
                onClick={() => evening.addCorrectionFor(task.id)}
              >
                Add
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </PlanSection>
  );
}

/** Step 1 conversation: speaker line, large message, prose, question, rows. */
export function ReflectStep(props: {
  readonly evening: EveningPlanningController;
  readonly tasks: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly headingId: string;
  readonly ledeHtml: string;
  readonly summaryText: string | null;
}) {
  const { evening } = props;
  return (
    <>
      <div className="evening-plan__speaker">
        <span className="evening-plan__initial" aria-hidden="true">
          {EVENING_SPEAKER_NAME.slice(0, 1)}
        </span>
        <div>
          {EVENING_SPEAKER_NAME}
          <small>{EVENING_SPEAKER_NOTE}</small>
        </div>
      </div>
      {props.summaryText !== null ? (
        <h3
          id={props.headingId}
          tabIndex={-1}
          className="evening-plan__lede"
          dangerouslySetInnerHTML={{ __html: props.ledeHtml }}
        />
      ) : null}
      {props.summaryText !== null ? (
        <p className="evening-plan__prose">{props.summaryText}</p>
      ) : (
        <p className="evening-plan__prose" role="status">
          {EVENING_REVIEW_NOT_READY}
        </p>
      )}
      <p className="evening-plan__question">{EVENING_REFLECT_QUESTION}</p>
      <ReflectSection evening={evening} tasks={props.tasks} locale={props.locale} />
    </>
  );
}

/** Speaker line and large message shared by steps 2 to 4 (V8). */
function StepIntro(props: { readonly note: string; readonly message: string }) {
  return (
    <>
      <div className="evening-plan__speaker">
        <span className="evening-plan__initial" aria-hidden="true">
          {EVENING_SPEAKER_NAME.slice(0, 1)}
        </span>
        <div>
          {EVENING_SPEAKER_NAME}
          <small>{props.note}</small>
        </div>
      </div>
      <p className="evening-plan__lede" tabIndex={-1}>
        {props.message}
      </p>
    </>
  );
}

/** Tomorrow-or-later choices; only "Change due date" writes a task field. */
export function CommitSection(props: {
  readonly evening: EveningPlanningController;
  readonly rows: readonly CommitmentRow[];
  readonly tomorrowKey: string;
  readonly timeZone: string;
}) {
  const { evening } = props;
  return (
    <PlanSection id="evening-commitments" label="Open commitments">
      <StepIntro note={EVENING_COMMIT_NOTE} message={EVENING_COMMIT_MESSAGE} />
      <ul className="evening-plan__rows">
        {props.rows.map((row) => {
          const word =
            row.marked === "done"
              ? "Done"
              : row.marked === "archived"
                ? "Archived"
                : row.marked === "unavailable"
                  ? "No longer available"
                  : row.task.dueAt !== null &&
                      localDay(row.task.dueAt, props.timeZone) === props.tomorrowKey
                    ? "Already set for tomorrow"
                    : null;
          if (word !== null) {
            return (
              <li className="evening-plan__row" key={row.task.id}>
                <div>
                  <div className="evening-plan__title">{row.task.title}</div>
                  <div className="evening-plan__state">{word}</div>
                </div>
              </li>
            );
          }
          const current = evening.decisions[row.task.id]?.decision ?? row.decided;
          const date = evening.decisions[row.task.id]?.date ?? "";
          return (
            <li className="evening-plan__row" key={row.task.id}>
              <div>
                <div className="evening-plan__title">{row.task.title}</div>
                <div
                  className="evening-plan__choices"
                  role="radiogroup"
                  aria-label={`${row.task.title}: plan`}
                >
                  {COMMIT_OPTIONS.map(([value, label]) => (
                    <label
                      key={value}
                      className="evening-plan__choice"
                      data-state={current === value ? "selected" : undefined}
                    >
                      <input
                        type="radio"
                        name={`${row.task.id}-commit`}
                        checked={current === value}
                        disabled={evening.busy}
                        onChange={() => evening.setDecision(row.task.id, value)}
                      />
                      <strong>{label}</strong>
                    </label>
                  ))}
                </div>
                <div className="evening-plan__controls">
                  <Button
                    variant="secondary"
                    disabled={evening.busy || current === null}
                    onClick={() => evening.clearDecision(row.task.id)}
                  >
                    Undecided
                  </Button>
                </div>
                {current === "another-date" ? (
                  <div className="evening-plan__controls">
                    <input
                      type="date"
                      aria-label={`${row.task.title}: new date`}
                      value={date}
                      disabled={evening.busy}
                      onChange={(event) => evening.setDateFor(row.task.id, event.target.value)}
                    />
                    <Button
                      variant="secondary"
                      disabled={evening.busy || date === ""}
                      onClick={() => void evening.changeDueDate(row.task.id)}
                    >
                      Change due date
                    </Button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </PlanSection>
  );
}

/** Capacity, priority, start time and the resulting proposals with a note field. */
export function ShapeSection(props: {
  readonly evening: EveningPlanningController;
  readonly committed: readonly TaskDto[];
  readonly tasks: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
}) {
  const { evening } = props;
  return (
    <PlanSection id="evening-shape" label="Shape tomorrow">
      <StepIntro note={EVENING_SHAPE_NOTE} message={EVENING_SHAPE_MESSAGE} />
      <div className="evening-plan__choices" role="radiogroup" aria-label="Day capacity">
        {CAPACITY_OPTIONS.map(([value, label]) => (
          <label
            key={value}
            className="evening-plan__choice"
            data-state={evening.activeCapacity === value ? "selected" : undefined}
          >
            <input
              type="radio"
              name="evening-capacity"
              checked={evening.activeCapacity === value}
              disabled={evening.busy}
              onChange={() => evening.setCapacity(value)}
            />
            <strong>{label}</strong>
          </label>
        ))}
      </div>
      <div className="evening-plan__fields">
        <label className="evening-plan__field-label" htmlFor="evening-priority">
          Main priority
        </label>
        <Select
          id="evening-priority"
          value={evening.activePriority[0] ?? ""}
          disabled={evening.busy || props.committed.length === 0}
          onChange={(event) =>
            evening.setPriority(event.target.value === "" ? [] : [event.target.value])
          }
        >
          <option value="">Pick a main priority</option>
          {props.committed.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </Select>
        <label className="evening-plan__field-label" htmlFor="evening-start">
          Task time starts at
        </label>
        <input
          id="evening-start"
          type="time"
          value={evening.startTime}
          disabled={evening.busy}
          onChange={(event) => evening.setStartTime(event.target.value)}
        />
      </div>
      <ul className="evening-plan__rows">
        {evening.proposals.map((proposal) => {
          const task =
            proposal.taskId === null
              ? undefined
              : props.tasks.find((t) => t.id === proposal.taskId);
          const pending = proposal.pendingChange;
          return (
            <li className="evening-plan__row" key={proposal.taskId ?? proposal.title}>
              <div>
                <div className="evening-plan__title">
                  {task?.title ?? proposal.title ?? "Untitled block"}
                </div>
                <div className="evening-plan__state">
                  {pending !== null && pending !== undefined && pending.kind !== "remove"
                    ? timeLabel(pending.startsAt, props.locale)
                    : `${NO_ROOM_FOUND} for ${task?.title ?? "this task"}`}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="evening-plan__controls">
        <label>
          Evening note
          <input
            type="text"
            aria-label="Evening note"
            value={evening.activeNotes}
            disabled={evening.busy}
            onChange={(event) => evening.setNotesText(event.target.value)}
          />
        </label>
      </div>
    </PlanSection>
  );
}
