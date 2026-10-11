import type { DataContextDb, PreferencesPort } from "@moss/db";
import {
  LOCALE_PREFERENCE_KEY,
  resolveEffectiveLocale,
  type LocaleSettingsDto
} from "@moss/shared";

/** The person's effective locale; the default locale when no preferences port is wired. */
export async function readPersonLocale(
  scopedDb: DataContextDb,
  preferences: Pick<PreferencesPort, "get"> | undefined
): Promise<LocaleSettingsDto> {
  return resolveEffectiveLocale(
    preferences ? await preferences.get(scopedDb, LOCALE_PREFERENCE_KEY) : undefined
  );
}
