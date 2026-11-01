// external-modules/meals/src/web/root.tsx
//
// The Meals page: five area tabs and a settings route behind the header cog. Areas whose tools
// arrive in later slices (Log) show an empty state.
import { EmptyState, Segmented, type ReactNodeLike } from "@moss/module-web-sdk";

import { useKitchen } from "./kitchen";
import { useShoppingList } from "./list";
import { usePantry } from "./pantry";
import { usePlan } from "./plan";
import { navigate, useModulePath } from "./router";
import { HouseholdScreen } from "./screens/household";
import { ListScreen } from "./screens/list";
import { PantryScreen } from "./screens/pantry";
import { PlanScreen } from "./screens/plan";
import { RecipeScreen } from "./screens/recipe";
import { SettingsScreen } from "./screens/settings";
import { bindWrites } from "./writes";

export type HostActions = { openAssistant: (input: { starterPrompt: string }) => void };

type Area = "plan" | "list" | "pantry" | "household" | "log";

const AREAS: ReadonlyArray<{ value: Area; label: string; path: string; empty: string }> = [
  { value: "plan", label: "Plan", path: "/", empty: "Plan your first week" },
  { value: "list", label: "Shopping list", path: "/list", empty: "" },
  { value: "pantry", label: "Pantry", path: "/pantry", empty: "" },
  { value: "household", label: "Household", path: "/household", empty: "" },
  { value: "log", label: "Log", path: "/log", empty: "Nothing logged" }
];

function PlanArea(props: {
  writes: ReturnType<typeof bindWrites>;
  hostActions: HostActions;
}): ReactNodeLike {
  const { state, reload } = usePlan();
  return (
    <PlanScreen
      state={state}
      reload={reload}
      writes={props.writes}
      hostActions={props.hostActions}
    />
  );
}

function PantryArea(props: {
  writes: ReturnType<typeof bindWrites>;
  hostActions: HostActions;
  staplesOpen: boolean;
}): ReactNodeLike {
  const { state, reload, apply } = usePantry();
  return (
    <PantryScreen
      state={state}
      reload={reload}
      apply={apply}
      staplesOpen={props.staplesOpen}
      writes={props.writes}
      hostActions={props.hostActions}
    />
  );
}

function ListArea(props: {
  writes: ReturnType<typeof bindWrites>;
  hostActions: HostActions;
}): ReactNodeLike {
  const { state, reload, apply } = useShoppingList();
  const { state: planState } = usePlan();
  return (
    <ListScreen
      state={state}
      reload={reload}
      apply={apply}
      plan={planState.kind === "ready" ? planState.plan : null}
      writes={props.writes}
      hostActions={props.hostActions}
    />
  );
}

export function Root(props: Readonly<Record<string, unknown>>): ReactNodeLike {
  const hostActions = props.hostActions as HostActions;
  const writes = bindWrites(props);
  const path = useModulePath();
  const { state, reload } = useKitchen();
  const recipeId = path.startsWith("/recipe/") ? path.slice("/recipe/".length) : null;
  const staplesOpen = path === "/pantry/staples";
  const area =
    recipeId !== null
      ? AREAS[0]
      : AREAS.find((entry) => entry.path === (staplesOpen ? "/pantry" : path));

  if (path === "/settings") {
    return (
      <div className="mls-page">
        <SettingsScreen state={state} reload={reload} writes={writes} />
      </div>
    );
  }

  return (
    <div className="mls-page">
      <div className="mls-tabs">
        <Segmented
          ariaLabel="Meals areas"
          value={(area ?? AREAS[0]!).value}
          options={AREAS.map(({ value, label }) => ({ value, label }))}
          onChange={(value: Area) => navigate(AREAS.find((entry) => entry.value === value)!.path)}
        />
      </div>
      {recipeId !== null ? (
        <RecipeScreen mealId={recipeId} />
      ) : area?.value === "household" ? (
        <HouseholdScreen state={state} reload={reload} writes={writes} hostActions={hostActions} />
      ) : (area ?? AREAS[0]!).value === "plan" ? (
        <PlanArea writes={writes} hostActions={hostActions} />
      ) : area?.value === "list" ? (
        <ListArea writes={writes} hostActions={hostActions} />
      ) : area?.value === "pantry" ? (
        <PantryArea writes={writes} hostActions={hostActions} staplesOpen={staplesOpen} />
      ) : (
        <EmptyState title={(area ?? AREAS[0]!).empty} />
      )}
    </div>
  );
}
