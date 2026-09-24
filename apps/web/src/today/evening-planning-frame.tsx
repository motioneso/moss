import { useState, type ReactNode } from "react";

import type {
  CalendarEventDto,
  DayPlanBlockInput,
  DayPlanIntentCapacity,
  LocaleSettingsDto,
  TaskDto
} from "@moss/shared";

import { Button } from "@moss/ui";

import { formatDate } from "../locale/locale-format.js";

import type { EveningPlanningController } from "./evening-planning-controller.js";
import {
  ampm,
  EVENING_PLACEMENT_NOTES,
  EVENING_PLAN_STEPS_LABEL,
  EVENING_RAIL_HEADING,
  EVENING_REFLECT_ADD_NOTE_LABEL,
  EVENING_REFLECT_NOTE_LABEL,
  EVENING_REFLECT_NOTE_PLACEHOLDER,
  EVENING_SNAPSHOT_INTENT,
  EVENING_SNAPSHOT_NO_BLOCKS,
  EVENING_SNAPSHOT_REST,
  eveningMobilePlanLabel,
  timeLabel
} from "./today-labels.js";

export const EVENING_STEP_IDS = ["reflect", "commitments", "shape", "review"] as const;

export type EveningStepId = (typeof EVENING_STEP_IDS)[number];

/** Numbered step strip: an ordered list of plain buttons, exactly one current. */
export function EveningStepStrip(props: {
  readonly names: readonly string[];
  readonly active: number;
  readonly onSelect: (index: number) => void;
}) {
  return (
    <nav className="evening-plan__strip" aria-label={EVENING_PLAN_STEPS_LABEL}>
      <ol>
        {props.names.map((name, index) => (
          <li key={name}>
            <button
              type="button"
              aria-current={index === props.active ? "step" : undefined}
              onClick={() => props.onSelect(index)}
            >
              <span>{`0${index + 1}`}</span> {name}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** One visible step: a region labelled by its heading, or named when the step
    has no heading yet. The region is the focus fallback after the heading. */
export function EveningStepPanel(props: {
  readonly stepId: EveningStepId;
  readonly headingId?: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="evening-plan__panel"
      role="region"
      id={`evening-panel-${props.stepId}`}
      tabIndex={-1}
      aria-labelledby={props.headingId}
      aria-label={props.headingId === undefined ? props.label : undefined}
    >
      {props.children}
    </div>
  );
}

interface SnapshotEntry {
  readonly key: string;
  readonly startsAt: string;
  readonly minutes: number;
  readonly title: string;
  readonly note: string;
  readonly draft: boolean;
}

export interface EveningSnapshotProps {
  readonly railDateInput: string;
  readonly locale: LocaleSettingsDto;
  readonly events: readonly CalendarEventDto[];
  readonly proposals: readonly DayPlanBlockInput[];
  readonly tasks: readonly TaskDto[];
  readonly capacity: DayPlanIntentCapacity;
  readonly policyMode: "off" | "suggest" | "auto";
}

function snapshotEntries(props: EveningSnapshotProps): SnapshotEntry[] {
  const fixed = props.events
    .filter((event) => !event.allDay)
    .map((event) => ({
      key: `event-${event.id}`,
      startsAt: event.startsAt,
      minutes: Math.round((Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 60_000),
      title: event.title,
      note: event.isMossBlock ? "Scheduled by Moss" : "Calendar",
      draft: false
    }));
  const drafts = props.proposals.flatMap((block) => {
    const change = block.pendingChange;
    if (change?.kind !== "add") return [];
    const task = props.tasks.find((entry) => entry.id === block.taskId);
    return [
      {
        key: `draft-${block.taskId ?? change.startsAt}`,
        startsAt: change.startsAt,
        minutes: change.durationMinutes,
        title: task?.title ?? block.title ?? "Task block",
        note: "Proposed",
        draft: true
      }
    ];
  });
  return [...fixed, ...drafts].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export function draftBlockCount(proposals: readonly DayPlanBlockInput[]): number {
  return proposals.filter((block) => block.pendingChange?.kind === "add").length;
}

/** Tomorrow snapshot: fixed events and proposed task blocks in time order. */
function EveningSnapshot(props: EveningSnapshotProps & { readonly withHeading: boolean }) {
  const entries = snapshotEntries(props);
  const taskMinutes = entries
    .filter((entry) => entry.draft)
    .reduce((sum, entry) => sum + entry.minutes, 0);
  return (
    <div className="evening-plan__snapshot">
      {props.withHeading ? (
        <div className="evening-plan__snapshot-heading">
          <span className="evening-plan__rail-date">
            {formatDate(props.railDateInput, props.locale, {
              weekday: "long",
              month: "long",
              day: "numeric",
              timeZone: "UTC"
            })}
          </span>
          <h3 className="evening-plan__rail-heading">{EVENING_RAIL_HEADING}</h3>
        </div>
      ) : null}
      <p className="evening-plan__snapshot-intent">{EVENING_SNAPSHOT_INTENT[props.capacity]}</p>
      {entries.map((entry) => (
        <div
          key={entry.key}
          className={
            entry.draft
              ? "evening-plan__snapshot-entry evening-plan__snapshot-entry--draft"
              : "evening-plan__snapshot-entry"
          }
        >
          <span>{`${timeLabel(entry.startsAt, props.locale)}${ampm(entry.startsAt, props.locale)}`}</span>
          <div>
            {entry.title}
            <small>{`${entry.minutes} minutes \u00b7 ${entry.note}`}</small>
          </div>
        </div>
      ))}
      {taskMinutes === 0 ? (
        <p className="evening-plan__snapshot-gap">{EVENING_SNAPSHOT_NO_BLOCKS}</p>
      ) : null}
      <div className="evening-plan__snapshot-bottom">
        <strong>{`${taskMinutes} minutes of task time`}</strong>
        <span>{EVENING_SNAPSHOT_REST}</span>
      </div>
    </div>
  );
}

/** Desktop rail: the snapshot, then how saving places the blocks. */
export function EveningRail(props: EveningSnapshotProps) {
  const placement = props.policyMode === "off" ? null : EVENING_PLACEMENT_NOTES[props.policyMode];
  return (
    <aside className="evening-plan__railwrap" aria-label="Tomorrow's plan preview">
      <EveningSnapshot {...props} withHeading />
      {placement ? (
        <div className="evening-plan__placement">
          <strong>{placement.title}</strong>
          <p>{placement.body}</p>
        </div>
      ) : null}
    </aside>
  );
}

/** Phone disclosure above the conversation; the desktop rail replaces it. */
export function EveningMobilePlan(props: EveningSnapshotProps) {
  return (
    <details className="evening-plan__mobile-plan">
      <summary>{eveningMobilePlanLabel(draftBlockCount(props.proposals))}</summary>
      <EveningSnapshot {...props} withHeading={false} />
    </details>
  );
}

/** Free-text note under every step; notes travel with the saved plan. */
export function EveningNoteComposer(props: { readonly evening: EveningPlanningController }) {
  const { evening } = props;
  const [draftNote, setDraftNote] = useState("");
  const notes = evening.activeNotes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const addNote = () => {
    const trimmed = draftNote.trim();
    if (trimmed === "") return;
    evening.addNote(trimmed);
    setDraftNote("");
  };
  return (
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
        <Button variant="primary" disabled={evening.busy} onClick={addNote}>
          {EVENING_REFLECT_ADD_NOTE_LABEL}
        </Button>
      </div>
      {notes.map((note, index) => (
        <div className="evening-plan__hint" key={index}>
          Noted: {note}
        </div>
      ))}
    </div>
  );
}
