import { useState, type ReactNode } from "react";

import type { LocaleSettingsDto, TaskDto } from "@moss/shared";

import { localDay } from "@moss/shared";

import { Button, Select } from "@moss/ui";

import {
  EVENING_COMMIT_ADD_NOTE_LABEL,
  eveningCommitClosing,
  eveningCommitProse,
  EVENING_COMMIT_CHOICES,
  EVENING_COMMIT_EYEBROW_SUFFIX,
  EVENING_COMMIT_MESSAGE,
  EVENING_COMMIT_NOTE,
  EVENING_COMMIT_NOTE_LABEL,
  EVENING_COMMIT_NOTE_PLACEHOLDER,
  EVENING_COMMIT_TASK_HINT,
  EVENING_REFLECT_ADD_NOTE_LABEL,
  EVENING_REFLECT_CHOICES,
  EVENING_REFLECT_NOTE_LABEL,
  EVENING_REFLECT_NOTE_PLACEHOLDER,
  EVENING_REFLECT_QUESTION,
  EVENING_REVIEW_NOT_READY,
  EVENING_SHAPE_MESSAGE,
  EVENING_SHAPE_NOTE,
  EVENING_SPEAKER_NAME,
  EVENING_SPEAKER_NOTE,
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

/** Evening step 1 reflection choices and note composer (VP-REFLECTION-R1); nothing here writes tasks. */
export function ReflectSection(props: {
  readonly evening: EveningPlanningController;
  readonly tasks: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
}) {
  const { evening } = props;
  const [draftNote, setDraftNote] = useState("");

  const handleAddNote = () => {
    const trimmed = draftNote.trim();
    if (trimmed === "") return;
    evening.addNote(trimmed);
    setDraftNote("");
  };

  const notes = evening.activeNotes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (
    <section className="evening-plan__section" id="evening-reflect" aria-label="Reflect">
      <div
        className="evening-plan__choices evening-plan__choices--stacked"
        role="radiogroup"
        aria-label="Reflection"
      >
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

      <hr className="evening-plan__rule" />

      <div className="evening-plan__note-form">
        <label className="evening-plan__field-label" htmlFor="evening-reflect-note">
          {EVENING_REFLECT_NOTE_LABEL}
        </label>
        <div className="evening-plan__note-composer">
          <textarea
            id="evening-reflect-note"
            aria-label={EVENING_REFLECT_NOTE_LABEL}
            rows={2}
            maxLength={500}
            placeholder={EVENING_REFLECT_NOTE_PLACEHOLDER}
            value={draftNote}
            disabled={evening.busy}
            onChange={(event) => setDraftNote(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={evening.busy || draftNote.trim() === ""}
            onClick={handleAddNote}
          >
            {EVENING_REFLECT_ADD_NOTE_LABEL}
          </Button>
        </div>
        {notes.map((note, index) => (
          <div className="evening-plan__hint" key={index}>
            Noted: {note}
          </div>
        ))}
      </div>
    </section>
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
  const [draftNote, setDraftNote] = useState("");

  const handleAddNote = () => {
    const trimmed = draftNote.trim();
    if (trimmed === "") return;
    evening.addNote(trimmed);
    setDraftNote("");
  };

  const notes = evening.activeNotes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const actionableRows = props.rows.filter((row) => {
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
    return word === null;
  });

  const nonActionableRows = props.rows.filter((row) => {
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
    return word !== null;
  });

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
      <p id="evening-commitments-heading" tabIndex={-1} className="evening-plan__lede">
        {EVENING_COMMIT_MESSAGE}
      </p>
      <p className="evening-plan__prose">{eveningCommitProse(props.rows.length)}</p>

      {actionableRows.map((row, index) => {
        const current =
          row.task.id in evening.decisions
            ? (evening.decisions[row.task.id]?.decision ?? null)
            : row.decided;
        const date = evening.decisions[row.task.id]?.date ?? "";
        const category = (row.task.tags?.[0]?.name ?? "PERSONAL").toUpperCase();
        return (
          <div key={row.task.id} className="evening-plan__group">
            <hr className="evening-plan__rule" />
            <p className="evening-plan__eyebrow">
              {category} / {EVENING_COMMIT_EYEBROW_SUFFIX}
            </p>
            <div className="evening-plan__title">
              <strong>{row.task.title}</strong>
            </div>
            <div className="evening-plan__hint">{EVENING_COMMIT_TASK_HINT}</div>
            <div
              className="evening-plan__choices evening-plan__choices--commitments"
              role="radiogroup"
              aria-label={`${row.task.title}: plan`}
            >
              {EVENING_COMMIT_CHOICES.map((choice) => {
                const selected = choice.id === "leave" ? current === null : current === choice.id;
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
                      onChange={() => {
                        if (choice.id === "leave") {
                          evening.clearDecision(row.task.id);
                        } else {
                          evening.setDecision(row.task.id, choice.id);
                        }
                      }}
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
            <p className="evening-plan__prose">
              {eveningCommitClosing(index < actionableRows.length - 1)}
            </p>
          </div>
        );
      })}

      {nonActionableRows.length > 0 ? (
        <ul className="evening-plan__rows">
          {nonActionableRows.map((row) => {
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
            return (
              <li className="evening-plan__row" key={row.task.id}>
                <div>
                  <div className="evening-plan__title">{row.task.title}</div>
                  <div className="evening-plan__state">{word}</div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <hr className="evening-plan__rule" />

      <div className="evening-plan__note-form">
        <label className="evening-plan__field-label" htmlFor="evening-commit-note">
          {EVENING_COMMIT_NOTE_LABEL}
        </label>
        <div className="evening-plan__note-composer">
          <textarea
            id="evening-commit-note"
            aria-label={EVENING_COMMIT_NOTE_LABEL}
            rows={2}
            maxLength={500}
            placeholder={EVENING_COMMIT_NOTE_PLACEHOLDER}
            value={draftNote}
            disabled={evening.busy}
            onChange={(event) => setDraftNote(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={evening.busy || draftNote.trim() === ""}
            onClick={handleAddNote}
          >
            {EVENING_COMMIT_ADD_NOTE_LABEL}
          </Button>
        </div>
        {notes.map((note, index) => (
          <div className="evening-plan__hint" key={index}>
            Noted: {note}
          </div>
        ))}
      </div>
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
