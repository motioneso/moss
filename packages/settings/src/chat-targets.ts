import { assertDataContextDb } from "@moss/db";
import type { RouteChatTargetResolver } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { readCustomThemeName } from "./themes-routes.js";

const preferences = new PreferencesRepository();

/** #3065: labels the custom theme a chat-issued DELETE /api/me/themes/:id would remove. */
export const customThemeTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id) return null;
  return readCustomThemeName(preferences, db, id);
};
