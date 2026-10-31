// external-modules/meals/src/web/root.tsx
//
// The Meals page: five area tabs and a settings route behind the header cog. Areas whose tools
// arrive in later slices show an empty state.
import { EmptyState, Segmented, type ReactNodeLike } from "@moss/module-web-sdk";

import { useKitchen } from "./kitchen";
import { navigate, useModulePath } from "./router";
import { HouseholdScreen } from "./screens/household";
import { SettingsScreen } from "./screens/settings";
import { bindWrites } from "./writes";

export type HostActions = { openAssistant: (input: { starterPrompt: string }) => void };

type Area = "plan" | "list" | "pantry" | "household" | "log";

const AREAS: ReadonlyArray<{ value: Area; label: string; path: string; empty: string }> = [
  { value: "plan", label: "Plan", path: "/", empty: "Plan your first week" },
  { value: "list", label: "Shopping list", path: "/list", empty: "Nothing to buy" },
  { value: "pantry", label: "Pantry", path: "/pantry", empty: "The Pantry is empty" },
  { value: "household", label: "Household", path: "/household", empty: "" },
  { value: "log", label: "Log", path: "/log", empty: "Nothing logged" }
];

export function Root(props: Readonly<Record<string, unknown>>): ReactNodeLike {
  const hostActions = props.hostActions as HostActions;
  const writes = bindWrites(props);
  const path = useModulePath();
  const { state, reload } = useKitchen();
  const area = AREAS.find((entry) => entry.path === path);

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
      {area?.value === "household" ? (
        <HouseholdScreen state={state} reload={reload} writes={writes} hostActions={hostActions} />
      ) : (
        <EmptyState title={(area ?? AREAS[0]!).empty} />
      )}
    </div>
  );
}
