import type { MyModuleDto } from "@moss/shared";

import type { SettingsSearchItem } from "./settings-search.js";
import { moduleDescription } from "./settings-types.js";
import { hasImplementedModuleSettings } from "./settings-module-availability.js";
import { findModuleSettingsEntrySurface, type GeneratedSettingsSurface } from "./settings-ui.js";

// SettingsSearch calls back with an item's id; prefixing module ids lets the settings page tell
// a plain section id (e.g. "profile") apart from a module that needs its own settings surface
// opened inside the Modules section.
export const MODULE_SEARCH_ID_PREFIX = "module:";

/** Search entries for the settings search box (Ben, 2026-09-04): one entry per module the user
    can actually reach from the Modules section, built from each module's own manifest and the
    live module list rather than a hand-kept list, so a new module's settings are searchable the
    moment it ships.

    A module is only included when it has a real settings destination
    (`hasImplementedModuleSettings`) — never just because it happens to be installed and active,
    which is the right rule for the Modules list but not for search: a result here has to be
    somewhere the user can actually land. Its keywords cover every settings page the module
    declares, plus the label and help text of every individual setting and credential slot it
    declares (`settingKeywordsById`), so searching for one setting's own name (e.g. "Plaid") finds
    the module even though that word never appears in the module's name or its one-line
    description. */
export function buildModuleSettingsSearchItems(
  modules: readonly MyModuleDto[],
  surfaces: readonly GeneratedSettingsSurface[],
  assistantName: string,
  settingKeywordsById: Readonly<Record<string, readonly string[]>> = {}
): SettingsSearchItem[] {
  return modules
    .filter((module) => module.active || module.required)
    .filter((module) => hasImplementedModuleSettings(module, surfaces))
    .map((module) => {
      const moduleSurfaces = surfaces.filter((surface) => surface.moduleId === module.id);
      const entrySurface = findModuleSettingsEntrySurface(module.id, surfaces);
      const keywords = [
        ...moduleSurfaces.flatMap((surface) => [surface.label, surface.description]),
        ...(settingKeywordsById[module.id] ?? []),
        ...(module.settingKeywords ?? [])
      ].filter((keyword): keyword is string => Boolean(keyword));
      return {
        id: `${MODULE_SEARCH_ID_PREFIX}${module.id}`,
        label: module.name,
        description: entrySurface?.description || moduleDescription(module.id, assistantName),
        group: "Modules",
        keywords
      };
    });
}
