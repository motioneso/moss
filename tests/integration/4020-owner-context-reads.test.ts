import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import { CalendarRepository } from "@moss/calendar";
import { PeopleRepository, findPeopleByNames } from "@moss/people";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file.

describe("owner context reads", () => {
  let appDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  const as = (actorUserId: string) => ({ actorUserId, requestId: `4020-${randomUUID()}` });

  beforeAll(async () => {
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    runner = new DataContextRunner(appDb);
  });
  afterAll(async () => {
    await appDb.destroy();
  });

  async function seedAccount(ownerId: string): Promise<string> {
    const cipher = createConnectorSecretCipher();
    const scopes = ["https://www.googleapis.com/auth/calendar"];
    const account = await runner.withDataContext(as(ownerId), (db) =>
      new ConnectorsRepository().upsertGoogleAccount(db, {
        scopes,
        encryptedSecret: cipher.encryptJson({
          kind: "google-oauth",
          clientId: "c",
          clientSecret: "s",
          accessToken: "a",
          refreshToken: "r",
          tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
          grantedScopes: scopes
        })
      })
    );
    return account.id;
  }

  async function addEvent(
    owner: string,
    account: string,
    title: string,
    startsAt: string,
    endsAt: string,
    attendeeNames: string[] = []
  ) {
    await runner.withDataContext(as(owner), (db) =>
      new CalendarRepository().upsertCachedEvent(db, {
        connectorAccountId: account,
        externalId: `${title}-${randomUUID()}`,
        title,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        externalMetadata: { attendeeNames }
      })
    );
  }

  const dayWindow = (d: string) => ({
    start: new Date(`2026-11-${d}T10:00:00Z`),
    end: new Date(`2026-11-${d}T11:00:00Z`),
    toleranceMinutes: 10
  });

  describe("calendar listEventsOverlapping", () => {
    const window = {
      start: new Date("2026-11-02T10:00:00Z"),
      end: new Date("2026-11-02T11:00:00Z"),
      toleranceMinutes: 10
    };

    it("returns the owner's event with names, never a visible event of a second user", async () => {
      const a = await seedAccount(ids.userA);
      const b = await seedAccount(ids.userB);
      await addEvent(ids.userA, a, "Mine", "2026-11-02T10:00:00Z", "2026-11-02T11:00:00Z", [
        "Ann Lee"
      ]);
      const theirs = await runner.withDataContext(as(ids.userB), (db) =>
        new CalendarRepository().upsertCachedEvent(db, {
          connectorAccountId: b,
          externalId: `theirs-${randomUUID()}`,
          title: "Theirs",
          startsAt: new Date("2026-11-02T10:00:00Z"),
          endsAt: new Date("2026-11-02T11:00:00Z"),
          externalMetadata: { attendeeNames: ["Spy"] }
        })
      );
      // B shares the event with A, so row policy lets A read it. Only the owner filter hides it.
      await runner.withDataContext(as(ids.userB), (db) =>
        db.db
          .insertInto("app.shares")
          .values({
            id: randomUUID(),
            resource_type: "calendar_event",
            resource_id: theirs.id,
            owner_user_id: ids.userB,
            grantee_user_id: ids.userA,
            level: "view",
            created_at: new Date(),
            updated_at: new Date()
          })
          .execute()
      );
      const visible = await runner.withDataContext(as(ids.userA), (db) =>
        new CalendarRepository().listVisible(db)
      );
      expect(visible.map((e) => e.title)).toContain("Theirs");
      const out = await runner.withDataContext(as(ids.userA), (db) =>
        new CalendarRepository().listEventsOverlapping(db, window)
      );
      expect(out.map((e) => e.title)).toEqual(["Mine"]);
      expect(out[0]!.attendeeNames).toEqual(["Ann Lee"]);
    });

    it("never returns an email even if one sits in stored metadata", async () => {
      const a = await seedAccount(ids.userA);
      await addEvent(ids.userA, a, "Leaky", "2026-11-02T10:00:00Z", "2026-11-02T11:00:00Z", [
        "x@y.test",
        "Fine Name"
      ]);
      const out = await runner.withDataContext(as(ids.userA), (db) =>
        new CalendarRepository().listEventsOverlapping(db, window)
      );
      expect(out.find((e) => e.title === "Leaky")!.attendeeNames).toEqual(["Fine Name"]);
    });

    it("applies the tolerance window exactly", async () => {
      const a = await seedAccount(ids.userA);
      // Window 10:00-11:00, tolerance 10 min. Inside: ends 09:55. Outside: ends 09:45, starts 11:15.
      await addEvent(ids.userA, a, "InTolBefore", "2026-11-03T09:30:00Z", "2026-11-03T09:55:00Z");
      await addEvent(ids.userA, a, "InTolAfter", "2026-11-03T11:05:00Z", "2026-11-03T11:30:00Z");
      await addEvent(ids.userA, a, "OutBefore", "2026-11-03T09:00:00Z", "2026-11-03T09:45:00Z");
      await addEvent(ids.userA, a, "OutAfter", "2026-11-03T11:15:00Z", "2026-11-03T12:00:00Z");
      const out = await runner.withDataContext(as(ids.userA), (db) =>
        new CalendarRepository().listEventsOverlapping(db, dayWindow("03"))
      );
      const titles = out.map((e) => e.title);
      expect(titles).toContain("InTolBefore");
      expect(titles).toContain("InTolAfter");
      expect(titles).not.toContain("OutBefore");
      expect(titles).not.toContain("OutAfter");
    });

    it("orders by overlap and caps at three", async () => {
      const a = await seedAccount(ids.userA);
      await addEvent(ids.userA, a, "Full", "2026-11-04T10:00:00Z", "2026-11-04T11:00:00Z");
      await addEvent(ids.userA, a, "Half", "2026-11-04T10:00:00Z", "2026-11-04T10:30:00Z");
      await addEvent(ids.userA, a, "Quarter", "2026-11-04T10:45:00Z", "2026-11-04T11:30:00Z");
      await addEvent(ids.userA, a, "Tiny", "2026-11-04T10:55:00Z", "2026-11-04T11:20:00Z");
      const out = await runner.withDataContext(as(ids.userA), (db) =>
        new CalendarRepository().listEventsOverlapping(db, dayWindow("04"))
      );
      expect(out.map((e) => e.title).slice(0, 3)).toEqual(["Full", "Half", "Quarter"]);
      expect(out.length).toBeLessThanOrEqual(3);
    });
  });

  describe("people findPeopleByNames", () => {
    it("matches exact names and aliases case-insensitively, nothing fuzzy", async () => {
      const repo = new PeopleRepository();
      await runner.withDataContext(as(ids.userA), async (db) => {
        const ann = await repo.upsertPersonProjection(db, {
          personId: randomUUID(),
          ownerUserId: ids.userA,
          displayName: "Ann Lee",
          relationshipSummary: "Design lead",
          contextSummary: `${"long ".repeat(80)}\nsecond line`
        });
        await repo.upsertIdentity(db, {
          ownerUserId: ids.userA,
          personId: ann.id,
          identityKind: "alias",
          sourceKind: "manual",
          normalizedValue: "Annie",
          displayValue: "Annie",
          sourceRef: null,
          sourceRefHash: null,
          status: "active"
        });
        await repo.upsertPersonProjection(db, {
          personId: randomUUID(),
          ownerUserId: ids.userA,
          displayName: "Annabel Stone"
        });
      });
      const out = await runner.withDataContext(as(ids.userA), (db) =>
        findPeopleByNames(db, ids.userA, ["ann lee", "ANNIE", "Ann", "Nobody"])
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe("Ann Lee");
      expect(out[0]!.role).toBe("Design lead");
      expect(out[0]!.note!.length).toBeLessThanOrEqual(200);
      expect(out[0]!.note).not.toContain("second line");
      const none = await runner.withDataContext(as(ids.userA), (db) =>
        findPeopleByNames(db, ids.userA, ["Ann"])
      );
      expect(none).toEqual([]);
    });

    it("does not return another user's person", async () => {
      await runner.withDataContext(as(ids.userB), (db) =>
        new PeopleRepository().upsertPersonProjection(db, {
          personId: randomUUID(),
          ownerUserId: ids.userB,
          displayName: "Bea Private"
        })
      );
      const out = await runner.withDataContext(as(ids.userA), (db) =>
        findPeopleByNames(db, ids.userA, ["Bea Private"])
      );
      expect(out).toEqual([]);
    });
  });
});
