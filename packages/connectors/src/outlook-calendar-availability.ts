import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { isValidTimeZone, localDayRange } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { ConnectorsRepository } from "./repository.js";
import { OUTLOOK_BROWSER_PROVIDER } from "./outlook-calendar-config.js";
import { outlookHealthKey, readOutlookHealth } from "./outlook-calendar-jobs.js";
import { featureGrantsPrefKey, isFeatureGranted } from "./feature-grants.js";

const UNAVAILABLE =
  "Outlook calendar availability needs verification. Reconnect or sync in Connections, then retry within the covered dates.";

/** Unknown source coverage is not evidence that a scheduling window is free. */
export async function outlookCalendarAvailabilityIssue(
  db: DataContextDb,
  start: Date,
  end: Date,
  dependencies: {
    readonly repository?: Pick<ConnectorsRepository, "listAccounts">;
    readonly preferences?: Pick<PreferencesRepository, "get">;
  } = {},
  now = new Date()
): Promise<string | null> {
  assertDataContextDb(db);
  const repository = dependencies.repository ?? new ConnectorsRepository();
  const preferences = dependencies.preferences ?? new PreferencesRepository();
  const accounts = (await repository.listAccounts(db)).filter(
    (account) => account.provider_id === OUTLOOK_BROWSER_PROVIDER
  );
  for (const account of accounts) {
    const health = readOutlookHealth(await preferences.get(db, outlookHealthKey(account.id)));
    const completed = Date.parse(health.lastCompleteAt ?? "");
    if (
      account.status !== "active" ||
      health.state !== "current" ||
      !Number.isFinite(completed) ||
      completed > now.getTime() ||
      now.getTime() - completed >= 15 * 60_000 ||
      (health.unconfirmed ?? 0) !== 0 ||
      !isFeatureGranted(await preferences.get(db, featureGrantsPrefKey(account.id)), "calendar") ||
      !health.timeZone ||
      !isValidTimeZone(health.timeZone) ||
      !health.windowStart ||
      !health.windowEnd
    )
      return UNAVAILABLE;
    try {
      const coveredStart = localDayRange(health.windowStart, health.timeZone).start;
      const coveredEnd = localDayRange(health.windowEnd, health.timeZone).start;
      if (
        !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) ||
        end <= start ||
        start < coveredStart ||
        end > coveredEnd
      )
        return UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }
  return null;
}
