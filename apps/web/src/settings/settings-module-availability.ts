import type { MyModuleDto } from "@moss/shared";

import { findModuleSettingsEntrySurface, type GeneratedSettingsSurface } from "./settings-ui.js";

// Module ids with a host-rendered settings destination that predates the manifest-declared
// settings scanner (#1725): Briefings' cadence toggles and Notifications' sensitivity toggles
// are wired by hand, not a contributed settings surface, so the scanner cannot discover them.
export const CONFIG_IDS = new Set(["briefings", "notifications"]);
export const CAT_BY_ID: Record<string, string> = { knowledge: "memory" };

export function contributedSettingsModuleIds(
  surfaces: readonly GeneratedSettingsSurface[]
): ReadonlySet<string> {
  return new Set(surfaces.filter((surface) => surface.hasEntry).map((surface) => surface.moduleId));
}

// #986/#1725/#1759: a module has somewhere to go in Settings if it has a legacy config panel, a
// section it redirects into, host-rendered switches, user-fillable credential slots, or a
// contributed React surface. Shared by the Modules list and the settings search box so both
// agree on which modules are actually reachable.
export function hasImplementedModuleSettings(
  module: MyModuleDto,
  surfaces: readonly GeneratedSettingsSurface[]
): boolean {
  if (CONFIG_IDS.has(module.id)) return true;
  if (CAT_BY_ID[module.id]) return true;
  if (module.hasPreferences) return true;
  if (module.hasUserCredentials) return true;
  return (
    contributedSettingsModuleIds(surfaces).has(module.id) &&
    Boolean(findModuleSettingsEntrySurface(module.id, surfaces))
  );
}
