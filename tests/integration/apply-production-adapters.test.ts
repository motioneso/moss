import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  AuthSessionResolver,
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { CalendarRepository } from "@moss/calendar";
import { buildApplyAccessGate, buildApplyFactsAdapter } from "@moss/chat";
import {
  ConnectorsRepository,
  GoogleOAuthClient,
  GoogleConnectionService,
  createConnectorSecretCipher,
  decryptGoogleConnectionSecret,
  type GoogleCalendarEvent
} from "@moss/connectors";
import { PreferencesRepository } from "@moss/structured-state";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { captureFetch } from "./focus-time-helpers.js";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const MODE_KEY = "calendar.time_block_mode";
const TIER_KEY = "assistant.action_policy.v1.calendar.calendar_writeback";
const NOW = "2026-09-12T15:00:00.000Z";

function lane(userId: string, label: string): AccessContext {
  return { actorUserId: userId, requestId: `request:apply-adapters-${label}` };
}

describe("apply production adapters", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  const connectors = new ConnectorsRepository();
  const prefs = new PreferencesRepository();

  async function seedAccount(
    userId: string,
    scopes: string[],
    tokenExpiry = new Date(Date.now() + 3_600_000).toISOString()
  ): Promise<string> {
    const cipher = createConnectorSecretCipher();
    return dataContext.withDataContext(lane(userId, "seed"), (scopedDb) =>
      connectors
        .upsertGoogleAccount(scopedDb, {
          scopes,
          encryptedSecret: cipher.encryptJson({
            kind: "google-oauth",
            clientId: "cid",
            clientSecret: "csecret",
            accessToken: "atoken",
            refreshToken: "rtoken",
            tokenExpiry,
            grantedScopes: scopes
          })
        })
        .then((account) => account.id)
    );
  }

  async function setPref(userId: string, key: string, value: unknown): Promise<void> {
    await dataContext.withDataContext(lane(userId, "pref"), (scopedDb) =>
      prefs.upsert(scopedDb, key, value)
    );
  }

  async function clearPref(userId: string, key: string): Promise<void> {
    await dataContext.withDataContext(lane(userId, "pref"), (scopedDb) =>
      prefs.delete(scopedDb, key)
    );
  }

  function checkGate(userId = ids.userA) {
    const gate = buildApplyAccessGate({ connectorsRepository: connectors });
    return dataContext.withDataContext(lane(userId, "gate"), (scopedDb) =>
      gate.checkAccess(scopedDb)
    );
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await Promise.allSettled([appDb?.destroy()]);
  });

  it("denies when no writeback policy is stored, even under auto", async () => {
    await seedAccount(ids.userA, [CALENDAR_SCOPE]);
    await clearPref(ids.userA, TIER_KEY);
    await setPref(ids.userA, MODE_KEY, "auto");
    // No provider fakes exist on the gate path: this denial necessarily
    // lands before any facts or provider work.
    await expect(checkGate()).resolves.toMatchObject({ ok: false, reason: /not set/ });
  });

  it("allows the stored tiers under suggest and auto", async () => {
    for (const tier of ["ask_each_time", "trusted_auto"]) {
      await setPref(ids.userA, TIER_KEY, tier);
      for (const mode of ["suggest", "auto"]) {
        await setPref(ids.userA, MODE_KEY, mode);
        await expect(checkGate()).resolves.toEqual({ ok: true });
      }
    }
  });

  it("denies forbidding, unknown and malformed tiers before any provider work", async () => {
    await setPref(ids.userA, MODE_KEY, "auto");
    for (const tier of ["always_confirm", "whatever"]) {
      await setPref(ids.userA, TIER_KEY, tier);
      await expect(checkGate()).resolves.toMatchObject({ ok: false });
    }
    for (const malformed of [42, { tier: "ask_each_time" }, null]) {
      await setPref(ids.userA, TIER_KEY, malformed);
      await expect(checkGate()).resolves.toMatchObject({ ok: false });
    }
    await setPref(ids.userA, TIER_KEY, "ask_each_time");
  });

  it("denies when time blocking is off, even with an allowed tier", async () => {
    await setPref(ids.userA, TIER_KEY, "trusted_auto");
    await setPref(ids.userA, MODE_KEY, "off");
    await expect(checkGate()).resolves.toMatchObject({ ok: false, reason: /off/ });
    await setPref(ids.userA, MODE_KEY, "auto");
  });

  it("denies with no account, no calendar scope, or a revoked grant", async () => {
    const empty = await dataContext.withDataContext(lane(ids.userB, "gate"), (scopedDb) =>
      buildApplyAccessGate({ connectorsRepository: connectors }).checkAccess(scopedDb)
    );
    expect(empty.ok).toBe(false);

    const accountId = await seedAccount(ids.userA, [CALENDAR_SCOPE]);
    await setPref(ids.userA, `connector.${accountId}.feature_grants`, {
      email: true,
      calendar: false
    });
    await expect(checkGate()).resolves.toMatchObject({ ok: false });
    await setPref(ids.userA, `connector.${accountId}.feature_grants`, {
      email: true,
      calendar: true
    });
  });

  describe("staged facts reads", () => {
    // Depth of runner-owned transactions at each network call. Token
    // refresh and every Google read must observe zero.
    let depths: number[];
    let depth = 0;
    let tokenCalls = 0;
    let runner: Pick<DataContextRunner, "withDataContext">;

    function trackedRunner(): Pick<DataContextRunner, "withDataContext"> {
      return {
        withDataContext: (async (
          ctx: AccessContext,
          cb: (db: DataContextDb) => Promise<unknown>
        ) => {
          depth += 1;
          try {
            return await dataContext.withDataContext(ctx, cb);
          } finally {
            depth -= 1;
          }
        }) as Pick<DataContextRunner, "withDataContext">["withDataContext"]
      };
    }

    function buildFacts(
      userId: string,
      listEvents: (input: {
        accessToken: string;
        timeMin: string;
        timeMax: string;
      }) => Promise<GoogleCalendarEvent[]>,
      eventCalls: string[]
    ) {
      const cipher = createConnectorSecretCipher();
      const repository = new ConnectorsRepository();
      const { fetchFn } = captureFetch((url) => {
        if (url.includes("token")) {
          tokenCalls += 1;
          depths.push(depth);
          return { body: { access_token: "fresh-at", expires_in: 3600 } };
        }
        return { body: {} };
      });
      const googleService = new GoogleConnectionService({
        repository,
        cipher,
        oauthClient: new GoogleOAuthClient({ fetchFn })
      });
      const facts = buildApplyFactsAdapter({
        dataContext: runner,
        connectorsRepository: repository,
        googleService,
        googleClient: {
          listCalendarEvents: (async (input: {
            accessToken: string;
            timeMin: string;
            timeMax: string;
          }) => {
            eventCalls.push(`${input.timeMin}..${input.timeMax} @depth=${depth}`);
            depths.push(depth);
            return listEvents(input);
          }) as never
        },
        calendarRepository: new CalendarRepository(),
        now: () => new Date(NOW)
      }).forAccess(lane(userId, "facts"));
      return { facts, repository, cipher };
    }

    function timedEvent(id: string, start: string, end: string): GoogleCalendarEvent {
      return {
        id,
        summary: `Event ${id}`,
        start: { dateTime: start },
        end: { dateTime: end }
      };
    }

    beforeAll(() => {
      depths = [];
      tokenCalls = 0;
      runner = trackedRunner();
    });

    it("reads whole-batch facts at depth zero and persists a forced refresh", async () => {
      await seedAccount(
        ids.userC,
        [CALENDAR_SCOPE],
        new Date(Date.now() - 3_600_000).toISOString()
      );
      const eventCalls: string[] = [];
      const { facts, repository, cipher } = buildFacts(
        ids.userC,
        async () => [
          timedEvent("evt-1", "2026-09-12T16:00:00.000Z", "2026-09-12T16:30:00.000Z"),
          {
            id: "evt-2",
            summary: "Holiday",
            start: { date: "2026-09-12" },
            end: { date: "2026-09-13" }
          },
          {
            id: "evt-3",
            summary: "Cancelled",
            status: "cancelled",
            start: { dateTime: "2026-09-12T16:00:00.000Z" },
            end: { dateTime: "2026-09-12T16:30:00.000Z" }
          },
          { id: "evt-4", summary: "Dateless" },
          timedEvent("evt-5", "2026-09-12T13:00:00.000Z", "2026-09-12T13:30:00.000Z")
        ],
        eventCalls
      );

      const result = await facts.readAvailability({
        start: "2026-09-12T16:00:00.000Z",
        end: "2026-09-12T18:00:00.000Z"
      });

      expect(tokenCalls).toBe(1);
      expect(eventCalls).toHaveLength(1);
      expect(result.complete).toBe(true);
      // Only the current timed event survives: the all-day banner is
      // filtered, the cancelled and dateless ones are skipped, and the past
      // event ended before now.
      expect(result.intervals).toEqual([
        {
          start: "2026-09-12T16:00:00.000Z",
          end: "2026-09-12T16:30:00.000Z",
          title: "Event evt-1",
          accountLabel: expect.any(String),
          eventKey: "evt-1"
        }
      ]);
      expect(depths.length).toBeGreaterThan(0);
      expect(depths.every((entry) => entry === 0)).toBe(true);

      const stored = await dataContext.withDataContext(lane(ids.userC, "verify"), (scopedDb) =>
        repository.getActiveGoogleAccountSecret(scopedDb)
      );
      expect(stored).toBeDefined();
      expect(decryptGoogleConnectionSecret(cipher, stored!.encryptedSecret).accessToken).toBe(
        "fresh-at"
      );
    });

    it("reads per-item facts at depth zero without another refresh", async () => {
      const tokenCallsBefore = tokenCalls;
      const depthsBefore = depths.length;
      const eventCalls: string[] = [];
      const { facts } = buildFacts(
        ids.userC,
        async () => [timedEvent("evt-9", "2026-09-12T16:00:00.000Z", "2026-09-12T16:30:00.000Z")],
        eventCalls
      );

      const result = await facts.readAvailability({
        start: "2026-09-12T16:00:00.000Z",
        end: "2026-09-12T16:30:00.000Z"
      });

      expect(result.complete).toBe(true);
      expect(result.intervals).toHaveLength(1);
      expect(tokenCalls).toBe(tokenCallsBefore);
      expect(depths.slice(depthsBefore).every((entry) => entry === 0)).toBe(true);
    });

    it("recovers from a 401 with one forced refresh at depth zero", async () => {
      await seedAccount(ids.userD, [CALENDAR_SCOPE]);
      let calls = 0;
      const eventCalls: string[] = [];
      const { facts } = buildFacts(
        ids.userD,
        async () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
          }
          return [timedEvent("evt-7", "2026-09-12T17:00:00.000Z", "2026-09-12T17:30:00.000Z")];
        },
        eventCalls
      );
      const tokenCallsBefore = tokenCalls;

      const result = await facts.readAvailability({
        start: "2026-09-12T17:00:00.000Z",
        end: "2026-09-12T18:00:00.000Z"
      });

      expect(calls).toBe(2);
      expect(tokenCalls).toBe(tokenCallsBefore + 1);
      expect(result.complete).toBe(true);
      expect(result.intervals).toHaveLength(1);
      expect(depths.every((entry) => entry === 0)).toBe(true);
    });

    it("fails closed with zero provider calls when the grant is revoked", async () => {
      const accountId = await seedAccount(ids.userB, [CALENDAR_SCOPE]);
      await setPref(ids.userB, `connector.${accountId}.feature_grants`, {
        email: true,
        calendar: false
      });
      const eventCalls: string[] = [];
      const { facts } = buildFacts(
        ids.userB,
        async () => [timedEvent("evt-x", "2026-09-12T16:00:00.000Z", "2026-09-12T16:30:00.000Z")],
        eventCalls
      );

      const result = await facts.readAvailability({
        start: "2026-09-12T16:00:00.000Z",
        end: "2026-09-12T18:00:00.000Z"
      });

      expect(result).toEqual({ intervals: [], complete: false });
      expect(eventCalls).toHaveLength(0);
    });

    it("reports incomplete facts when the live read fails and no cache covers it", async () => {
      await setPref(ids.userB, MODE_KEY, "auto");
      const rows = await dataContext.withDataContext(lane(ids.userB, "pref"), (scopedDb) =>
        connectors.listAccounts(scopedDb)
      );
      for (const row of rows) {
        await setPref(ids.userB, `connector.${row.id}.feature_grants`, {
          email: true,
          calendar: true
        });
      }
      const eventCalls: string[] = [];
      const { facts } = buildFacts(
        ids.userB,
        async () => {
          throw Object.assign(new Error("provider down"), { statusCode: 500 });
        },
        eventCalls
      );

      const result = await facts.readAvailability({
        start: "2026-09-12T16:00:00.000Z",
        end: "2026-09-12T18:00:00.000Z"
      });

      // The live read ran once, then fell back to an empty cache with no
      // sync freshness: incomplete, with no timed facts to trust.
      expect(eventCalls).toHaveLength(1);
      expect(result.complete).toBe(false);
      expect(result.intervals).toEqual([]);
    });

    it("reports truncation honestly when the window overflows the cap", async () => {
      const eventCalls: string[] = [];
      const { facts } = buildFacts(
        ids.userD,
        async () =>
          Array.from({ length: 201 }, (_, index) =>
            timedEvent(
              `evt-cap-${index}`,
              new Date(
                new Date("2026-09-12T16:00:00.000Z").getTime() + index * 60_000
              ).toISOString(),
              new Date(
                new Date("2026-09-12T16:00:00.000Z").getTime() + (index + 1) * 60_000
              ).toISOString()
            )
          ),
        eventCalls
      );

      const result = await facts.readAvailability({
        start: "2026-09-12T16:00:00.000Z",
        end: "2026-09-12T20:00:00.000Z"
      });

      expect(result.complete).toBe(false);
      expect(result.intervals).toHaveLength(200);
    });
  });
});
