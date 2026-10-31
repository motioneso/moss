// external-modules/meals/src/web/screens/settings.tsx
//
// Kitchen settings, reached through the header cog. Without the write handle the values show as
// plain facts.
import {
  Button,
  EmptyState,
  Masthead,
  RadioCardGroup,
  SectionHead,
  Segmented,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

import type { KitchenView, PantryMode, UnitsSystem } from "../../contracts";
import type { KitchenState } from "../kitchen";
import type { MealsWrites } from "../writes";

const UNITS: ReadonlyArray<{ value: UnitsSystem; label: string }> = [
  { value: "us", label: "US" },
  { value: "metric", label: "Metric" }
];

const PANTRY: ReadonlyArray<{ value: PantryMode; label: string; description: string }> = [
  { value: "ignore", label: "Ignore the Pantry", description: "Plan freely and buy everything." },
  { value: "prefer", label: "Prefer what's on hand", description: "Use what you have first." },
  { value: "only", label: "Only what's on hand", description: "A clear-out week. Buy nothing new." }
];

export function SettingsScreen(props: {
  state: KitchenState;
  reload: () => void;
  writes: MealsWrites | null;
}): ReactNodeLike {
  const { state } = props;
  return (
    <div className="mls-stack">
      <Masthead title="Settings" compact />
      {state.kind === "loading" ? (
        <p className="jds-caption" role="status">
          Loading settings
        </p>
      ) : state.kind === "error" ? (
        <EmptyState title="Couldn't load settings">
          <Button variant="secondary" onClick={props.reload}>
            Try again
          </Button>
        </EmptyState>
      ) : (
        <Settings kitchen={state.kitchen} reload={props.reload} writes={props.writes} />
      )}
    </div>
  );
}

function Settings(props: {
  kitchen: KitchenView;
  reload: () => void;
  writes: MealsWrites | null;
}): ReactNodeLike {
  const { kitchen, writes } = props;
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function save(patch: Record<string, unknown>) {
    if (writes === null) return;
    setSaving(true);
    setFailed(false);
    const outcome = await writes.invoke("meals.kitchen.save", patch);
    setSaving(false);
    if (outcome.kind === "succeeded") props.reload();
    else if (outcome.kind !== "cancelled") setFailed(true);
  }

  const units = UNITS.find((option) => option.value === kitchen.unitsSystem)!;
  const pantry = PANTRY.find((option) => option.value === kitchen.defaultPantryMode)!;

  return (
    <div className="mls-stack">
      {failed ? (
        <p className="jds-caption" role="alert">
          Couldn't save that change
        </p>
      ) : null}
      <section className="mls-stack mls-stack--tight">
        <SectionHead title="Units" rule />
        {writes === null ? (
          <p>{units.label}</p>
        ) : (
          <Segmented
            ariaLabel="Units"
            value={kitchen.unitsSystem}
            options={UNITS}
            onChange={(value: UnitsSystem) => void save({ unitsSystem: value })}
          />
        )}
      </section>
      <section className="mls-stack mls-stack--tight">
        <SectionHead title="Pantry mode for new plans" rule />
        {writes === null ? (
          <p>{pantry.label}</p>
        ) : (
          <RadioCardGroup
            name="meals-pantry-mode"
            ariaLabel="Pantry mode for new plans"
            value={kitchen.defaultPantryMode}
            options={PANTRY}
            disabled={saving}
            onChange={(value: PantryMode) => void save({ defaultPantryMode: value })}
          />
        )}
      </section>
    </div>
  );
}
