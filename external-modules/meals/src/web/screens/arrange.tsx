// external-modules/meals/src/web/screens/arrange.tsx
//
// Arrange one meal: move it to another day or slot, change who eats it, or set its slot to
// plain text. Writes go through the host's tools handle; without one the screens only show.
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormLabel,
  SectionHead,
  Select,
  useEffect,
  useId,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { KitchenView, PlanView, RecipeView } from "../../contracts";
import { readTool } from "../api";
import { dayTitle, titleCase, todayIso } from "../format";
import { navigate } from "../router";
import type { MealsWrites } from "../writes";

type MealState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly recipe: RecipeView };

function useMeal(mealId: string): MealState {
  const [state, setState] = useState<MealState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    readTool<RecipeView>("meals.meal.get", { mealId }).then(
      (recipe) => live && setState({ kind: "ready", recipe }),
      () => live && setState({ kind: "error" })
    );
    return () => {
      live = false;
    };
  }, [mealId]);
  return state;
}

function BackLink(): ReactNodeLike {
  return (
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
  );
}

function Shell(props: {
  title: string;
  state: MealState;
  children: (recipe: RecipeView) => ReactNodeLike;
}): ReactNodeLike {
  if (props.state.kind === "loading") {
    return (
      <div className="mls-stack">
        <BackLink />
        <p className="jds-caption" role="status">
          Loading this meal
        </p>
      </div>
    );
  }
  if (props.state.kind === "error") {
    return (
      <div className="mls-stack">
        <BackLink />
        <EmptyState title="Couldn't load this meal" />
      </div>
    );
  }
  return (
    <div className="mls-stack">
      <BackLink />
      <SectionHead title={props.title} rule />
      {props.children(props.state.recipe)}
    </div>
  );
}

function useRun(writes: MealsWrites | null) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function run(
    name: "meals.meal.edit" | "meals.day.edit",
    input: Record<string, unknown>
  ): Promise<boolean> {
    if (writes === null || busy) return false;
    setBusy(true);
    setFailed(false);
    const outcome = await writes.invoke(name, input);
    setBusy(false);
    if (outcome.kind !== "succeeded") {
      setFailed(true);
      return false;
    }
    navigate("/");
    return true;
  }
  return { busy, failed, run };
}

const FailedNote = (props: { failed: boolean }): ReactNodeLike =>
  props.failed ? (
    <p className="jds-caption" role="alert">
      That did not go through. Try again.
    </p>
  ) : null;

export function MoveScreen(props: { mealId: string; writes: MealsWrites | null }): ReactNodeLike {
  const state = useMeal(props.mealId);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [targetDayId, setTargetDayId] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const { busy, failed, run } = useRun(props.writes);
  const slotId = useId();

  useEffect(() => {
    let live = true;
    readTool<{ plan: PlanView | null }>("meals.plan.current", { date: todayIso() }).then(
      (result) => live && setPlan(result.plan),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <Shell title="Move this meal" state={state}>
      {(recipe) => {
        const currentDay = plan?.days.find((day) =>
          day.meals.some((meal) => meal.mealId === props.mealId)
        );
        const chosen = targetDayId ?? currentDay?.dayId ?? null;
        const slots = [
          ...new Set(plan?.days.flatMap((day) => day.meals.map((meal) => meal.slotName)) ?? [])
        ];
        if (!slots.includes(recipe.meal.slotName)) slots.unshift(recipe.meal.slotName);
        const chosenSlot = slot ?? recipe.meal.slotName;
        return (
          <div className="mls-stack--tight mls-stack">
            <p className="mls-meal__title">{recipe.meal.title ?? recipe.meal.plainText}</p>
            {plan === null ? (
              <p className="jds-caption" role="status">
                Loading the days
              </p>
            ) : (
              <div className="mls-form">
                <div className="mls-row" role="group" aria-label="Day to move to">
                  {plan.days.map((day) => (
                    <Button
                      key={day.dayId}
                      data-day-id={day.dayId}
                      variant={day.dayId === chosen ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => setTargetDayId(day.dayId)}
                    >
                      {dayTitle(day.date)}
                    </Button>
                  ))}
                </div>
                <Field>
                  <FormLabel htmlFor={slotId}>Meal</FormLabel>
                  <Select
                    id={slotId}
                    value={chosenSlot}
                    onChange={(event: { target: { value: string } }) => setSlot(event.target.value)}
                  >
                    {slots.map((name) => (
                      <option key={name} value={name}>
                        {titleCase(name)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <FailedNote failed={failed} />
            {props.writes !== null && plan !== null ? (
              <div className="mls-row">
                <Button
                  disabled={busy || chosen === null}
                  onClick={() =>
                    chosen !== null &&
                    run("meals.meal.edit", {
                      mealId: props.mealId,
                      action: "move",
                      targetDayId: chosen,
                      ...(chosenSlot === recipe.meal.slotName ? {} : { targetSlotName: chosenSlot })
                    })
                  }
                >
                  Move meal
                </Button>
              </div>
            ) : null}
          </div>
        );
      }}
    </Shell>
  );
}

export function EatersScreen(props: { mealId: string; writes: MealsWrites | null }): ReactNodeLike {
  const state = useMeal(props.mealId);
  const [kitchen, setKitchen] = useState<KitchenView | null>(null);
  const [picked, setPicked] = useState<readonly string[] | null>(null);
  const { busy, failed, run } = useRun(props.writes);

  useEffect(() => {
    let live = true;
    readTool<KitchenView>("meals.kitchen.get", {}).then(
      (view) => live && setKitchen(view),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <Shell title="Who eats this" state={state}>
      {(recipe) => {
        const selected = picked ?? recipe.meal.eaters.map((eater) => eater.memberId);
        const toggle = (memberId: string, on: boolean) =>
          setPicked(on ? [...selected, memberId] : selected.filter((id) => id !== memberId));
        return (
          <div className="mls-stack mls-stack--tight">
            <p className="mls-meal__title">{recipe.meal.title ?? recipe.meal.plainText}</p>
            {kitchen === null ? (
              <p className="jds-caption" role="status">
                Loading the household
              </p>
            ) : (
              <div className="mls-form">
                {kitchen.members.map((person) => (
                  <Checkbox
                    key={person.memberId}
                    ariaLabel={person.name}
                    label={person.name}
                    checked={selected.includes(person.memberId)}
                    onChange={(checked: boolean) => toggle(person.memberId, checked)}
                  />
                ))}
              </div>
            )}
            <FailedNote failed={failed} />
            {props.writes !== null && kitchen !== null ? (
              <div className="mls-row">
                <Button
                  disabled={busy || selected.length === 0}
                  onClick={() =>
                    run("meals.meal.edit", {
                      mealId: props.mealId,
                      action: "set_eaters",
                      eaterIds: selected
                    })
                  }
                >
                  Save eaters
                </Button>
              </div>
            ) : null}
          </div>
        );
      }}
    </Shell>
  );
}

export function TextScreen(props: { mealId: string; writes: MealsWrites | null }): ReactNodeLike {
  const state = useMeal(props.mealId);
  const [text, setText] = useState<string | null>(null);
  const { busy, failed, run } = useRun(props.writes);
  const inputId = useId();

  return (
    <Shell title="Text for this meal" state={state}>
      {(recipe) => {
        const value = text ?? recipe.meal.plainText ?? "";
        return (
          <div className="mls-stack mls-stack--tight">
            <div className="mls-form">
              <Field>
                <FormLabel htmlFor={inputId}>Text for this meal</FormLabel>
                <input
                  id={inputId}
                  aria-label="Text for this meal"
                  className="jds-input"
                  maxLength={200}
                  value={value}
                  placeholder="eating out"
                  onChange={(event: { target: { value: string } }) => setText(event.target.value)}
                />
              </Field>
            </div>
            <FailedNote failed={failed} />
            {props.writes !== null ? (
              <div className="mls-row">
                <Button
                  disabled={busy || value.trim() === ""}
                  onClick={() =>
                    run("meals.day.edit", {
                      mealId: props.mealId,
                      action: "set_text",
                      text: value.trim()
                    })
                  }
                >
                  Save text
                </Button>
                {recipe.meal.kind === "text" ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      run("meals.day.edit", { mealId: props.mealId, action: "clear_text" })
                    }
                  >
                    Clear text
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      }}
    </Shell>
  );
}
