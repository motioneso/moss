import type { ReactNode } from "react";

import type { LocaleSettingsDto, TaskDto } from "@moss/shared";

import { localDay } from "@moss/shared";

import { Button, Select } from "@moss/ui";

import {
  EVENING_COMMIT_CHOICES,
  EVENING_COMMIT_EYEBROW,
  EVENING_COMMIT_MESSAGE,
  EVENING_COMMIT_TASK_HINT,
  EVENING_REFLECT_CHOICES,
  EVENING_COMMIT_NOTE,
  EVENING_REFLECT_QUESTION,
  EVENING_REVIEW_NOT_READY,
  EVENING_SHAPE_MESSAGE,
  EVENING_SHAPE_NOTE,
  EVENING_SPEAKER_NAME,
  EVENING_SPEAKER_NOTE,
  eveningCommitProse,
  NO_ROOM_FOUND,
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

const CAPACITY_OPTIONS = [
  ["light", "Lighter day"],
  ["normal", "Steady day"],
  ["full", "Full day"]
] as const;

/** Evening step 1 reflection choices (VP-REFLECTION-R1); nothing here writes tasks. */
export function ReflectSection(props: { readonly evening: EveningPlanningController }) {
  const { evening } = props;
  return (
    <section className="evening-plan__section" id="evening-reflect" aria-label="Reflect">
      <div className="evening-plan__choices" role="radiogroup" aria-label="Reflection">
        {EVENING_REFLECT_CHOICES.map((choice) => (
          <label
            key={choice.id}
            className="evening-plan__choice"
            data-state={evening.reflection === choice.id ? "selected" : undefined}
          >
            <input
              type="radio"
              name="evening-reflection"
              className="evening-plan__choice-radio"
              checked={evening.reflection === choice.id}
              disabled={evening.busy}
              onChange={() => evening.setReflection(choice.id)}
            />
            <span className="evening-plan__choice-text">
              <strong>{choice.title}</strong>
              <small>{choice.hint}</small>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

/** Step 1 conversation: speaker line, large message, prose, question, rows. */
export function ReflectStep(props: {
  readonly evening: EveningPlanningController;
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
      <ReflectSection evening={evening} />
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

function markedWord(row: CommitmentRow, tomorrowKey: string, timeZone: string): string | null {
  if (row.marked === "done") return "Done";
  if (row.marked === "archived") return "Archived";
  if (row.marked === "unavailable") return "No longer available";
  if (row.task.dueAt !== null && localDay(row.task.dueAt, timeZone) === tomorrowKey)
    return "Already set for tomorrow";
  return null;
}

/** Tomorrow-or-later choices; only "Change due date" writes a task field. */
export function CommitSection(props: {
  readonly evening: EveningPlanningController;
  readonly rows: readonly CommitmentRow[];
  readonly tomorrowKey: string;
  readonly timeZone: string;
}) {
  const { evening } = props;
  const open = props.rows.filter(
    (row) => markedWord(row, props.tomorrowKey, props.timeZone) === null
  ).length;
  return (
    <section
      className="evening-plan__section"
      id="evening-commitments"
      aria-label="Open commitments"
    >
      <div className="evening-plan__speaker">
        <span className="evening-plan__initial" aria-hidden="true">
          {EVENING_SPEAKER_NAME.slice(0, 1)}
        </span>
        <div>
          {EVENING_SPEAKER_NAME}
          <small>{EVENING_COMMIT_NOTE}</small>
        </div>
      </div>
      <h3 id="evening-commitments-heading" tabIndex={-1} className="evening-plan__lede">
        {EVENING_COMMIT_MESSAGE}
      </h3>
      <p className="evening-plan__prose">{eveningCommitProse(open)}</p>
      {props.rows.map((row) => {
        const word = markedWord(row, props.tomorrowKey, props.timeZone);
        const tag = row.task.tags?.[0]?.name;
        const eyebrow = tag ? `${tag} / ${EVENING_COMMIT_EYEBROW}` : EVENING_COMMIT_EYEBROW;
        const current = evening.decisions[row.task.id]?.decision ?? row.decided;
        const date = evening.decisions[row.task.id]?.date ?? "";
        return (
          <div className="evening-plan__commitment" key={row.task.id}>
            <article className="evening-plan__task">
              <span className="evening-plan__eyebrow">{eyebrow}</span>
              <h4 className="evening-plan__title">{row.task.title}</h4>
              <p className="evening-plan__state">{word ?? EVENING_COMMIT_TASK_HINT}</p>
            </article>
            {word === null ? (
              <>
                <div
                  className="evening-plan__choices evening-plan__choices--two-up"
                  role="radiogroup"
                  aria-label={`${row.task.title}: plan`}
                >
                  {EVENING_COMMIT_CHOICES.map((choice) => {
                    const selected =
                      choice.id === "leave" ? current === null : current === choice.id;
                    return (
                      <label
                        key={choice.id}
                        className="evening-plan__choice"
                        data-state={selected ? "selected" : undefined}
                      >
                        <input
                          type="radio"
                          name={`${row.task.id}-commit`}
                          className="evening-plan__choice-radio"
                          checked={selected}
                          disabled={evening.busy}
                          onChange={() =>
                            choice.id === "leave"
                              ? evening.clearDecision(row.task.id)
                              : evening.setDecision(row.task.id, choice.id)
                          }
                        />
                        <span className="evening-plan__choice-text">
                          <strong>{choice.title}</strong>
                          <small>{choice.hint}</small>
                        </span>
                      </label>
                    );
                  })}
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
              </>
            ) : null}
          </div>
        );
      })}
    </section>
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
