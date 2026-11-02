// external-modules/meals/src/web/screens/household-dialog.tsx
//
// Add or edit one person. Lists are typed with commas. The dialog reports a tool input to the
// screen, which runs the write.
import {
  Button,
  Dialog,
  Field,
  FormLabel,
  useId,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { MemberView } from "../../contracts";

type Typed = { target: { value: string } };

const words = (text: string): string[] =>
  text
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");

export function PersonDialog(props: {
  member: MemberView | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: Record<string, unknown>) => void;
}): ReactNodeLike {
  const { member } = props;
  const nameId = useId();
  const mealsId = useId();
  const neverId = useId();
  const likesId = useId();
  const caloriesId = useId();
  const [name, setName] = useState(member?.name ?? "");
  const [meals, setMeals] = useState(member?.mealPattern.join(", ") ?? "");
  const [never, setNever] = useState(member?.restrictions.join(", ") ?? "");
  const [likes, setLikes] = useState(member?.preferences.join(", ") ?? "");
  const [calories, setCalories] = useState(
    member?.calorieTarget != null ? String(member.calorieTarget) : ""
  );
  const [problem, setProblem] = useState<string | null>(null);

  function save() {
    if (name.trim() === "") {
      setProblem("Enter a name first");
      return;
    }
    const target = calories.trim() === "" ? null : Number(calories.trim());
    if (target !== null && (!Number.isInteger(target) || target < 800 || target > 6000)) {
      setProblem("Enter a daily calorie target from 800 to 6000, or leave it blank");
      return;
    }
    const mealPattern = words(meals);
    props.onSave({
      ...(member === null ? {} : { memberId: member.memberId }),
      name: name.trim(),
      restrictions: words(never),
      ...(member !== null || likes.trim() !== "" ? { preferences: words(likes) } : {}),
      ...(mealPattern.length > 0 ? { mealPattern } : {}),
      ...(member !== null || target !== null ? { calorieTarget: target } : {})
    });
  }

  return (
    <Dialog
      title={member === null ? "Add a person" : `Edit ${member.name}`}
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
        <Field>
          <FormLabel htmlFor={nameId}>Name</FormLabel>
          <input
            id={nameId}
            aria-label="Name"
            className="jds-input"
            value={name}
            maxLength={80}
            onChange={(event: Typed) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FormLabel htmlFor={neverId}>Never serve</FormLabel>
          <input
            id={neverId}
            aria-label="Never serve"
            className="jds-input"
            value={never}
            placeholder="peanuts, shellfish"
            onChange={(event: Typed) => setNever(event.target.value)}
          />
        </Field>
        <Field>
          <FormLabel htmlFor={likesId}>Preferences</FormLabel>
          <input
            id={likesId}
            aria-label="Preferences"
            className="jds-input"
            value={likes}
            placeholder="vegetarian, no mushrooms"
            onChange={(event: Typed) => setLikes(event.target.value)}
          />
        </Field>
        <div className="mls-form-grid">
          <Field>
            <FormLabel htmlFor={mealsId}>Meals a day</FormLabel>
            <input
              id={mealsId}
              aria-label="Meals a day"
              className="jds-input"
              value={meals}
              placeholder="breakfast, lunch, dinner"
              onChange={(event: Typed) => setMeals(event.target.value)}
            />
          </Field>
          <Field>
            <FormLabel htmlFor={caloriesId}>Daily calories</FormLabel>
            <input
              id={caloriesId}
              aria-label="Daily calories"
              className="jds-input"
              value={calories}
              inputMode="numeric"
              placeholder="Optional"
              onChange={(event: Typed) => setCalories(event.target.value)}
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
