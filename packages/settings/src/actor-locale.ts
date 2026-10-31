import type { DataContextDb } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";
import { LOCALE_PREFERENCE_KEY, resolveEffectiveLocale } from "@moss/shared";

/** Public owner-scoped locale read for host composition (including module page actions). */
export async function readActorLocale(scope: DataContextDb) {
  return resolveEffectiveLocale(
    await new PreferencesRepository().get(scope, LOCALE_PREFERENCE_KEY)
  );
}
