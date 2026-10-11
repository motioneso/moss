import type { DataContextRunner } from "@moss/db";
import { LOCALE_PREFERENCE_KEY } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

/** Save the person's locale timezone, or clear it with null so the shared default applies. */
export async function saveLocaleTimeZone(
  dataContext: DataContextRunner,
  actorUserId: string,
  timeZone: string | null
): Promise<void> {
  const preferences = new PreferencesRepository();
  await dataContext.withDataContext({ actorUserId, requestId: "req:test-locale" }, (scopedDb) =>
    timeZone === null
      ? preferences.delete(scopedDb, LOCALE_PREFERENCE_KEY)
      : preferences.upsert(scopedDb, LOCALE_PREFERENCE_KEY, { timezone: timeZone })
  );
}
