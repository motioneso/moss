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
import { CalendarRepository, applyAdditionEventId } from "@moss/calendar";
import { buildApplyWriterPort, type ApplyWriterPort } from "@moss/chat";
import {
  ConnectorsRepository,
  GoogleApiClient,
  GoogleConnectionService,
  GoogleOAuthClient,
  createConnectorSecretCipher,
  decryptGoogleConnectionSecret
} from "@moss/connectors";
import { buildCalendarWriteService } from "@moss/chat";
import type { ApplyEventProvenance } from "@moss/shared";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { captureFetch } from "./focus-time-helpers.js";

const PROVENANCE: ApplyEventProvenance = {
  actorUserId: ids.userA,
  planId: "plan-probe",
  blockId: "block-probe",
  planRevision: 2,
  operationId: "op-probe"
};

function provenanceProps(): Record<string, string> {
  return {
    jarvisTool: "applyAddition",
    jarvisActorUserId: PROVENANCE.actorUserId,
    jarvisPlanId: PROVENANCE.planId,
    jarvisBlockId: PROVENANCE.blockId,
    jarvisPlanRevision: String(PROVENANCE.planRevision),
    jarvisOperationId: PROVENANCE.operationId
  };
}

describe("apply writer transaction probe", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  // Depth of runner-owned transactions at each network call. Every token and
  // provider call must observe zero.
  let depths: number[];
  let depth = 0;
  let runner: Pick<DataContextRunner, "withDataContext">;

  function access(): AccessContext {
    return { actorUserId: ids.userA, requestId: "request:writer-probe" };
  }

  function toolCtx() {
    return { actorUserId: ids.userA, requestId: "request:writer-probe", chatSessionId: "s" };
  }

  function trackedRunner(): Pick<DataContextRunner, "withDataContext"> {
    return {
      withDataContext: (async (ctx: AccessContext, cb: (db: DataContextDb) => Promise<unknown>) => {
        depth += 1;
        try {
          return await dataContext.withDataContext(ctx, cb);
        } finally {
          depth -= 1;
        }
      }) as Pick<DataContextRunner, "withDataContext">["withDataContext"]
    };
  }

  async function seedExpiredAccount(): Promise<void> {
    const cipher = createConnectorSecretCipher();
    const repo = new ConnectorsRepository();
    await dataContext.withDataContext(access(), (scopedDb) =>
      repo.upsertGoogleAccount(scopedDb, {
        scopes: ["https://www.googleapis.com/auth/calendar"],
        encryptedSecret: cipher.encryptJson({
          kind: "google-oauth",
          clientId: "cid",
          clientSecret: "csecret",
          accessToken: "stale-at",
          refreshToken: "rtoken",
          tokenExpiry: new Date(Date.now() - 3_600_000).toISOString(),
          grantedScopes: ["https://www.googleapis.com/auth/calendar"]
        })
      })
    );
  }

  function scriptedActiveAccount(
    rows: ReadonlyArray<{ id: string; encryptedSecret: unknown } | undefined>
  ): ConnectorsRepository {
    let calls = 0;
    const real = new ConnectorsRepository();
    return {
      getCalendarWriteScopeState: (scopedDb: DataContextDb) =>
        real.getCalendarWriteScopeState(scopedDb),
      getActiveGoogleAccountSecret: (async () => rows[Math.min(calls++, rows.length - 1)]) as never
    } as unknown as ConnectorsRepository;
  }

  function buildGuardPort(
    insertRepo: ConnectorsRepository,
    lookupRepo: ConnectorsRepository,
    calendarRepository: CalendarRepository
  ): ApplyWriterPort {
    const { fetchFn } = captureFetch((url, init) => {
      if (url.includes("/freeBusy")) {
        return { body: { calendars: { primary: { busy: [] } } } };
      }
      if (url.includes("/events") && (init?.method ?? "GET") === "POST") {
        return { status: 409, body: { error: { code: 409, message: "duplicate" } } };
      }
      return { body: {} };
    });
    const impl = buildCalendarWriteService({
      googleService: new GoogleConnectionService({
        repository: insertRepo,
        cipher: createConnectorSecretCipher(),
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: lookupRepo,
      calendarRepository,
      dataContext: runner
    });
    return buildApplyWriterPort({ writer: impl }).forAccess(access());
  }

  function buildPort(): {
    port: ApplyWriterPort;
    calls: string[];
    bodies: unknown[];
  } {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const { fetchFn } = captureFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url} @depth=${depth}`);
      depths.push(depth);
      if (url.includes("token")) {
        return { body: { access_token: "fresh-at", expires_in: 3600 } };
      }
      if (url.includes("/freeBusy")) {
        return { body: { calendars: { primary: { busy: [] } } } };
      }
      if (url.includes("/events/") && (init?.method ?? "GET") === "GET") {
        return {
          body: {
            id: "evt-probe",
            summary: "Probe block",
            start: { dateTime: "2026-09-12T16:00:00.000Z" },
            end: { dateTime: "2026-09-12T16:30:00.000Z" },
            extendedProperties: { private: provenanceProps() }
          }
        };
      }
      if (url.includes("/events")) {
        const text = typeof init?.body === "string" ? init.body : "{}";
        try {
          bodies.push(JSON.parse(text));
        } catch {
          bodies.push({});
        }
        return { body: { id: "evt-probe", htmlLink: "https://x/evt-probe" } };
      }
      return { body: {} };
    });
    const cipher = createConnectorSecretCipher();
    const repository = new ConnectorsRepository();
    const googleService = new GoogleConnectionService({
      repository,
      cipher,
      oauthClient: new GoogleOAuthClient({ fetchFn })
    });
    const impl = buildCalendarWriteService({
      googleService,
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: repository,
      calendarRepository: new CalendarRepository(),
      dataContext: runner
    });
    return { port: buildApplyWriterPort({ writer: impl }).forAccess(access()), calls, bodies };
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    depths = [];
    runner = trackedRunner();
  });

  afterAll(async () => {
    await Promise.allSettled([appDb?.destroy()]);
  });

  it("runs token refresh and every provider call with no transaction open", async () => {
    await seedExpiredAccount();
    const { port, calls, bodies } = buildPort();

    const created = await port.createAddition({
      ctx: toolCtx(),
      window: {
        start: new Date("2026-09-12T16:00:00.000Z"),
        end: new Date("2026-09-12T16:30:00.000Z"),
        durationMinutes: 30,
        title: "Probe block"
      },
      provenance: PROVENANCE
    });
    expect(created.created).toBe(true);
    // The stub echoes its own id, so the reservation-derived identity is
    // proven on the requested insert body instead.
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { id?: string }).id).toMatch(/^jap/);

    const lookedUp = await port.lookupAddition({ ctx: toolCtx(), eventId: "evt-probe" });
    expect(lookedUp.found).toBe(true);

    // Token refresh, availability, insert and single-event read all ran.
    expect(calls.some((call) => call.includes("token"))).toBe(true);
    expect(calls.some((call) => call.includes("/freeBusy"))).toBe(true);
    expect(calls.some((call) => call.includes("/events"))).toBe(true);
    // None of them observed an open runner transaction.
    expect(depths.length).toBeGreaterThan(0);
    expect(depths.every((entry) => entry === 0)).toBe(true);

    // The refreshed credential persisted for the same account.
    const cipher = createConnectorSecretCipher();
    const stored = await dataContext.withDataContext(access(), (scopedDb) =>
      new ConnectorsRepository().getActiveGoogleAccountSecret(scopedDb)
    );
    expect(stored).toBeDefined();
    expect(decryptGoogleConnectionSecret(cipher, stored!.encryptedSecret).accessToken).toBe(
      "fresh-at"
    );

    // The apply cache mirror agrees with the provider tag.
    const mirrored = await dataContext.withDataContext(access(), (scopedDb) =>
      new CalendarRepository().getByExternalId(scopedDb, {
        connectorAccountId: stored!.id,
        externalId: "evt-probe"
      })
    );
    expect(mirrored).toBeDefined();
    const metadata = mirrored!.external_metadata as Record<string, unknown>;
    expect(metadata["source"]).toBe("applyAddition");
    expect(metadata["provenance"]).toMatchObject({
      actorUserId: PROVENANCE.actorUserId,
      planId: PROVENANCE.planId,
      blockId: PROVENANCE.blockId
    });
  });

  it("records createEvent source for ordinary interactive creation", async () => {
    const bodies: unknown[] = [];
    const { fetchFn } = captureFetch((url, init) => {
      if (url.includes("/freeBusy")) {
        return { body: { calendars: { primary: { busy: [] } } } };
      }
      if (url.includes("/events") && (init?.method ?? "GET") === "POST") {
        const text = typeof init?.body === "string" ? init.body : "{}";
        try {
          bodies.push(JSON.parse(text));
        } catch {
          bodies.push({});
        }
        return { body: { id: "evt-interactive", htmlLink: "https://x/evt-interactive" } };
      }
      return { body: {} };
    });
    const repository = new ConnectorsRepository();
    const impl = buildCalendarWriteService({
      googleService: new GoogleConnectionService({
        repository,
        cipher: createConnectorSecretCipher(),
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: repository,
      calendarRepository: new CalendarRepository()
    });

    const created = await dataContext.withDataContext(access(), (scopedDb) =>
      impl.createEvent(
        scopedDb,
        toolCtx(),
        {
          start: new Date("2026-09-12T16:00:00.000Z"),
          end: new Date("2026-09-12T18:00:00.000Z"),
          durationMinutes: 30,
          title: "Interactive block"
        },
        {}
      )
    );
    expect(created.created).toBe(true);
    expect(created.calendarMirror).toBe("written");
    expect(
      (bodies[0] as { extendedProperties?: { private?: Record<string, string> } })
        ?.extendedProperties?.private?.["jarvisTool"]
    ).toBe("createEvent");

    const active = await dataContext.withDataContext(access(), (scopedDb) =>
      repository.getActiveGoogleAccountSecret(scopedDb)
    );
    const mirrored = await dataContext.withDataContext(access(), (scopedDb) =>
      new CalendarRepository().getByExternalId(scopedDb, {
        connectorAccountId: active!.id,
        externalId: "evt-interactive"
      })
    );
    expect(mirrored).toBeDefined();
    expect((mirrored!.external_metadata as Record<string, unknown>)["source"]).toBe("createEvent");
  });

  it("reports a verified cache miss as not-cached on 409", async () => {
    const missing: ApplyEventProvenance = { ...PROVENANCE, blockId: "block-uncached" };
    const { fetchFn } = captureFetch((url, init) => {
      if (url.includes("token")) {
        return { body: { access_token: "fresh-at", expires_in: 3600 } };
      }
      if (url.includes("/freeBusy")) {
        return { body: { calendars: { primary: { busy: [] } } } };
      }
      if (url.includes("/events") && (init?.method ?? "GET") === "POST") {
        return { status: 409, body: { error: { code: 409, message: "duplicate" } } };
      }
      return { body: {} };
    });
    const repository = new ConnectorsRepository();
    const impl = buildCalendarWriteService({
      googleService: new GoogleConnectionService({
        repository,
        cipher: createConnectorSecretCipher(),
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: repository,
      calendarRepository: new CalendarRepository(),
      dataContext: runner
    });
    const port = buildApplyWriterPort({ writer: impl }).forAccess(access());

    const created = await port.createAddition({
      ctx: toolCtx(),
      window: {
        start: new Date("2026-09-12T16:00:00.000Z"),
        end: new Date("2026-09-12T16:30:00.000Z"),
        durationMinutes: 30,
        title: "Uncached retry"
      },
      provenance: missing
    });
    expect(created.created).toBe(true);
    // The provider owns this id but the same-account cache holds no row:
    // a verified miss, not an unchecked mirror.
    expect(created.calendarMirror).toBe("not-cached");
  });

  it("throws unknown-verifiable when the account is gone at 409 lookup", async () => {
    const row = await dataContext.withDataContext(access(), (scopedDb) =>
      new ConnectorsRepository().getActiveGoogleAccountSecret(scopedDb)
    );
    expect(row).toBeDefined();
    const insertRepo = scriptedActiveAccount([row]);
    const lookupRepo = scriptedActiveAccount([undefined]);
    const port = buildGuardPort(insertRepo, lookupRepo, new CalendarRepository());

    await expect(
      port.createAddition({
        ctx: toolCtx(),
        window: {
          start: new Date("2026-09-12T16:00:00.000Z"),
          end: new Date("2026-09-12T16:30:00.000Z"),
          durationMinutes: 30,
          title: "Missing account retry"
        },
        provenance: { ...PROVENANCE, blockId: "block-guard-missing" }
      })
    ).rejects.toThrow(/changed/);
  });

  it("never queries the cache when the account switched before lookup", async () => {
    const row = await dataContext.withDataContext(access(), (scopedDb) =>
      new ConnectorsRepository().getActiveGoogleAccountSecret(scopedDb)
    );
    expect(row).toBeDefined();
    const insertRepo = scriptedActiveAccount([row]);
    const lookupRepo = scriptedActiveAccount([
      { id: "00000000-0000-4000-8000-000000000099", encryptedSecret: row!.encryptedSecret }
    ]);
    const queried: unknown[] = [];
    const spyingCache = {
      getByExternalId: (async (...args: unknown[]) => {
        queried.push(args);
        return undefined;
      }) as never
    };
    const port = buildGuardPort(insertRepo, lookupRepo, spyingCache as never);

    await expect(
      port.createAddition({
        ctx: toolCtx(),
        window: {
          start: new Date("2026-09-12T16:00:00.000Z"),
          end: new Date("2026-09-12T16:30:00.000Z"),
          durationMinutes: 30,
          title: "Switched account retry"
        },
        provenance: { ...PROVENANCE, blockId: "block-guard-switched" }
      })
    ).rejects.toThrow(/changed/);
    expect(queried).toHaveLength(0);
  });

  it("lets a failed cache lookup propagate as unknown-verifiable", async () => {
    const row = await dataContext.withDataContext(access(), (scopedDb) =>
      new ConnectorsRepository().getActiveGoogleAccountSecret(scopedDb)
    );
    expect(row).toBeDefined();
    const insertRepo = scriptedActiveAccount([row]);
    const lookupRepo = scriptedActiveAccount([row]);
    const failingCache = {
      getByExternalId: (async () => {
        throw new Error("cache down");
      }) as never
    };
    const port = buildGuardPort(insertRepo, lookupRepo, failingCache as never);

    await expect(
      port.createAddition({
        ctx: toolCtx(),
        window: {
          start: new Date("2026-09-12T16:00:00.000Z"),
          end: new Date("2026-09-12T16:30:00.000Z"),
          durationMinutes: 30,
          title: "Cache failure retry"
        },
        provenance: { ...PROVENANCE, blockId: "block-guard-failure" }
      })
    ).rejects.toThrow(/cache down/);
  });

  it("reports a cache hit as written on 409", async () => {
    const hit: ApplyEventProvenance = { ...PROVENANCE, blockId: "block-cached" };
    const eventId = applyAdditionEventId({
      actorUserId: hit.actorUserId,
      planId: hit.planId,
      blockId: hit.blockId,
      planRevision: hit.planRevision,
      operationId: hit.operationId
    });
    const active = await dataContext.withDataContext(access(), (scopedDb) =>
      new ConnectorsRepository().getActiveGoogleAccountSecret(scopedDb)
    );
    await dataContext.withDataContext(access(), (scopedDb) =>
      new CalendarRepository().upsertCachedEvent(scopedDb, {
        connectorAccountId: active!.id,
        externalId: eventId,
        title: "Cached retry",
        startsAt: new Date("2026-09-12T16:00:00.000Z"),
        endsAt: new Date("2026-09-12T16:30:00.000Z")
      })
    );
    const { fetchFn } = captureFetch((url, init) => {
      if (url.includes("token")) {
        return { body: { access_token: "fresh-at", expires_in: 3600 } };
      }
      if (url.includes("/freeBusy")) {
        return { body: { calendars: { primary: { busy: [] } } } };
      }
      if (url.includes("/events") && (init?.method ?? "GET") === "POST") {
        return { status: 409, body: { error: { code: 409, message: "duplicate" } } };
      }
      return { body: {} };
    });
    const repository = new ConnectorsRepository();
    const impl = buildCalendarWriteService({
      googleService: new GoogleConnectionService({
        repository,
        cipher: createConnectorSecretCipher(),
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: repository,
      calendarRepository: new CalendarRepository(),
      dataContext: runner
    });
    const port = buildApplyWriterPort({ writer: impl }).forAccess(access());

    const created = await port.createAddition({
      ctx: toolCtx(),
      window: {
        start: new Date("2026-09-12T16:00:00.000Z"),
        end: new Date("2026-09-12T16:30:00.000Z"),
        durationMinutes: 30,
        title: "Cached retry"
      },
      provenance: hit
    });
    expect(created.created).toBe(true);
    expect(created.calendarMirror).toBe("written");
  });
});
