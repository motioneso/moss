import { CalendarRepository } from "@moss/calendar";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import type { DataContextRunner } from "@moss/db";

/** Positive approval tests need a real owner-scoped target for server-authored disclosure. */
export function seedCalendarApprovalEvent(
  runner: DataContextRunner,
  actorUserId: string,
  externalId: string
) {
  const scopes = ["https://www.googleapis.com/auth/calendar"];
  const cipher = createConnectorSecretCipher();
  return runner.withDataContext(
    { actorUserId, requestId: "seed-calendar-approval" },
    async (db) => {
      const account = await new ConnectorsRepository().upsertGoogleAccount(db, {
        scopes,
        encryptedSecret: cipher.encryptJson({
          kind: "google-oauth",
          clientId: "cid",
          clientSecret: "csecret",
          accessToken: "atoken",
          refreshToken: "rtoken",
          tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
          grantedScopes: scopes
        })
      });
      return new CalendarRepository().upsertCachedEvent(db, {
        connectorAccountId: account.id,
        externalId,
        title: "Board sync",
        startsAt: new Date("2026-06-28T14:00:00Z"),
        endsAt: new Date("2026-06-28T15:00:00Z")
      });
    }
  );
}
