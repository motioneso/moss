// external-modules/meals/src/web/screens/pantry.tsx
//
// The Pantry area: what the household has on hand, a find box, add, edit and remove with Undo,
// and a rail of Staples. The Staples list opens as a dialog on its own path. Write controls show
// only with the host's write handle.
import {
  Button,
  EmptyState,
  Eyebrow,
  useEffect,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type {
  PantryEditResult,
  PantryItemView,
  PantryView,
  StapleView,
  UndoToken
} from "../../contracts";
import { amountText } from "../format";
import type { PantryState } from "../pantry";
import { navigate } from "../router";
import type { HostActions } from "../root";
import type { MealsWrites } from "../writes";
import { ItemDialog, StaplesDialog } from "./pantry-dialogs";

const TOAST_MS = 8000;

const SOURCE_TEXT: Record<PantryItemView["source"], string> = {
  manual: "Added by you",
  bought: "Bought",
  leftover: "Leftover",
  receipt: "From a receipt"
};

type Dialog = { kind: "add" } | { kind: "edit"; itemId: string } | null;
type Toast = { readonly text: string; readonly undo: UndoToken | null };

export function PantryScreen(props: {
  state: PantryState;
  reload: () => void;
  apply: (pantry: PantryView) => void;
  staplesOpen: boolean;
  writes: MealsWrites | null;
  hostActions: HostActions;
}): ReactNodeLike {
  const { state } = props;
  if (state.kind === "loading") {
    return (
      <p className="jds-caption" role="status">
        Loading the Pantry
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="jds-recovery" role="alert">
        <div>
          <div className="jds-recovery__title">Couldn't load the Pantry</div>
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
  return <Pantry {...props} pantry={state.pantry} />;
}

function ItemRow(props: {
  item: PantryItemView;
  writes: MealsWrites | null;
  busy: boolean;
  onEdit: (item: PantryItemView) => void;
  onRemove: (item: PantryItemView) => void;
}): ReactNodeLike {
  const { item, writes } = props;
  return (
    <li className="mls-line mls-line--plain mls-line--tools">
      <span className="mls-line__body">
        <span className="mls-line__name">{item.name}</span>
        <span className="jds-caption">{SOURCE_TEXT[item.source]}</span>
      </span>
      <span className="mls-line__amount">
        {item.quantity !== null ? (
          <span className="mls-num">{amountText(item.quantity, item.unit)}</span>
        ) : (
          <span className="jds-caption">Some</span>
        )}
      </span>
      {writes !== null ? (
        <span className="mls-line__tools">
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Edit ${item.name}`}
            disabled={props.busy}
            onClick={() => props.onEdit(item)}
          >
            Edit
          </Button>
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Remove ${item.name}`}
            disabled={props.busy}
            onClick={() => props.onRemove(item)}
          >
            Remove
          </Button>
        </span>
      ) : null}
    </li>
  );
}

function Pantry(props: {
  pantry: PantryView;
  reload: () => void;
  apply: (pantry: PantryView) => void;
  staplesOpen: boolean;
  writes: MealsWrites | null;
  hostActions: HostActions;
}): ReactNodeLike {
  const { pantry, writes } = props;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [find, setFind] = useState("");

  useEffect(() => {
    if (toast === null) return undefined;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function run(
    input: Record<string, unknown>,
    toastFor?: (result: PantryEditResult) => Toast | null
  ): Promise<boolean> {
    if (writes === null || busy) return false;
    setBusy(true);
    setFailed(false);
    const outcome = await writes.invoke("meals.pantry.edit", input);
    setBusy(false);
    if (outcome.kind === "succeeded") {
      const result = outcome.result as PantryEditResult;
      props.apply(result.pantry);
      if (toastFor) setToast(toastFor(result));
      return true;
    }
    if (outcome.kind !== "cancelled") setFailed(true);
    return false;
  }

  const remove = async (item: PantryItemView) => {
    const done = await run({ action: "remove", itemId: item.itemId }, (result) => ({
      text: `Removed ${item.name}`,
      undo: result.undo
    }));
    if (done) setDialog(null);
  };

  async function undoLast(token: UndoToken) {
    if (writes === null) return;
    setToast(null);
    const outcome = await writes.invoke("meals.undo", { actionId: token.actionId });
    props.reload();
    if (outcome.kind !== "succeeded" && outcome.kind !== "cancelled") setFailed(true);
  }

  const needle = find.trim().toLowerCase();
  const shown =
    needle === ""
      ? pantry.items
      : pantry.items.filter((i) => i.name.toLowerCase().includes(needle));
  const editing =
    dialog?.kind === "edit"
      ? pantry.items.find((item) => item.itemId === dialog.itemId)
      : undefined;

  const askMoss = (
    <Button
      variant="secondary"
      onClick={() => props.hostActions.openAssistant({ starterPrompt: "Add to my Pantry: " })}
    >
      Ask Moss
    </Button>
  );
  const addButton =
    writes !== null ? (
      <Button onClick={() => setDialog({ kind: "add" })}>Add item</Button>
    ) : (
      askMoss
    );

  const staplesRail = (
    <aside className="mls-rail" aria-label="Staples">
      <section className="mls-stack mls-stack--tight">
        <Eyebrow>Staples</Eyebrow>
        {pantry.staples.length > 0 ? (
          <ul className="mls-table">
            {pantry.staples.map((staple: StapleView) => (
              <li key={staple.stapleId}>
                <span>{staple.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="jds-caption">No Staples yet.</p>
        )}
        {writes !== null ? (
          <Button variant="link" size="sm" onClick={() => navigate("/pantry/staples")}>
            Edit Staples
          </Button>
        ) : null}
      </section>
    </aside>
  );

  return (
    <div className="mls-stack">
      {pantry.items.length === 0 ? (
        <div className="mls-grid">
          <EmptyState title="The Pantry is empty">{addButton}</EmptyState>
          {staplesRail}
        </div>
      ) : (
        <>
          <div className="mls-planbar">
            <div className="mls-find">
              <input
                className="jds-input jds-input--sm"
                type="search"
                aria-label="Find an item"
                placeholder="Find an item"
                value={find}
                onChange={(event: { target: { value: string } }) => setFind(event.target.value)}
              />
              <span className="jds-caption">
                <strong className="mls-num">{shown.length}</strong>{" "}
                {shown.length === 1 ? "item" : "items"}
              </span>
            </div>
            <div className="mls-row mls-hide-phone">{addButton}</div>
          </div>
          {failed ? (
            <p className="jds-caption" role="alert">
              That did not go through. Try again.
            </p>
          ) : null}
          <div className="mls-grid">
            <div className="mls-stack">
              {shown.length > 0 ? (
                <section className="mls-section" aria-label="On hand">
                  <div className="mls-block-head">
                    <h3 className="jds-card-title">On hand</h3>
                    <span className="jds-caption">{shown.length}</span>
                  </div>
                  <ul className="mls-list">
                    {shown.map((item) => (
                      <ItemRow
                        key={item.itemId}
                        item={item}
                        writes={writes}
                        busy={busy}
                        onEdit={(row) => setDialog({ kind: "edit", itemId: row.itemId })}
                        onRemove={(row) => void remove(row)}
                      />
                    ))}
                  </ul>
                </section>
              ) : (
                <EmptyState title="No item matches" />
              )}
            </div>
            {staplesRail}
          </div>
          <div className="mls-sticky">{addButton}</div>
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
        <ItemDialog
          item={null}
          busy={busy}
          onClose={() => setDialog(null)}
          onRemove={null}
          onSave={async (input: Record<string, unknown>) => {
            if (await run(input)) setDialog(null);
          }}
        />
      ) : null}
      {editing !== undefined ? (
        <ItemDialog
          item={editing}
          busy={busy}
          onClose={() => setDialog(null)}
          onRemove={() => void remove(editing)}
          onSave={async (input: Record<string, unknown>) => {
            if (await run(input)) setDialog(null);
          }}
        />
      ) : null}
      {props.staplesOpen && writes !== null ? (
        <StaplesDialog
          staples={pantry.staples}
          busy={busy}
          failed={failed}
          onClose={() => navigate("/pantry")}
          onAdd={(name: string) => run({ action: "add", target: "staple", name })}
          onRemove={(staple: StapleView) =>
            void run({ action: "remove", target: "staple", stapleId: staple.stapleId })
          }
        />
      ) : null}
    </div>
  );
}
