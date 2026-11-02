// external-modules/meals/src/web/screens/recipe-cooking.tsx
//
// The cooking controls on a recipe: servings in halves, Mark cooked with what it took and Undo,
// an offer to log your portion, a star rating per eater and a favourite toggle per eater. Every
// control stays hidden without the host's write handle.
import {
  Button,
  SectionHead,
  randomUuid,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { CookedResult, RecipeView, UndoToken } from "../../contracts";
import type { MealsWrites } from "../writes";

type Toast = {
  readonly text: string;
  readonly undo: UndoToken | null;
  readonly logOffer: CookedResult["logOffer"];
};

const STARS = [1, 2, 3, 4, 5] as const;
const quantity = (value: number | null) =>
  value === null ? "none" : Number.isInteger(value) ? String(value) : value.toFixed(1);

export function CookingPanel(props: {
  recipe: RecipeView;
  writes: MealsWrites | null;
  onRecipe: (recipe: RecipeView) => void;
  onReload: () => void;
}): ReactNodeLike {
  const { recipe, writes } = props;
  const { meal } = recipe;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState(null as Toast | null);
  if (writes === null) return null;

  const cooked = meal.cookedAt !== null;
  const base = recipe.baseServings ?? meal.servings;
  const shown = meal.servings;

  async function run(
    name: Parameters<MealsWrites["invoke"]>[0],
    input: Record<string, unknown>
  ): Promise<unknown | null> {
    setBusy(true);
    setFailed(false);
    const outcome = await writes!.invoke(name, input);
    setBusy(false);
    if (outcome.kind === "succeeded") return outcome.result;
    if (outcome.kind !== "cancelled") setFailed(true);
    return null;
  }

  const setServings = async (servings: number | null) => {
    const result = await run("meals.meal.servings", { mealId: meal.mealId, servings });
    if (result !== null) props.onRecipe(result as RecipeView);
  };

  const rate = async (memberId: string, current: number | null, stars: number) => {
    const result = await run("meals.meal.rate", {
      mealId: meal.mealId,
      ratings: [{ memberId, stars: current === stars ? null : stars }]
    });
    if (result !== null) props.onRecipe(result as RecipeView);
  };

  const favourite = async (memberId: string, on: boolean) => {
    if (recipe.recipeId === null) return;
    const result = await run("meals.favourites.edit", {
      action: on ? "remove" : "add",
      memberId,
      recipeId: recipe.recipeId
    });
    if (result !== null) props.onReload();
  };

  const markCooked = async () => {
    const result = (await run("meals.meal.cooked", { mealId: meal.mealId })) as CookedResult | null;
    if (result === null) return;
    const count = result.pantryChanges.length;
    setToast({
      text:
        count === 0
          ? "Marked cooked. Nothing came out of the Pantry."
          : `Marked cooked. Took ${result.pantryChanges
              .map(
                (c) =>
                  `${c.name} ${quantity(c.before)} to ${quantity(c.after)}${c.unit ? ` ${c.unit}` : ""}`
              )
              .join(", ")}.`,
      undo: result.undo,
      logOffer: result.logOffer
    });
    props.onReload();
  };

  const undo = async (token: UndoToken) => {
    setToast(null);
    const result = await run("meals.undo", { actionId: token.actionId });
    if (result !== null) props.onReload();
  };

  const logPortion = async (offer: NonNullable<Toast["logOffer"]>) => {
    setToast(null);
    await run("meals.log.add", {
      description: offer.description,
      servingNote: offer.servingNote,
      consumedAt: new Date().toISOString(),
      captureKind: "text",
      idempotencyKey: randomUuid()
    });
  };

  return (
    <section className="mls-cook">
      <SectionHead number="03" title="Cooking" rule />
      <div className="mls-cook__row">
        <span className="mls-cook__who">Servings</span>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || cooked || shown <= 0.5}
          aria-label="Fewer servings"
          onClick={() => void setServings(shown - 0.5)}
        >
          -
        </Button>
        <span className="mls-num" role="status">
          {Number.isInteger(shown) ? shown : shown.toFixed(1)}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || cooked || shown >= 24}
          aria-label="More servings"
          onClick={() => void setServings(shown + 0.5)}
        >
          +
        </Button>
        {recipe.servingsOverride !== null ? (
          <Button
            variant="quiet"
            size="sm"
            disabled={busy || cooked}
            onClick={() => void setServings(null)}
          >
            Reset to {Number.isInteger(base) ? base : base.toFixed(1)}
          </Button>
        ) : null}
      </div>

      <div className="mls-cook__row">
        {cooked ? (
          <span className="jds-caption" role="status">
            Cooked
          </span>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => void markCooked()}>
            Mark cooked
          </Button>
        )}
      </div>

      {meal.eaters.map((eater) => (
        <div className="mls-cook__row" key={eater.memberId}>
          <span className="mls-cook__who">{eater.name}</span>
          <div className="mls-stars" role="group" aria-label={`Rating for ${eater.name}`}>
            {STARS.map((stars) => (
              <Button
                key={stars}
                variant={eater.rating === stars ? "primary" : "secondary"}
                size="sm"
                disabled={busy}
                aria-pressed={eater.rating === stars}
                aria-label={`${stars} ${stars === 1 ? "star" : "stars"} for ${eater.name}`}
                onClick={() => void rate(eater.memberId, eater.rating, stars)}
              >
                {stars}
              </Button>
            ))}
          </div>
          <Button
            variant={eater.favourite ? "primary" : "secondary"}
            size="sm"
            disabled={busy || recipe.recipeId === null}
            aria-pressed={eater.favourite}
            onClick={() => void favourite(eater.memberId, eater.favourite)}
          >
            {eater.favourite ? "Favourite" : "Make favourite"}
          </Button>
        </div>
      ))}

      {failed ? (
        <p className="jds-caption" role="alert">
          That did not go through. Try again.
        </p>
      ) : null}

      {toast !== null ? (
        <div className="jds-toast mls-toast" role="status">
          <div className="jds-toast__body">
            <div className="jds-toast__title">{toast.text}</div>
          </div>
          {toast.logOffer !== null ? (
            <Button variant="quiet" size="sm" onClick={() => void logPortion(toast.logOffer!)}>
              Log my portion
            </Button>
          ) : null}
          {toast.undo !== null ? (
            <Button variant="quiet" size="sm" onClick={() => void undo(toast.undo!)}>
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
