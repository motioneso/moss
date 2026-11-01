// external-modules/meals/src/web/screens/pantry-dialogs.tsx
//
// The Pantry dialogs: add or edit an item, and the Staples list. Each reports the tool input
// back to the screen, which runs the write.
import {
  Button,
  Dialog,
  Field,
  FormLabel,
  useId,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { PantryItemView, StapleView } from "../../contracts";

type Typed = { target: { value: string } };

/** An amount typed into the Amount box. Null when it is not a number above 0. */
function readQuantity(text: string): number | null {
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : null;
}

export function ItemDialog(props: {
  item: PantryItemView | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: Record<string, unknown>) => void;
  onRemove: (() => void) | null;
}): ReactNodeLike {
  const { item } = props;
  const nameId = useId();
  const amountId = useId();
  const unitId = useId();
  const [name, setName] = useState(item?.name ?? "");
  const [amount, setAmount] = useState(item?.quantity != null ? String(item.quantity) : "");
  const [unit, setUnit] = useState(item?.unit ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  function save() {
    if (name.trim() === "") {
      setProblem("Enter the item first");
      return;
    }
    const quantity = amount.trim() === "" ? null : readQuantity(amount);
    if (amount.trim() !== "" && quantity === null) {
      setProblem("Enter the amount as a number above 0, or leave it blank for some");
      return;
    }
    props.onSave({
      action: item === null ? "add" : "update",
      ...(item === null ? {} : { itemId: item.itemId }),
      name: name.trim(),
      quantity,
      unit: quantity === null || unit.trim() === "" ? null : unit.trim()
    });
  }

  return (
    <Dialog
      title={item === null ? "Add to the Pantry" : `Edit ${item.name}`}
      onClose={props.onClose}
      closeLabel="Close"
      footer={
        <>
          {props.onRemove !== null ? (
            <Button variant="danger" disabled={props.busy} onClick={props.onRemove}>
              Remove
            </Button>
          ) : null}
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={props.busy} onClick={save}>
            {item === null ? "Add" : "Save"}
          </Button>
        </>
      }
    >
      <div className="mls-form">
        <Field>
          <FormLabel htmlFor={nameId}>Item</FormLabel>
          <input
            id={nameId}
            className="jds-input"
            value={name}
            maxLength={80}
            placeholder="Basmati rice"
            onChange={(event: Typed) => setName(event.target.value)}
          />
        </Field>
        <div className="mls-form-grid">
          <Field>
            <FormLabel htmlFor={amountId}>Amount</FormLabel>
            <input
              id={amountId}
              className="jds-input"
              value={amount}
              inputMode="decimal"
              placeholder="Optional"
              onChange={(event: Typed) => setAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FormLabel htmlFor={unitId}>Unit</FormLabel>
            <input
              id={unitId}
              className="jds-input"
              value={unit}
              maxLength={24}
              placeholder="lb, can, bag"
              onChange={(event: Typed) => setUnit(event.target.value)}
            />
          </Field>
        </div>
        <p className="jds-hint">
          Leave the amount blank when you have some but no measured amount.
        </p>
        {problem !== null ? (
          <p className="jds-hint jds-hint--error" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export function StaplesDialog(props: {
  staples: readonly StapleView[];
  busy: boolean;
  failed: boolean;
  onClose: () => void;
  onAdd: (name: string) => Promise<boolean>;
  onRemove: (staple: StapleView) => void;
}): ReactNodeLike {
  const newId = useId();
  const [name, setName] = useState("");

  async function add() {
    if (name.trim() === "") return;
    if (await props.onAdd(name.trim())) setName("");
  }

  return (
    <Dialog
      title="Staples"
      description="Things you always have, such as salt, oil and water. They never go on the shopping list."
      onClose={props.onClose}
      closeLabel="Close"
      footer={<Button onClick={props.onClose}>Done</Button>}
    >
      <div className="mls-stack">
        {props.staples.length > 0 ? (
          <ul className="mls-list">
            {props.staples.map((staple) => (
              <li className="mls-line mls-line--plain" key={staple.stapleId}>
                <span className="mls-line__body">
                  <span className="mls-line__name">{staple.name}</span>
                </span>
                <span className="mls-line__tools">
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Stop keeping ${staple.name}`}
                    disabled={props.busy}
                    onClick={() => props.onRemove(staple)}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="jds-caption">No Staples yet.</p>
        )}
        <div className="mls-inline-add">
          <input
            id={newId}
            className="jds-input"
            aria-label="New Staple"
            value={name}
            maxLength={80}
            placeholder="Add a Staple"
            onChange={(event: Typed) => setName(event.target.value)}
            onKeyDown={(event: { key: string }) => {
              if (event.key === "Enter") void add();
            }}
          />
          <Button variant="secondary" disabled={props.busy || name.trim() === ""} onClick={add}>
            Add
          </Button>
        </div>
        {props.failed ? (
          <p className="jds-hint jds-hint--error" role="alert">
            That did not go through. Try again.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
