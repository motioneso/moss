// external-modules/meals/src/web/screens/log-dialogs.tsx
//
// The Log dialogs: log a meal, and edit one. Each reports the tool input back to the screen,
// which runs the write.
import {
  Button,
  Dialog,
  Field,
  FormLabel,
  useId,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { LogEntryView, LogItemView, NutrientsView } from "../../contracts";
import { amount, timeValue, type NutrientKey } from "../log-format";

type Typed = { target: { value: string } };

const MACRO_FIELDS: ReadonlyArray<{ key: NutrientKey; label: string }> = [
  { key: "caloriesKcal", label: "Calories" },
  { key: "proteinG", label: "Protein (g)" },
  { key: "carbohydratesG", label: "Carbs (g)" },
  { key: "fatG", label: "Fat (g)" }
];

/** A typed figure. Blank is unknown (null). Undefined means the text is not a figure. */
function readFigure(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
}

export function AddMealDialog(props: {
  localDate: string;
  defaultTime: string;
  busy: boolean;
  onClose: () => void;
  onSave: (input: { description: string; servingNote: string | null; time: string }) => void;
}): ReactNodeLike {
  const descriptionId = useId();
  const servingId = useId();
  const timeId = useId();
  const [description, setDescription] = useState("");
  const [serving, setServing] = useState("");
  const [time, setTime] = useState(props.defaultTime);
  const [problem, setProblem] = useState<string | null>(null);

  function save() {
    if (description.trim() === "") {
      setProblem("Enter what you ate first");
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      setProblem("Enter the time of the meal");
      return;
    }
    props.onSave({
      description: description.trim(),
      servingNote: serving.trim() === "" ? null : serving.trim(),
      time
    });
  }

  return (
    <Dialog
      title="Log a meal"
      onClose={props.onClose}
      closeLabel="Close"
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={props.busy} onClick={save}>
            Log
          </Button>
        </>
      }
    >
      <div className="mls-form">
        <Field>
          <FormLabel htmlFor={descriptionId}>What you ate</FormLabel>
          <input
            id={descriptionId}
            className="jds-input"
            value={description}
            maxLength={500}
            placeholder="Two eggs on toast"
            onChange={(event: Typed) => setDescription(event.target.value)}
          />
        </Field>
        <div className="mls-form-grid">
          <Field>
            <FormLabel htmlFor={servingId}>Portion</FormLabel>
            <input
              id={servingId}
              className="jds-input"
              value={serving}
              maxLength={200}
              placeholder="Optional"
              onChange={(event: Typed) => setServing(event.target.value)}
            />
          </Field>
          <Field>
            <FormLabel htmlFor={timeId}>Time</FormLabel>
            <input
              id={timeId}
              className="jds-input"
              type="time"
              value={time}
              onChange={(event: Typed) => setTime(event.target.value)}
            />
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

type ItemDraft = { label: string; portion: string } & Record<NutrientKey, string>;

function draftOf(item: LogItemView): ItemDraft {
  const n = item.nutrients;
  return {
    label: item.label,
    portion: item.portionNote ?? "",
    caloriesKcal: amount(n.caloriesKcal) === "-" ? "" : amount(n.caloriesKcal),
    proteinG: amount(n.proteinG, 1) === "-" ? "" : amount(n.proteinG, 1),
    carbohydratesG: amount(n.carbohydratesG, 1) === "-" ? "" : amount(n.carbohydratesG, 1),
    fatG: amount(n.fatG, 1) === "-" ? "" : amount(n.fatG, 1),
    fiberG: "",
    sugarG: "",
    sodiumMg: ""
  };
}

export function EditMealDialog(props: {
  entry: LogEntryView;
  busy: boolean;
  onClose: () => void;
  onSave: (input: Record<string, unknown>, time: string) => void;
}): ReactNodeLike {
  const { entry } = props;
  const baseId = useId();
  const [description, setDescription] = useState(entry.description);
  const [time, setTime] = useState(timeValue(entry));
  const [drafts, setDrafts] = useState<ItemDraft[]>(entry.items.map(draftOf));
  const [problem, setProblem] = useState<string | null>(null);

  function setDraft(index: number, patch: Partial<ItemDraft>) {
    setDrafts((current: ItemDraft[]) =>
      current.map((draft, at) => (at === index ? { ...draft, ...patch } : draft))
    );
  }

  function save() {
    if (description.trim() === "") {
      setProblem("Enter what you ate first");
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      setProblem("Enter the time of the meal");
      return;
    }
    // Only an item the user changed is sent; null leaves the food alone.
    const items: Array<Record<string, unknown> | null> = [];
    let any = false;
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index]!;
      const original = draftOf(entry.items[index]!);
      const patch: Record<string, unknown> = {};
      if (draft.label.trim() === "") {
        setProblem("Every food needs a name");
        return;
      }
      if (draft.label.trim() !== original.label) patch.label = draft.label.trim();
      if (draft.portion.trim() !== original.portion) {
        patch.portionNote = draft.portion.trim() === "" ? null : draft.portion.trim();
      }
      const nutrients: Partial<NutrientsView> = {};
      for (const { key, label } of MACRO_FIELDS) {
        if (draft[key] === original[key]) continue;
        const figure = readFigure(draft[key]);
        if (figure === undefined) {
          setProblem(`${label} must be a number, or blank if unknown`);
          return;
        }
        (nutrients as Record<string, number | null>)[key] = figure;
      }
      if (Object.keys(nutrients).length > 0) patch.nutrients = nutrients;
      if (Object.keys(patch).length > 0) any = true;
      items.push(Object.keys(patch).length > 0 ? patch : null);
    }
    props.onSave(
      {
        entryId: entry.entryId,
        expectedRevision: entry.estimateRevision,
        ...(description.trim() !== entry.description ? { description: description.trim() } : {}),
        ...(any ? { items } : {})
      },
      time
    );
  }

  return (
    <Dialog
      title="Edit meal"
      onClose={props.onClose}
      closeLabel="Close"
      footer={
        <>
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
        <div className="mls-form-grid">
          <Field>
            <FormLabel htmlFor={`${baseId}-d`}>What you ate</FormLabel>
            <input
              id={`${baseId}-d`}
              className="jds-input"
              value={description}
              maxLength={500}
              onChange={(event: Typed) => setDescription(event.target.value)}
            />
          </Field>
          <Field>
            <FormLabel htmlFor={`${baseId}-t`}>Time</FormLabel>
            <input
              id={`${baseId}-t`}
              className="jds-input"
              type="time"
              value={time}
              onChange={(event: Typed) => setTime(event.target.value)}
            />
          </Field>
        </div>
        {drafts.map((draft, index) => (
          <fieldset className="mls-item-form" key={index}>
            <legend className="jds-eyebrow">{`Food ${index + 1}`}</legend>
            <div className="mls-form-grid">
              <Field>
                <FormLabel htmlFor={`${baseId}-l${index}`}>Name</FormLabel>
                <input
                  id={`${baseId}-l${index}`}
                  className="jds-input"
                  value={draft.label}
                  maxLength={120}
                  onChange={(event: Typed) => setDraft(index, { label: event.target.value })}
                />
              </Field>
              <Field>
                <FormLabel htmlFor={`${baseId}-p${index}`}>Portion</FormLabel>
                <input
                  id={`${baseId}-p${index}`}
                  className="jds-input"
                  value={draft.portion}
                  maxLength={200}
                  onChange={(event: Typed) => setDraft(index, { portion: event.target.value })}
                />
              </Field>
            </div>
            <div className="mls-figures">
              {MACRO_FIELDS.map(({ key, label }) => (
                <Field key={key}>
                  <FormLabel htmlFor={`${baseId}-${key}${index}`}>{label}</FormLabel>
                  <input
                    id={`${baseId}-${key}${index}`}
                    className="jds-input"
                    inputMode="decimal"
                    value={draft[key]}
                    onChange={(event: Typed) =>
                      setDraft(index, { [key]: event.target.value } as Partial<ItemDraft>)
                    }
                  />
                </Field>
              ))}
            </div>
          </fieldset>
        ))}
        {problem !== null ? (
          <p className="jds-hint jds-hint--error" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
