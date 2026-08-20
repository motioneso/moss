// external-modules/food/src/domain/targets.ts
//
// #1737 item 4: the day's targets, declared as integer module preferences (#1757) and resolved by
// the host before every invocation. Food does not build a settings pane — the host draws these
// from the manifest, and this file only turns the resolved values into a shape the day view can use.
//
// Every target is optional and "unset" is a supported end state, not a target of zero. The host
// hands back `null` for a target the user has never set or has deliberately cleared, and nothing
// here substitutes a number for it: with no target the day view shows a plain figure and no
// progress at all. An empty bar, a 0%, or a NaN is worse than a plain number.
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

export const TARGET_PREFERENCE_KEYS = {
  caloriesKcal: "calorieTarget",
  proteinG: "proteinTarget",
  netCarbsG: "carbTarget",
  fatG: "fatTarget"
} as const;

export interface DailyTargets {
  readonly caloriesKcal: number | null;
  readonly proteinG: number | null;
  readonly netCarbsG: number | null;
  readonly fatG: number | null;
}

export const NO_TARGETS: DailyTargets = {
  caloriesKcal: null,
  proteinG: null,
  netCarbsG: null,
  fatG: null
};

/**
 * Read the four targets off a resolved preference set.
 *
 * Anything that is not a positive whole number reads as unset — including zero. A target of zero
 * calories is not a goal anyone holds, and treating it as one would put the day permanently over
 * target; a resolver or manifest change that produced one must degrade to "no target" rather than
 * to a number the user never chose.
 */
export function resolveDailyTargets(ctx: ModuleWorkerContext): DailyTargets {
  const read = (key: string): number | null => {
    const value = ctx.preferences[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    caloriesKcal: read(TARGET_PREFERENCE_KEYS.caloriesKcal),
    proteinG: read(TARGET_PREFERENCE_KEYS.proteinG),
    netCarbsG: read(TARGET_PREFERENCE_KEYS.netCarbsG),
    fatG: read(TARGET_PREFERENCE_KEYS.fatG)
  };
}
