import type { MyModuleDto } from "@moss/shared";

import type { SettingsSearchItem } from "./settings-search.js";
import { moduleDescription } from "./settings-types.js";
import { hasImplementedModuleSettings } from "./settings-module-availability.js";
import { visibleConfigurableModules } from "./settings-module-view-model.js";
import { findModuleSettingsEntrySurface, type GeneratedSettingsSurface } from "./settings-ui.js";

// SettingsSearch calls back with an item's id; prefixing module ids lets the settings page tell
// a plain section id (e.g. "profile") apart from a module that needs its own settings surface
// opened inside the Modules section.
export const MODULE_SEARCH_ID_PREFIX = "module:";

/** Search entries for the settings search box (Ben, 2026-09-04): one entry per module the user
    can actually reach from the Modules section, built from each module's own manifest and the
    live module list rather than a hand-kept list, so a new module's settings are searchable the
    moment it ships. */
export function buildModuleSettingsSearchItems(
  modules: readonly MyModuleDto[],
  surfaces: readonly GeneratedSettingsSurface[],
  assistantName: string
): SettingsSearchItem[] {
  return visibleConfigurableModules(modules, (module) =>
    hasImplementedModuleSettings(module, surfaces)
  )
    .filter((module) => module.active || module.required)
    .map((module) => {
      const surface = findModuleSettingsEntrySurface(module.id, surfaces);
      return {
        id: `${MODULE_SEARCH_ID_PREFIX}${module.id}`,
        label: module.name,
        description: surface?.description || moduleDescription(module.id, assistantName),
        group: "Modules",
        keywords: []
      };
    });
}
