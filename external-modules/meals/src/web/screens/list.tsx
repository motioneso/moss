// external-modules/meals/src/web/screens/list.tsx
//
// The Shopping list area: lines by store section, ticking, add and edit, Bought with edited
// amounts, and an Undo toast. Write controls show only with the host's write handle.
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  useEffect,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type {
  BoughtResult,
  ListEditResult,
  ListLineView,
  PlanView,
  ShoppingListView,
  StoreSection,
  UndoResult,
  UndoToken
} from "../../contracts";
import { amountText } from "../format";
import { useWakeLock, type ListState } from "../list";
import type { HostActions } from "../root";
import type { MealsWrites } from "../writes";
import {
  AddLineDialog,
  BoughtDialog,
  buyText,
  EditLineDialog,
  SECTION_LABELS
} from "./list-dialogs";
import { PANTRY_LABEL } from "./plan";

const SECTION_ORDER = Object.keys(SECTION_LABELS) as StoreSection[];
const TOAST_MS = 8000;

type Dialog = { kind: "add" } | { kind: "edit"; lineId: string } | { kind: "bought" } | null;
type Toast = { readonly text: string; readonly undo: UndoToken | null };

export function ListScreen(props: {
  state: ListState;
  reload: () => void;
  apply: (list: ShoppingListView) => void;
  plan: PlanView | null;
  writes: MealsWrites | null;
  hostActions: HostActions;
}): ReactNodeLike {
  const { state } = props;
  if (state.kind === "loading") {
    return (
      <p className="jds-caption" role="status">
        Loading the shopping list
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="jds-recovery" role="alert">
        <div>
          <div className="jds-recovery__title">Couldn't load the shopping list</div>
          <div className="jds-recovery__msg">Check the connection, then try again.</div>
          <div className="jds-recovery__actions">
            <Button variant="secondary" size="sm" onClick={props.reload}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return <List {...props} list={state.list} />;
}

function sourcesText(line: ListLineView): string {
  if (line.notInPlan) return "No longer in the plan";
  if (line.sources.length > 0) return `For ${line.sources.map((s) => s.label).join(", ")}`;
  return line.convertedFrom.join(", ");
}

function LineRow(props: {
  line: ListLineView;
  writes: MealsWrites | null;
  busy: boolean;
  onTick: (line: ListLineView, checked: boolean) => void;
  onEdit: (line: ListLineView) => void;
  onRemove: (line: ListLineView) => void;
}): ReactNodeLike {
  const { line, writes } = props;
  const ticked = line.checkedAt !== null;
  const buy = buyText(line);
  const need =
    !line.manual && line.quantity !== null && line.purchase !== null
      ? amountText(line.quantity, line.unit)
      : "";
  const meta = sourcesText(line);
  const toggle = () => {
    if (writes !== null && !props.busy) props.onTick(line, !ticked);
  };
  return (
    <li className={`mls-line${ticked ? " mls-line--done" : ""}`}>
      <Checkbox
        ariaLabel={`Got ${line.name}`}
        checked={ticked}
        disabled={writes === null || props.busy}
        onChange={(checked: boolean) => props.onTick(line, checked)}
      />
      <span className="mls-line__body mls-line__hit" onClick={toggle}>
        <span className="mls-line__name">{line.name}</span>
        {meta !== "" ? <span className="jds-caption">{meta}</span> : null}
        {line.sources.length > 0 && line.convertedFrom.length > 0 ? (
          <span className="jds-caption">{line.convertedFrom.join(", ")}</span>
        ) : null}
        {line.manual || line.notInPlan ? (
          <span className="mls-row">
            {line.manual ? <Badge>Added</Badge> : null}
            {line.notInPlan ? <Badge tone="amber">Not in the plan</Badge> : null}
          </span>
        ) : null}
      </span>
      <span className="mls-line__amount mls-line__hit" onClick={toggle}>
        <span className="mls-num">{buy}</span>
        {need !== "" && need !== buy ? <span className="jds-caption">Needs {need}</span> : null}
      </span>
      {writes !== null ? (
        <span className="mls-line__tools">
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Edit ${line.name}`}
            disabled={props.busy}
            onClick={() => props.onEdit(line)}
          >
            Edit
          </Button>
          {line.manual ? (
            <Button
              variant="quiet"
              size="sm"
              aria-label={`Remove ${line.name}`}
              disabled={props.busy}
              onClick={() => props.onRemove(line)}
            >
              Remove
            </Button>
          ) : null}
        </span>
      ) : (
        <span />
      )}
    </li>
  );
}

function Section(props: {
  name: string;
  lines: readonly ListLineView[];
  rowProps: Omit<Parameters<typeof LineRow>[0], "line">;
}): ReactNodeLike {
  const done = props.lines.filter((line) => line.checkedAt !== null).length;
  return (
    <section className="mls-section" aria-label={props.name}>
      <div className="mls-block-head">
        <h3 className="jds-card-title">{props.name}</h3>
        <span className="jds-caption">
          {done > 0 ? `${done} of ${props.lines.length}` : String(props.lines.length)}
        </span>
      </div>
      <ul className="mls-list mls-list--shop">
        {props.lines.map((line) => (
          <LineRow key={line.lineId} line={line} {...props.rowProps} />
        ))}
      </ul>
    </section>
  );
}

function List(props: {
  list: ShoppingListView;
  reload: () => void;
  apply: (list: ShoppingListView) => void;
  plan: PlanView | null;
  writes: MealsWrites | null;
  hostActions: HostActions;
}): ReactNodeLike {
  const { list, writes, plan } = props;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  useWakeLock(true);
  useEffect(() => {
    if (toast === null) return undefined;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const open = list.lines.filter((line) => line.boughtAt === null);
  const shopping = open.filter((line) => !line.coveredByPantry);
  const covered = open.filter((line) => line.coveredByPantry);
  const ticked = shopping.filter((line) => line.checkedAt !== null);
  const percent = shopping.length > 0 ? Math.round((ticked.length / shopping.length) * 100) : 0;
  const offerBuild =
    writes !== null &&
    plan !== null &&
    plan.planId !== list.planId &&
    plan.days.some((day) => day.meals.some((meal) => meal.status === "ready"));

  async function run<T extends { list: ShoppingListView }>(
    name: "meals.list.edit" | "meals.list.build" | "meals.list.bought",
    input: Record<string, unknown>,
    toastFor?: (result: T) => Toast | null
  ): Promise<boolean> {
    // meals.list.build returns the list itself; the other writes wrap it as { list }.

    if (writes === null || busy) return false;
    setBusy(true);
    setFailed(false);
    const outcome = await writes.invoke(name, input);
    setBusy(false);
    if (outcome.kind === "succeeded") {
      const raw = outcome.result as T | ShoppingListView;
      const result = ("list" in raw ? raw : { list: raw }) as T;
      props.apply(result.list);
      if (toastFor) setToast(toastFor(result));
      return true;
    }
    if (outcome.kind !== "cancelled") setFailed(true);
    return false;
  }

  const tick = (line: ListLineView, checked: boolean) =>
    void run("meals.list.edit", { action: checked ? "tick" : "untick", lineId: line.lineId });

  const remove = async (line: ListLineView) => {
    const done = await run<ListEditResult>(
      "meals.list.edit",
      { action: "remove", lineId: line.lineId },
      (result) => ({ text: `Removed ${line.name}`, undo: result.undo })
    );
    if (done) setDialog(null);
  };

  const build = () => {
    if (plan !== null) void run("meals.list.build", { planId: plan.planId });
  };

  async function undoLast(token: UndoToken) {
    if (writes === null) return;
    setToast(null);
    const outcome = await writes.invoke("meals.undo", { actionId: token.actionId });
    props.reload();
    if (outcome.kind === "succeeded") {
      const result = outcome.result as UndoResult;
      if (result.skipped > 0) {
        setToast({
          text: `Undone. ${result.skipped} Pantry ${result.skipped === 1 ? "amount" : "amounts"} you changed ${result.skipped === 1 ? "was" : "were"} left alone.`,
          undo: null
        });
      }
    } else if (outcome.kind !== "cancelled") {
      setFailed(true);
    }
  }

  const rowProps = {
    writes,
    busy,
    onTick: tick,
    onEdit: (line: ListLineView) => setDialog({ kind: "edit", lineId: line.lineId }),
    onRemove: (line: ListLineView) => void remove(line)
  };

  const askMoss = (
    <Button
      variant="secondary"
      onClick={() =>
        props.hostActions.openAssistant({ starterPrompt: "Add to my shopping list: " })
      }
    >
      Ask Moss
    </Button>
  );
  const buildButton = offerBuild ? (
    <Button variant="secondary" disabled={busy} onClick={build}>
      Build from the plan
    </Button>
  ) : null;
  const emptyControls =
    writes !== null ? (
      <>
        {buildButton}
        <Button onClick={() => setDialog({ kind: "add" })}>Add item</Button>
      </>
    ) : (
      askMoss
    );

  const controls =
    writes !== null ? (
      <>
        {buildButton}
        <Button variant="secondary" onClick={() => setDialog({ kind: "add" })}>
          Add item
        </Button>
        <Button disabled={busy || open.length === 0} onClick={() => setDialog({ kind: "bought" })}>
          {ticked.length > 0 ? `Bought (${ticked.length})` : "Bought"}
        </Button>
      </>
    ) : (
      askMoss
    );

  const editing =
    dialog?.kind === "edit" ? list.lines.find((line) => line.lineId === dialog.lineId) : undefined;

  return (
    <div className="mls-stack">
      {open.length === 0 ? (
        <EmptyState title="Nothing to buy">{emptyControls}</EmptyState>
      ) : (
        <>
          <div className="mls-planbar">
            <div className="mls-progress">
              <span className="jds-caption">
                <strong className="mls-num">{ticked.length}</strong> of {shopping.length} got
              </span>
              <Badge outline>{PANTRY_LABEL[list.pantryMode]}</Badge>
              <div
                className="jds-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label="Shopping progress"
              >
                <div className="jds-progress__fill" style={{ width: `${percent}%` }} />
              </div>
            </div>
            <div className="mls-row mls-hide-phone">{controls}</div>
          </div>
          {failed ? (
            <p className="jds-caption" role="alert">
              That did not go through. Try again.
            </p>
          ) : null}
          <div className="mls-stack">
            {SECTION_ORDER.map((section) => {
              const lines = shopping.filter((line) => line.section === section);
              return lines.length > 0 ? (
                <Section
                  key={section}
                  name={SECTION_LABELS[section]}
                  lines={lines}
                  rowProps={rowProps}
                />
              ) : null;
            })}
            {covered.length > 0 ? (
              <section className="mls-section" aria-label="You have this">
                <div className="mls-block-head">
                  <h3 className="jds-card-title">You have this</h3>
                  <span className="jds-caption">{covered.length}</span>
                </div>
                <ul className="mls-list">
                  {covered.map((line) => (
                    <li className="mls-line mls-line--plain" key={line.lineId}>
                      <span className="mls-line__body">
                        <span className="mls-line__name">{line.name}</span>
                        {sourcesText(line) !== "" ? (
                          <span className="jds-caption">{sourcesText(line)}</span>
                        ) : null}
                      </span>
                      <span className="mls-line__amount">
                        <span className="mls-num">{buyText(line)}</span>
                        <span className="jds-caption">In the Pantry</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
          <div className="mls-sticky">{controls}</div>
        </>
      )}

      {toast !== null ? (
        <div className="jds-toast mls-toast" role="status">
          <div className="jds-toast__body">
            <div className="jds-toast__title">{toast.text}</div>
          </div>
          {toast.undo !== null && writes !== null ? (
            <Button variant="quiet" size="sm" onClick={() => void undoLast(toast.undo!)}>
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}

      {dialog?.kind === "add" ? (
        <AddLineDialog
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={async (input: Record<string, unknown>) => {
            if (await run("meals.list.edit", input)) setDialog(null);
          }}
        />
      ) : null}
      {editing !== undefined ? (
        <EditLineDialog
          line={editing}
          busy={busy}
          onClose={() => setDialog(null)}
          onRemove={editing.manual ? () => void remove(editing) : null}
          onSave={async (input: Record<string, unknown>) => {
            if (await run("meals.list.edit", input)) setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "bought" ? (
        <BoughtDialog
          lines={open.filter((line) => !line.coveredByPantry)}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={async (lines: Array<Record<string, unknown>>) => {
            const done = await run<BoughtResult>("meals.list.bought", { lines }, (result) => ({
              text: `${result.undo.count} bought and moved to the Pantry`,
              undo: result.undo
            }));
            if (done) setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}
