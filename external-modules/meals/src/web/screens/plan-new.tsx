// external-modules/meals/src/web/screens/plan-new.tsx
//
// Starts a plan: the first day, how many days, the Pantry mode and an optional note. Moss writes
// the days one by one on the Plan tab.
import {
  Button,
  Field,
  FormLabel,
  Select,
  randomUuid,
  useId,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { PantryMode } from "../../contracts";
import { todayIso } from "../format";
import { navigate } from "../router";
import type { MealsWrites } from "../writes";
import { PANTRY_LABEL } from "./plan";

const MAX_DAYS = 28;

export function PlanNewScreen(props: {
  writes: MealsWrites | null;
  defaultPantryMode: PantryMode;
  reload: () => void;
}): ReactNodeLike {
  const dateId = useId();
  const daysId = useId();
  const modeId = useId();
  const noteId = useId();
  const [startDate, setStartDate] = useState(todayIso());
  const [days, setDays] = useState("7");
  const [mode, setMode] = useState<PantryMode>(props.defaultPantryMode);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [key] = useState(() => randomUuid());

  async function start() {
    const count = Number(days);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return setProblem("Pick a first day.");
    if (!Number.isInteger(count) || count < 1 || count > MAX_DAYS) {
      return setProblem(`Days must be 1 to ${MAX_DAYS}.`);
    }
    if (props.writes === null || busy) return undefined;
    setBusy(true);
    setProblem(null);
    const outcome = await props.writes.invoke("meals.plan.create", {
      startDate,
      days: count,
      pantryMode: mode,
      idempotencyKey: key,
      ...(note.trim() === "" ? {} : { requestText: note.trim() })
    });
    setBusy(false);
    if (outcome.kind !== "succeeded") return setProblem("That did not go through. Try again.");
    props.reload();
    navigate("/");
    return undefined;
  }

  return (
    <div className="mls-stack">
      <a
        className="mls-back"
        href="/m/meals"
        onClick={(event: { preventDefault: () => void }) => {
          event.preventDefault();
          navigate("/");
        }}
      >
        Back to the plan
      </a>
      <div className="mls-form">
        <div className="mls-form-grid">
          <Field>
            <FormLabel htmlFor={dateId}>First day</FormLabel>
            <input
              id={dateId}
              type="date"
              className="jds-input"
              value={startDate}
              onChange={(event: { target: { value: string } }) => setStartDate(event.target.value)}
            />
          </Field>
          <Field>
            <FormLabel htmlFor={daysId}>Days</FormLabel>
            <input
              id={daysId}
              type="number"
              min={1}
              max={MAX_DAYS}
              className="jds-input"
              value={days}
              onChange={(event: { target: { value: string } }) => setDays(event.target.value)}
            />
          </Field>
        </div>
        <Field>
          <FormLabel htmlFor={modeId}>Pantry</FormLabel>
          <Select
            id={modeId}
            value={mode}
            onChange={(event: { target: { value: string } }) =>
              setMode(event.target.value as PantryMode)
            }
          >
            {(Object.keys(PANTRY_LABEL) as PantryMode[]).map((value) => (
              <option key={value} value={value}>
                {PANTRY_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FormLabel htmlFor={noteId}>Anything you want</FormLabel>
          <textarea
            id={noteId}
            className="jds-textarea"
            rows={3}
            maxLength={1000}
            value={note}
            placeholder="Optional"
            onChange={(event: { target: { value: string } }) => setNote(event.target.value)}
          />
        </Field>
        {problem !== null ? (
          <p className="jds-hint jds-hint--error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="mls-row">
          <Button disabled={busy || props.writes === null} onClick={start}>
            Start the plan
          </Button>
          <Button variant="secondary" onClick={() => navigate("/")}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
