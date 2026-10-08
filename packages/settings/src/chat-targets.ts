import { assertDataContextDb } from "@moss/db";
import type { RouteChatTargetResolver } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { normalizeCustomThemes } from "./themes-routes.js";

const preferences = new PreferencesRepository();

/** #3065: labels the custom theme a chat-issued DELETE /api/me/themes/:id would remove. */
export const customThemeTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id) return null;
  const theme = normalizeCustomThemes(await preferences.get(db, "themes.custom")).find(
    (entry) => entry.id === id
  );
  return theme ? { label: theme.name, version: JSON.stringify(theme) } : null;
};
