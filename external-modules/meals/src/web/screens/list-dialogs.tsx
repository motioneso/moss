// external-modules/meals/src/web/screens/list-dialogs.tsx
//
// The three shopping list dialogs: add a line, edit a line, and Bought. Each reports the tool
// input back to the screen, which runs the write.
import {
  Button,
  Checkbox,
  Dialog,
  Eyebrow,
  Field,
  FormLabel,
  Select,
  useId,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { ListLineView, StoreSection } from "../../contracts";
import { amountText, parseAmount } from "../format";

export const SECTION_LABELS: Record<StoreSection, string> = {
  produce: "Produce",
  meat_fish: "Meat and fish",
  dairy_eggs: "Dairy and eggs",
  bakery: "Bakery",
  frozen: "Frozen",
  pantry: "Pantry",
  spices: "Spices",
  drinks: "Drinks",
  household: "Household",
  other: "Other"
};

const SECTIONS = Object.keys(SECTION_LABELS) as StoreSection[];

/** What the shopper buys: the edited purchase amount, else the recipes' need. */
export function buyText(line: ListLineView): string {
  if (line.purchase !== null) return amountText(line.purchase.quantity, line.purchase.unit);
  return line.quantity !== null ? amountText(line.quantity, line.unit) : "";
}

function SectionSelect(props: {
  id: string;
  value: StoreSection;
  onChange: (value: StoreSection) => void;
}): ReactNodeLike {
  return (
    <Select
      id={props.id}
      value={props.value}
      onChange={(event: { target: { value: string } }) =>
        props.onChange(event.target.value as StoreSection)
      }
    >
      {SECTIONS.map((section) => (
        <option key={section} value={section}>
          {SECTION_LABELS[section]}
        </option>
      ))}
    </Select>
  );
}

export function AddLineDialog(props: {
  busy: boolean;
  onClose: () => void;
  onSave: (input: Record<string, unknown>) => void;
}): ReactNodeLike {
  const nameId = useId();
  const amountId = useId();
  const sectionId = useId();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [section, setSection] = useState<StoreSection>("other");
  const [problem, setProblem] = useState<string | null>(null);

  function save() {
    if (name.trim() === "") {
      setProblem("Enter the item first");
      return;
    }
    const input: Record<string, unknown> = { action: "add", name: name.trim(), section };
    if (amount.trim() !== "") {
      const parsed = parseAmount(amount);
      if (parsed === null) {
        setProblem("Start the amount with a number, such as 2 or 500 g");
        return;
      }
      input.quantity = parsed.quantity;
      if (parsed.unit !== null) input.unit = parsed.unit;
    }
    props.onSave(input);
  }

  return (
    <Dialog
      title="Add to the list"
      onClose={props.onClose}
      closeLabel="Close"
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={props.busy} onClick={save}>
            Add
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
            placeholder="Dish soap"
            onChange={(event: { target: { value: string } }) => setName(event.target.value)}
          />
        </Field>
        <div className="mls-form-grid">
          <Field>
            <FormLabel htmlFor={amountId}>Amount</FormLabel>
            <input
              id={amountId}
              className="jds-input"
              value={amount}
              placeholder="Optional"
              onChange={(event: { target: { value: string } }) => setAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FormLabel htmlFor={sectionId}>Section</FormLabel>
            <SectionSelect id={sectionId} value={section} onChange={setSection} />
          </Field>
        </div>
        {problem !== null ? (
          <p className="jds-hint jds-hint--error" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export function EditLineDialog(props: {
  line: ListLineView;
  busy: boolean;
  onClose: () => void;
  onSave: (input: Record<string, unknown>) => void;
  onRemove: (() => void) | null;
}): ReactNodeLike {
  const { line } = props;
  const nameId = useId();
  const amountId = useId();
  const sectionId = useId();
  const [name, setName] = useState(line.name);
  const [amount, setAmount] = useState(buyText(line));
  const [section, setSection] = useState<StoreSection>(line.section);
  const [problem, setProblem] = useState<string | null>(null);
  const needs = line.quantity !== null ? amountText(line.quantity, line.unit) : "";

  function save() {
    if (name.trim() === "") {
      setProblem("Enter the item first");
      return;
    }
    const input: Record<string, unknown> = { action: "update", lineId: line.lineId };
    if (name.trim() !== line.name) input.name = name.trim();
    if (section !== line.section) input.section = section;
    if (amount.trim() !== buyText(line)) {
      const parsed = parseAmount(amount);
      if (parsed === null) {
        setProblem("Start the amount with a number, such as 2 or 500 g");
        return;
      }
      input.quantity = parsed.quantity;
      if (parsed.unit !== null) input.unit = parsed.unit;
    }
    props.onSave(input);
  }

  return (
    <Dialog
      title={`Edit ${line.name}`}
      description={
        line.sources.length > 0 ? `For ${line.sources.map((s) => s.label).join(", ")}` : undefined
      }
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
            Save
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
            onChange={(event: { target: { value: string } }) => setName(event.target.value)}
          />
        </Field>
        <div className="mls-form-grid">
          <Field>
            <FormLabel htmlFor={amountId}>{line.manual ? "Amount" : "Amount to buy"}</FormLabel>
            <input
              id={amountId}
              className="jds-input"
              value={amount}
              onChange={(event: { target: { value: string } }) => setAmount(event.target.value)}
            />
            {!line.manual && needs !== "" && needs !== buyText(line) ? (
              <span className="jds-hint">Recipes need {needs}</span>
            ) : null}
          </Field>
          <Field>
            <FormLabel htmlFor={sectionId}>Section</FormLabel>
            <SectionSelect id={sectionId} value={section} onChange={setSection} />
          </Field>
        </div>
        {problem !== null ? (
          <p className="jds-hint jds-hint--error" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

interface Pick {
  take: boolean;
  amount: string;
}

function BoughtGroup(props: {
  name: string;
  lines: readonly ListLineView[];
  picks: Record<string, Pick>;
  set: (lineId: string, next: Partial<Pick>) => void;
}): ReactNodeLike {
  if (props.lines.length === 0) return null;
  return (
    <section className="mls-stack mls-stack--tight" aria-label={props.name}>
      <Eyebrow>{props.name}</Eyebrow>
      <ul className="mls-list">
        {props.lines.map((line) => {
          const pick = props.picks[line.lineId]!;
          return (
            <li className="mls-line mls-line--bought" key={line.lineId}>
              <Checkbox
                ariaLabel={`Bought ${line.name}`}
                checked={pick.take}
                onChange={(take: boolean) => props.set(line.lineId, { take })}
              />
              <span className="mls-line__body">
                <span className="mls-line__name">{line.name}</span>
                <span className="jds-caption">{SECTION_LABELS[line.section]}</span>
              </span>
              <input
                className="jds-input jds-input--sm mls-line__input"
                aria-label={`Amount of ${line.name}`}
                value={pick.amount}
                disabled={!pick.take}
                onChange={(event: { target: { value: string } }) =>
                  props.set(line.lineId, { amount: event.target.value })
                }
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function BoughtDialog(props: {
  lines: readonly ListLineView[];
  busy: boolean;
  onClose: () => void;
  onSave: (lines: Array<Record<string, unknown>>) => void;
}): ReactNodeLike {
  const [picks, setPicks] = useState<Record<string, Pick>>(() =>
    Object.fromEntries(
      props.lines.map((line) => [
        line.lineId,
        { take: line.checkedAt !== null, amount: buyText(line) }
      ])
    )
  );
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = props.lines.filter((line) => picks[line.lineId]!.take);
  const set = (lineId: string, next: Partial<Pick>) =>
    setPicks((previous: Record<string, Pick>) => ({
      ...previous,
      [lineId]: { ...previous[lineId]!, ...next }
    }));

  function save() {
    const out: Array<Record<string, unknown>> = [];
    for (const line of chosen) {
      const pick = picks[line.lineId]!;
      const entry: Record<string, unknown> = { lineId: line.lineId };
      if (pick.amount.trim() !== buyText(line) && pick.amount.trim() !== "") {
        const parsed = parseAmount(pick.amount);
        if (parsed === null) {
          setProblem(`Start the amount for ${line.name} with a number, such as 2 or 500 g`);
          return;
        }
        entry.quantity = parsed.quantity;
        if (parsed.unit !== null) entry.unit = parsed.unit;
      }
      out.push(entry);
    }
    props.onSave(out);
  }

  return (
    <Dialog
      title="Bought"
      onClose={props.onClose}
      closeLabel="Close"
      scrollBody
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={props.busy || chosen.length === 0} onClick={save}>
            {chosen.length > 0 ? `Move ${chosen.length} to the Pantry` : "Move to the Pantry"}
          </Button>
        </>
      }
    >
      <div className="mls-stack">
        <BoughtGroup
          name="Ticked"
          lines={props.lines.filter((line) => line.checkedAt !== null)}
          picks={picks}
          set={set}
        />
        <BoughtGroup
          name="Not ticked"
          lines={props.lines.filter((line) => line.checkedAt === null)}
          picks={picks}
          set={set}
        />
        {problem !== null ? (
          <p className="jds-hint jds-hint--error" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
