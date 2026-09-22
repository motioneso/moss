import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import { CalendarRepository, getCurrentMossBlock } from "@moss/calendar";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file.

describe("getCurrentMossBlock through a scoped connection", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
  });
  afterAll(async () => {
    await appDb.destroy();
  });

  async function seedAccount(ownerId: string): Promise<string> {
    const cipher = createConnectorSecretCipher();
    const scopes = ["https://www.googleapis.com/auth/calendar"];
    const account = await dataContext.withDataContext(
      { actorUserId: ownerId, requestId: "seed-account" },
      (scopedDb) =>
        new ConnectorsRepository().upsertGoogleAccount(scopedDb, {
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
        })
    );
    return account.id;
  }

  // Inserts a row the way the create path's mirror does: metadata carries the Moss-created flag.
  async function insertBlock(
    ownerId: string,
    accountId: string,
    externalId: string,
    title: string,
    startsAt = new Date("2026-09-21T09:00:00.000Z"),
    endsAt = new Date("2026-09-21T11:00:00.000Z")
  ) {
    return dataContext.withDataContext(
      { actorUserId: ownerId, requestId: "seed-event" },
      (scopedDb) =>
        new CalendarRepository().upsertCachedEvent(scopedDb, {
          connectorAccountId: accountId,
          externalId,
          title,
          startsAt,
          endsAt,
          externalMetadata: { jarvisCreated: true, source: "createEvent" }
        })
    );
  }

  const now = new Date("2026-09-21T10:00:00.000Z");

  it("returns the caller's own block and never another person's (fails if the read bypasses the scoped connection)", async () => {
    const accountA = await seedAccount(ids.userA);
    const accountB = await seedAccount(ids.userB);
    await insertBlock(ids.userA, accountA, "focus-evt-a", "A's block");
    await insertBlock(ids.userB, accountB, "focus-evt-b", "B's block");

    const seenByA = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "read-a" },
      (scopedDb) => getCurrentMossBlock(scopedDb, now)
    );
    const seenByB = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "read-b" },
      (scopedDb) => getCurrentMossBlock(scopedDb, now)
    );

    expect(seenByA?.title).toBe("A's block");
    expect(seenByB?.title).toBe("B's block");
  });

  it("never returns a block someone else shared with the caller (fails without the owner filter)", async () => {
    const accountB = await seedAccount(ids.userB);
    const shared = await insertBlock(
      ids.userB,
      accountB,
      "focus-evt-b-shared",
      "B's shared block",
      new Date("2026-09-21T13:00:00.000Z"),
      new Date("2026-09-21T14:00:00.000Z")
    );
    await dataContext.withDataContext({ actorUserId: ids.userB, requestId: "share" }, (scopedDb) =>
      scopedDb.db
        .insertInto("app.shares")
        .values({
          id: randomUUID(),
          resource_type: "calendar_event",
          resource_id: shared.id,
          owner_user_id: ids.userB,
          grantee_user_id: ids.userA,
          level: "view",
          created_at: new Date(),
          updated_at: new Date()
        })
        .execute()
    );
    const at = new Date("2026-09-21T13:30:00.000Z");

    const [visibleToA, seenByA, seenByB] = await Promise.all([
      dataContext.withDataContext({ actorUserId: ids.userA, requestId: "list-a" }, (scopedDb) =>
        new CalendarRepository().listVisible(scopedDb, { endsAfter: at })
      ),
      dataContext.withDataContext({ actorUserId: ids.userA, requestId: "shared-a" }, (scopedDb) =>
        getCurrentMossBlock(scopedDb, at)
      ),
      dataContext.withDataContext({ actorUserId: ids.userB, requestId: "shared-b" }, (scopedDb) =>
        getCurrentMossBlock(scopedDb, at)
      )
    ]);

    // The share really is visible to A, so the null below comes from the owner filter.
    expect(visibleToA.map((event) => event.id)).toContain(shared.id);
    expect(seenByA).toBeNull();
    expect(seenByB?.title).toBe("B's shared block");
  });

  it("returns null when the caller has no block at that moment", async () => {
    const seen = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "read-none" },
      (scopedDb) => getCurrentMossBlock(scopedDb, new Date("2026-09-21T15:00:00.000Z"))
    );
    expect(seen).toBeNull();
  });
});
