// external-modules/meals/src/web/screens/recipe.tsx
//
// One planned meal as a recipe: who eats it, the ingredients with the original line beside the
// kitchen amount, and the method.
import {
  Button,
  EmptyState,
  Masthead,
  SectionHead,
  useEffect,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { RecipeView } from "../../contracts";
import { readTool } from "../api";
import { navigate } from "../router";
import { failureText } from "./plan-day";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly recipe: RecipeView };

function useRecipe(mealId: string): { state: State; retry: () => void } {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    readTool<RecipeView>("meals.meal.get", { mealId }).then(
      (recipe) => live && setState({ kind: "ready", recipe }),
      () => live && setState({ kind: "error" })
    );
    return () => {
      live = false;
    };
  }, [mealId, attempt]);
  return { state, retry: () => setAttempt((n: number) => n + 1) };
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

export function RecipeScreen(props: { mealId: string }): ReactNodeLike {
  const { state, retry } = useRecipe(props.mealId);
  if (state.kind === "loading") {
    return (
      <div className="mls-stack">
        <BackLink />
        <p className="jds-caption" role="status">
          Loading the recipe
        </p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mls-stack">
        <BackLink />
        <EmptyState title="Couldn't load this recipe">
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        </EmptyState>
      </div>
    );
  }
  const { recipe } = state;
  const { meal } = recipe;
  if (meal.status !== "ready") {
    return (
      <div className="mls-stack">
        <BackLink />
        <EmptyState
          title={
            meal.status === "failed"
              ? "This meal could not be written"
              : "Moss is still writing this meal"
          }
          description={failureText(meal.failureReason) ?? undefined}
        />
      </div>
    );
  }
  const eaters = meal.eaters.map((eater) => eater.name).join(" and ");
  const lede = [
    meal.cookMinutes !== null ? `${meal.cookMinutes} min` : null,
    `For ${eaters}`,
    `Serves ${meal.servings % 1 === 0 ? meal.servings : meal.servings.toFixed(1)}`
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <div className="mls-stack">
      <BackLink />
      <Masthead
        tone="field"
        eyebrow={meal.slotName.toUpperCase()}
        title={meal.title ?? meal.plainText ?? "Meal"}
        lede={lede}
      />
      <div className="mls-grid">
        <section className="mls-stack">
          <SectionHead number="01" title="Ingredients" rule />
          <ul className="mls-ingredients">
            {recipe.ingredients.map((line, index) => (
              <li className="mls-ingredient" key={`${line.name}-${index}`}>
                <span className="mls-num mls-ingredient__amount">{line.display ?? ""}</span>
                <span className="mls-ingredient__name">
                  {line.name}
                  {line.originalText !== line.name && line.originalText !== line.display ? (
                    <span className="jds-caption mls-ingredient__original">
                      As written: {line.originalText}
                    </span>
                  ) : null}
                  {line.checkLabel ? (
                    <span className="jds-caption mls-ingredient__original">Check the label</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="mls-stack">
          <SectionHead number="02" title="Method" rule meta={`${recipe.steps.length} steps`} />
          <ol className="mls-steps">
            {recipe.steps.map((step, index) => (
              <li className="mls-step" key={index}>
                <span className="mls-num jds-caption">{String(index + 1).padStart(2, "0")}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
