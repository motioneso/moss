// external-modules/meals/src/web/screens/swap.tsx
//
// Three replacement recipes for one meal. A choice shows only once it is written and has passed
// Safety for everyone who eats the meal; Choose puts it on the plan.
import {
  Button,
  EmptyState,
  Indicator,
  SectionHead,
  useCallback,
  useEffect,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { RecipeView, SwapChoiceView } from "../../contracts";
import { readTool } from "../api";
import { navigate } from "../router";
import type { MealsWrites } from "../writes";

const POLL_MS = 3000;

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly recipe: RecipeView };

const waiting = (choice: SwapChoiceView) =>
  choice.status === "pending" || choice.status === "writing";

function useSwap(mealId: string): { state: State; reload: () => void } {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const polling =
    state.kind === "ready" && state.recipe.swapChoices.some((choice) => waiting(choice));

  useEffect(() => {
    let live = true;
    readTool<RecipeView>("meals.meal.get", { mealId }).then(
      (recipe) => live && setState({ kind: "ready", recipe }),
      () =>
        live && setState((previous) => (previous.kind === "ready" ? previous : { kind: "error" }))
    );
    return () => {
      live = false;
    };
  }, [mealId, attempt]);

  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setAttempt((n: number) => n + 1);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling]);

  const reload = useCallback(() => setAttempt((n: number) => n + 1), []);
  return { state, reload };
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

function Choice(props: {
  choice: SwapChoiceView;
  busy: boolean;
  onChoose: (() => void) | null;
}): ReactNodeLike {
  const { choice } = props;
  if (waiting(choice)) {
    return (
      <li className="mls-choice" role="status">
        <Indicator status={choice.status === "writing" ? "ready" : "idle"} live label="Writing" />
      </li>
    );
  }
  if (choice.status === "failed") {
    return (
      <li className="mls-choice">
        <p className="jds-caption">Moss could not write this one.</p>
      </li>
    );
  }
  return (
    <li className="mls-choice">
      <strong className="mls-meal__title">{choice.title}</strong>
      <p className="mls-meal__meta jds-caption">
        <span>{choice.eaters.map((eater) => eater.name).join(", ")}</span>
        {choice.cookMinutes !== null ? <span>{choice.cookMinutes}&nbsp;min</span> : null}
      </p>
      {props.onChoose !== null ? (
        <Button size="sm" disabled={props.busy} onClick={props.onChoose}>
          Choose
        </Button>
      ) : null}
    </li>
  );
}

export function SwapScreen(props: { mealId: string; writes: MealsWrites | null }): ReactNodeLike {
  const { state, reload } = useSwap(props.mealId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (state.kind === "loading") {
    return (
      <div className="mls-stack">
        <BackLink />
        <p className="jds-caption" role="status">
          Loading the options
        </p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mls-stack">
        <BackLink />
        <EmptyState title="Couldn't load this meal">
          <Button variant="secondary" onClick={reload}>
            Try again
          </Button>
        </EmptyState>
      </div>
    );
  }

  const { recipe } = state;
  const { writes } = props;

  async function run(input: Record<string, unknown>): Promise<boolean> {
    if (writes === null || busy) return false;
    setBusy(true);
    setFailed(false);
    const outcome = await writes.invoke("meals.meal.swap", { mealId: props.mealId, ...input });
    setBusy(false);
    if (outcome.kind !== "succeeded") setFailed(true);
    reload();
    return outcome.kind === "succeeded";
  }

  async function choose(choiceId: string) {
    if (await run({ action: "choose", choiceId })) navigate("/");
  }

  return (
    <div className="mls-stack">
      <BackLink />
      <SectionHead
        title={`Swap ${recipe.meal.title ?? "this meal"}`}
        meta={recipe.meal.slotName}
        rule
      />
      {recipe.swapChoices.length > 0 ? (
        <ul className="mls-choices" aria-label="Replacement options">
          {recipe.swapChoices.map((choice) => (
            <Choice
              key={choice.choiceId}
              choice={choice}
              busy={busy}
              onChoose={
                writes !== null && choice.status === "ready" ? () => choose(choice.choiceId) : null
              }
            />
          ))}
        </ul>
      ) : null}
      {failed ? (
        <p className="jds-caption" role="alert">
          That did not go through. Try again.
        </p>
      ) : null}
      {writes !== null && !recipe.swapChoices.some(waiting) ? (
        <div className="mls-row">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => run({ action: "request_choices" })}
          >
            {recipe.swapChoices.length > 0 ? "Find different options" : "Find options"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
