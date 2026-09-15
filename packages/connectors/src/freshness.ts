import type { DataContextDb } from "@moss/db";

import type { ConnectorAccountSafeRow, ConnectorsRepository } from "./repository.js";
import { CALENDAR_SCOPE, GMAIL_SCOPE } from "./sync-jobs.js";

/** Pure form of {@link getConnectorSyncAt} for callers that already have the account rows. */
export function pickLatestSyncAt(
  accounts: readonly Pick<ConnectorAccountSafeRow, "scopes" | "last_sync_finished_at">[],
  kind: "email" | "calendar"
): Date | null {
  const matching = accounts.filter((a) => {
    const s = a.scopes;
    return kind === "email"
      ? s.includes(GMAIL_SCOPE) || s.includes("gmail")
      : s.includes(CALENDAR_SCOPE) || s.includes("calendar");
  });
  const times = matching.map((a) => a.last_sync_finished_at).filter((t): t is Date => t !== null);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

export async function getConnectorSyncAt(
  repo: Pick<ConnectorsRepository, "listAccounts">,
  scopedDb: DataContextDb,
  kind: "email" | "calendar"
): Promise<Date | null> {
  let accounts;
  try {
    accounts = await repo.listAccounts(scopedDb);
  } catch {
    return null;
  }
  return pickLatestSyncAt(accounts, kind);
}
