// external-modules/meals/src/web/screens/log.tsx
//
// The Log area: one day of meals grouped by part of the day, the day's totals against the
// household member's targets, and add, edit, retry and delete. Write controls show only with
// the host's write handle. Moss does the estimating, so a new meal reads "Estimating" until the
// estimate lands.
import { Button, EmptyState, Eyebrow, useState, type ReactNodeLike } from "@moss/module-web-sdk";

import type { LogEntryView, LogListResult, LogTargetsView, NutrientsView } from "../../contracts";
import { dayTitle, todayIso } from "../format";
import type { LogState } from "../log";
import {
  amount,
  entryCalories,
  occasionOf,
  OCCASIONS,
  shiftDay,
  timeText,
  timeValue
} from "../log-format";
import type { HostActions } from "../root";
import type { MealsWrites } from "../writes";
import { AddMealDialog, EditMealDialog } from "./log-dialogs";

type Dialog = { kind: "add" } | { kind: "edit"; entryId: string } | null;

function zone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function nowTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function newKey(): string {
  return `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function LogScreen(props: {
  state: LogState;
  localDate: string;
  onDate: (localDate: string) => void;
  reload: () => void;
  writes: MealsWrites | null;
  hostActions: HostActions;
}): ReactNodeLike {
  const { state } = props;
  const nav = (
    <div className="mls-planbar">
      <DayNav localDate={props.localDate} onDate={props.onDate} />
    </div>
  );
  if (state.kind === "loading") {
    return (
      <div className="mls-stack">
        {nav}
        <p className="jds-caption" role="status">
          Loading the Log
        </p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mls-stack">
        {nav}
        <div className="jds-recovery" role="alert">
          <div>
            <div className="jds-recovery__title">Couldn't load the Log</div>
            <div className="jds-recovery__msg">Check the connection, then try again.</div>
            <div className="jds-recovery__actions">
              <Button variant="secondary" size="sm" onClick={props.reload}>
                Try again
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return <Day {...props} day={state.day} />;
}

function DayNav(props: { localDate: string; onDate: (localDate: string) => void }): ReactNodeLike {
  const today = todayIso();
  return (
    <div className="mls-row">
      <div className="mls-row">
        <Button
          variant="quiet"
          size="sm"
          aria-label="Previous day"
          onClick={() => props.onDate(shiftDay(props.localDate, -1))}
        >
          Previous
        </Button>
        <h3 className="jds-card-title">
          {props.localDate === today ? "Today" : dayTitle(props.localDate)}
        </h3>
        <Button
          variant="quiet"
          size="sm"
          aria-label="Next day"
          disabled={props.localDate >= today}
          onClick={() => props.onDate(shiftDay(props.localDate, 1))}
        >
          Next
        </Button>
      </div>
      {props.localDate !== today ? (
        <Button variant="link" size="sm" onClick={() => props.onDate(today)}>
          Back to today
        </Button>
      ) : null}
    </div>
  );
}

function Figure(props: {
  label: string;
  value: number | null;
  target: number | null;
  unit: string;
}): ReactNodeLike {
  return (
    <div className="mls-figure">
      <span className="jds-caption">{props.label}</span>
      <span className="mls-figure__value mls-num">
        {amount(props.value, props.unit === "kcal" ? 0 : 1)}
        {props.value !== null ? <span className="jds-caption">{` ${props.unit}`}</span> : null}
      </span>
      {props.target !== null ? (
        <span className="jds-caption mls-num">{`of ${amount(props.target)} ${props.unit}`}</span>
      ) : null}
    </div>
  );
}

function Totals(props: { day: LogListResult }): ReactNodeLike {
  const { totals, targets, calorieFit } = props.day;
  if (totals === null) return null;
  const n: NutrientsView = totals.nutrients;
  const t: LogTargetsView = targets;
  const fitText =
    calorieFit === null
      ? null
      : calorieFit.band === "on"
        ? "On target"
        : `${amount(Math.abs(calorieFit.differenceKcal))} kcal ${calorieFit.band}`;
  return (
    <section className="mls-totals" aria-label="Day totals">
      <div className="mls-figure mls-figure--lead">
        <Eyebrow>Calories</Eyebrow>
        <span className="mls-figure__big mls-num">{amount(n.caloriesKcal)}</span>
        {t.caloriesKcal !== null ? (
          <span className="jds-caption mls-num">{`of ${amount(t.caloriesKcal)} kcal`}</span>
        ) : null}
        {fitText !== null ? <span className="jds-caption">{fitText}</span> : null}
      </div>
      <Figure label="Protein" value={n.proteinG} target={t.proteinG} unit="g" />
      <Figure label="Carbs" value={n.carbohydratesG} target={t.carbG} unit="g" />
      <Figure label="Fat" value={n.fatG} target={t.fatG} unit="g" />
    </section>
  );
}

function EntryRow(props: {
  entry: LogEntryView;
  writes: MealsWrites | null;
  busy: boolean;
  onEdit: (entry: LogEntryView) => void;
  onRetry: (entry: LogEntryView) => void;
  onDelete: (entry: LogEntryView) => void;
}): ReactNodeLike {
  const { entry, writes } = props;
  const [open, setOpen] = useState(false);
  const state = entry.estimateState;
  const hasItems = entry.items.length > 0;
  return (
    <li className="mls-entry">
      <div className="mls-entry__main">
        <span className="mls-line__body">
          <span className="mls-line__name">{entry.description}</span>
          <span className="jds-caption">
            {[
              timeText(entry),
              entry.servingNote,
              state === "pending" ? "Estimating" : null,
              state === "failed" ? "Could not estimate" : null,
              state === "needs_details" ? "Needs a detail" : null
            ]
              .filter(Boolean)
              .join(", ")}
          </span>
        </span>
        <span className="mls-line__amount">
          <span className="mls-num">{entryCalories(entry)}</span>
          <span className="jds-caption">kcal</span>
        </span>
      </div>
      {state === "needs_details" && entry.clarificationQuestion !== null ? (
        <p className="jds-caption mls-safety">{entry.clarificationQuestion}</p>
      ) : null}
      {open && hasItems ? (
        <ul className="mls-table">
          {entry.items.map((item, index) => (
            <li key={index}>
              <span>{[item.label, item.portionNote].filter(Boolean).join(", ")}</span>
              <span className="mls-num">{`${amount(item.nutrients.caloriesKcal)} kcal`}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mls-line__tools">
        {hasItems ? (
          <Button variant="quiet" size="sm" onClick={() => setOpen(!open)}>
            {open ? "Hide foods" : "Show foods"}
          </Button>
        ) : null}
        {writes !== null ? (
          <>
            {state === "failed" || state === "pending" ? (
              <Button
                variant="quiet"
                size="sm"
                disabled={props.busy}
                aria-label={`Retry ${entry.description}`}
                onClick={() => props.onRetry(entry)}
              >
                Retry
              </Button>
            ) : null}
            <Button
              variant="quiet"
              size="sm"
              disabled={props.busy}
              aria-label={`Edit ${entry.description}`}
              onClick={() => props.onEdit(entry)}
            >
              Edit
            </Button>
            <Button
              variant="quiet"
              size="sm"
              disabled={props.busy}
              aria-label={`Delete ${entry.description}`}
              onClick={() => props.onDelete(entry)}
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}

function Day(props: {
  day: LogListResult;
  onDate: (localDate: string) => void;
  localDate: string;
  reload: () => void;
  writes: MealsWrites | null;
  hostActions: HostActions;
}): ReactNodeLike {
  const { day, writes } = props;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run(
    name: "meals.log.add" | "meals.log.correct" | "meals.log.delete" | "meals.log.reestimate",
    input: Record<string, unknown>
  ): Promise<boolean> {
    if (writes === null || busy) return false;
    setBusy(true);
    setFailed(false);
    const outcome = await writes.invoke(name, input);
    setBusy(false);
    if (outcome.kind === "succeeded") {
      props.reload();
      return true;
    }
    if (outcome.kind !== "cancelled") setFailed(true);
    return false;
  }

  const consumedAt = (time: string) => `${props.localDate}T${time}:00`;

  const askMoss = (
    <Button
      variant="secondary"
      onClick={() => props.hostActions.openAssistant({ starterPrompt: "Log a meal: " })}
    >
      Ask Moss
    </Button>
  );
  const addButton =
    writes !== null ? (
      <Button onClick={() => setDialog({ kind: "add" })}>Log a meal</Button>
    ) : (
      askMoss
    );

  const editing =
    dialog?.kind === "edit"
      ? day.entries.find((entry) => entry.entryId === dialog.entryId)
      : undefined;
  const uncounted = day.totals?.entriesWithoutEstimate ?? 0;

  return (
    <div className="mls-stack">
      <div className="mls-planbar">
        <DayNav localDate={props.localDate} onDate={props.onDate} />
        <div className="mls-row mls-hide-phone">{addButton}</div>
      </div>
      {failed ? (
        <p className="jds-caption" role="alert">
          That did not go through. Try again.
        </p>
      ) : null}
      {day.entries.length === 0 ? (
        <EmptyState title="Nothing logged">{addButton}</EmptyState>
      ) : (
        <>
          <Totals day={day} />
          {uncounted > 0 ? (
            <p className="jds-caption">
              {uncounted === 1
                ? "1 meal is not counted yet."
                : `${uncounted} meals are not counted yet.`}
            </p>
          ) : null}
          {OCCASIONS.map(({ value, label }) => {
            const rows = day.entries.filter((entry) => occasionOf(entry) === value);
            if (rows.length === 0) return null;
            return (
              <section className="mls-section" aria-label={label} key={value}>
                <div className="mls-block-head">
                  <h3 className="jds-card-title">{label}</h3>
                  <span className="jds-caption">{rows.length}</span>
                </div>
                <ul className="mls-list">
                  {rows.map((entry) => (
                    <EntryRow
                      key={entry.entryId}
                      entry={entry}
                      writes={writes}
                      busy={busy}
                      onEdit={(row) => setDialog({ kind: "edit", entryId: row.entryId })}
                      onRetry={(row) => void run("meals.log.reestimate", { entryId: row.entryId })}
                      onDelete={(row) => void run("meals.log.delete", { entryId: row.entryId })}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          <div className="mls-sticky">{addButton}</div>
        </>
      )}

      {dialog?.kind === "add" ? (
        <AddMealDialog
          localDate={props.localDate}
          defaultTime={props.localDate === todayIso() ? nowTime() : "12:00"}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={async ({ description, servingNote, time }) => {
            const tz = zone();
            const done = await run("meals.log.add", {
              description,
              ...(servingNote !== null ? { servingNote } : {}),
              consumedAt: consumedAt(time),
              ...(tz !== null ? { timeZone: tz } : {}),
              captureKind: "text",
              idempotencyKey: newKey()
            });
            if (done) setDialog(null);
          }}
        />
      ) : null}
      {editing !== undefined ? (
        <EditMealDialog
          entry={editing}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={async (input, time) => {
            const tz = zone();
            const timeChanged = time !== timeValue(editing);
            const done = await run("meals.log.correct", {
              ...input,
              ...(timeChanged ? { consumedAt: consumedAt(time) } : {}),
              ...(timeChanged && tz !== null ? { timeZone: tz } : {})
            });
            if (done) setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}
