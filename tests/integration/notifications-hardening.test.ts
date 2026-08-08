// Split #1328: verification-bullet tests for spec 2026-06-19-notifications-actor-scoped-hardening,
// moved verbatim out of notifications.test.ts when that file grew past the 1000-line cap. Seed
// data and actor contexts shared across the notifications integration suite live in
// ./notifications-harness.ts. This file builds its own trimmed harness — no workerDb/
// workerDataContext, no registerNotificationsRoutes probe, no admin/userB context — since none
// of these tests need them.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  DataContextRunner,
  createDatabase,
  dataContextBrand,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  NotificationsRepository,
  type CreateNotificationInput,
  type NotificationWithReadState,
  type QuietHoursPort,
  type QuietHoursSettings,
  computeDeferredUntil,
  resolveTimezone
} from "@moss/notifications";
import { notificationDtoSchema, type NotificationMetadata } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { notificationIds, seedNotificationData, userAContext } from "./notifications-harness.js";

const { Client } = pg;

// An id guaranteed not to exist as a notification row — used to assert the
// absent-vs-denied 404 indistinguishability (Verification bullet 6).
const nonexistentNotificationId = randomUUID();

describe("Notifications module M5 — actor-scoped hardening", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: NotificationsRepository;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await seedNotificationData();

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
    repository = new NotificationsRepository();
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({
      appDb,
      boss,
      logger: false
    });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("CreateNotificationInput no longer exposes recipientUserId or actorUserId (Verification 1)", () => {
    // Compile-time guard: passing either override must fail typecheck. The @ts-expect-error
    // comments will become UNUSED (and trip the lint rule) if a future change re-adds the
    // fields — surfacing the regression at compile time.
    //
    // @ts-expect-error — recipientUserId was removed in spec Decision 2
    const badRecipient: CreateNotificationInput = { title: "t", recipientUserId: ids.userA };
    // @ts-expect-error — actorUserId was removed in spec Decision 2
    const badActor: CreateNotificationInput = { title: "t", actorUserId: ids.userA };
    // @ts-expect-error — moduleId is required for every new notification
    const missingModule: CreateNotificationInput = { title: "t" };
    expect(badRecipient).toBeDefined();
    expect(badActor).toBeDefined();
    expect(missingModule).toBeDefined();

    // Runtime regression: create(scopedDb, { title, metadata }) yields a row whose
    // actor_user_id === recipient_user_id === active actor.
    // (This is asserted explicitly in notifications.test.ts's "creates private notifications
    // for the active actor by default" test; the spec calls out that this is the regression
    // guard.)
  });

  it("create() applies the input-side metadata projection (Verification 3a)", async () => {
    const created = (await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, {
        moduleId: "briefings",
        title: "Projection at input",
        metadata: {
          // dropped: nested object, array, bad key names
          nested: { drop: "me" },
          list: [1, 2],
          "has space": "dropped",
          // truncated: 500 → 256
          longValue: "z".repeat(500),
          // kept
          source: "input-projection",
          count: 9,
          ok: true,
          nullable: null
        }
      })
    ))!;
    expect(created.metadata).toEqual({
      source: "input-projection",
      count: 9,
      ok: true,
      nullable: null,
      longValue: "z".repeat(256)
    });
    // The stored column already reflects the bounded shape — no nested / oversized / bad keys.
    expect(JSON.stringify(created.metadata)).not.toContain("nested");
    expect(JSON.stringify(created.metadata)).not.toContain("has space");
  });

  it("serializeNotification projects raw DB metadata through GET /api/notifications (Verification 3b/REST)", async () => {
    const created = (await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, {
        moduleId: "briefings",
        title: "DTO module id probe",
        metadata: { source: "dto-module-id" }
      })
    ))!;
    const response = await server.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      notifications: Array<{
        id: string;
        moduleId: string | null;
        metadata: NotificationMetadata;
      }>;
    }>();
    const probe = body.notifications.find((n) => n.id === notificationIds.aProjectionProbe);
    const createdDto = body.notifications.find((n) => n.id === created.id);
    expect(probe).toBeDefined();
    expect(createdDto?.moduleId).toBe("briefings");
    const metadata = probe!.metadata;
    // No nested objects / arrays survived the projection.
    for (const value of Object.values(metadata)) {
      if (value === null) continue;
      expect(typeof value !== "object").toBe(true);
    }
    // No bad key names survived.
    expect(Object.keys(metadata)).not.toContain("has space");
    expect(Object.keys(metadata)).not.toContain("123numeric");
    expect(Object.keys(metadata)).not.toContain("nested");
    expect(Object.keys(metadata)).not.toContain("list");
    // At most 16 keys total.
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(16);
    // Good primitives kept verbatim (the 2-char keys sort before extraXX in jsonb storage,
    // so they survive the 16-key cap deterministically).
    expect(metadata.aa).toBe("projection-probe");
    expect(metadata.bb).toBe(3);
    expect(metadata.cc).toBe(true);
    // dd is null in the column; the projection keeps it, but Fastify's response serializer
    // drops null values inside metadata.additionalProperties.anyOf (a known fast-json-stringify
    // quirk). The security-relevant invariant — no nested / oversized / bad-key content
    // reaches clients — is pinned by the assertions above. The nullable-preserved assertion
    // lives in the unit suite (notifications-metadata-projection.test.ts).
    expect(metadata.dd === null || metadata.dd === undefined).toBe(true);
    // ee was a 500-char string in the column; the projection truncated it to 256 chars.
    expect(typeof metadata.ee).toBe("string");
    if (typeof metadata.ee === "string") {
      expect(metadata.ee.length).toBeLessThanOrEqual(256);
    }
    // 16-key cap: only the first 11 extraXX keys survived alongside the 5 good keys.
    expect(Object.keys(metadata).filter((k) => k.startsWith("extra")).length).toBeLessThanOrEqual(
      11
    );
    // Total payload within the bound.
    expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBeLessThanOrEqual(4096);
  });

  it("serializeNotification projects raw DB metadata through the assistant tool path (Verification 3b/tool)", async () => {
    // The notifications.listVisible tool imports serializeNotification directly — the same
    // chokepoint. We exercise it through the repository + serializer stack the tool uses.
    const result = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listVisible(scopedDb)
    );
    const probe = result.notifications.find((n) => n.id === notificationIds.aProjectionProbe);
    expect(probe).toBeDefined();
    // Re-run the serializer the same way the tool does, to assert the chokepoint.
    const { serializeNotification } = await import("@moss/notifications");
    const dto = serializeNotification(probe!);
    for (const value of Object.values(dto.metadata)) {
      if (value === null) continue;
      expect(typeof value !== "object").toBe(true);
    }
    expect(Object.keys(dto.metadata)).not.toContain("nested");
    expect(Object.keys(dto.metadata)).not.toContain("list");
    expect(Object.keys(dto.metadata)).not.toContain("has space");
    expect(Object.keys(dto.metadata).length).toBeLessThanOrEqual(16);
    expect(dto.metadata.aa).toBe("projection-probe");
    expect(dto.metadata.bb).toBe(3);
    expect(dto.metadata.cc).toBe(true);
    // The direct serializer call (no Fastify in the way) preserves null — proving the
    // chokepoint itself is correct, separate from Fastify's null-dropping in the REST path.
    expect(dto.metadata.dd).toBeNull();
    expect(typeof dto.metadata.ee).toBe("string");
    expect((dto.metadata.ee as string).length).toBe(256);
  });

  it("notificationDtoSchema declares the bounded metadata contract honestly (Verification 4)", () => {
    // Static AST/equality check on the exported schema object — Fastify is NOT relied on
    // to strip fields, so the schema is documentation/honesty only. It must declare:
    //   - maxProperties: 16
    //   - propertyNames.pattern: ^[a-zA-Z_][a-zA-Z0-9_]{0,63}$
    //   - additionalProperties as a primitive-only union (string ≤256 | number | boolean | null)
    const metadataSchema = notificationDtoSchema.properties.metadata as Record<string, unknown>;
    expect(metadataSchema.maxProperties).toBe(16);
    expect((metadataSchema.propertyNames as { pattern: string }).pattern).toBe(
      "^[a-zA-Z_][a-zA-Z0-9_]{0,63}$"
    );
    const additional = metadataSchema.additionalProperties as { anyOf: unknown[] };
    expect(Array.isArray(additional.anyOf)).toBe(true);
    const stringBranch = additional.anyOf.find(
      (b): b is { type: string; maxLength: number } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "string"
    );
    expect(stringBranch?.maxLength).toBe(256);
    const types = additional.anyOf
      .map((b) => (typeof b === "object" && b !== null ? (b as { type?: string }).type : undefined))
      .filter(Boolean)
      .sort();
    expect(types).toEqual(["boolean", "null", "number", "string"]);
  });

  it("markRead returns the row in one logical operation (single round-trip by design) (Verification 5)", async () => {
    // The mandatory behavioral assertion: markRead returns the row with its read_at set,
    // or undefined. The single-round-trip design is anchored in the repository docblock
    // ("Single round-trip via a modifying CTE") and verified here at the behavior level.
    // The CTE shape makes a follow-up getById call structurally impossible — there is no
    // second .execute() in the markRead body.
    //
    // We mint a FRESH notification (so prior tests' markRead calls don't pre-set read_at),
    // assert it starts unread, then markRead and assert the row is returned with read_at set.
    const created = (await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, {
        moduleId: "briefings",
        title: "MarkRead round-trip probe",
        metadata: { source: "test" }
      })
    ))!;
    const beforeRead = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, created.id)
    );
    expect(beforeRead?.read_at).toBeNull();

    const marked = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markRead(scopedDb, created.id)
    );
    expect(marked?.id).toBe(created.id);
    expect(marked?.read_at).toBeInstanceOf(Date);
    expect(marked?.title).toBe("MarkRead round-trip probe");
    expect(marked?.actor_user_id).toBe(ids.userA);
    expect(marked?.recipient_user_id).toBe(ids.userA);

    // Query-count spy on the Kysely executor — proves the single-round-trip contract
    // structurally. Kysely's RawBuilder.execute(executorProvider) calls
    // `executorProvider.getExecutor()` to obtain the executor, then `transformQuery` →
    // `compileQuery` → `executeQuery`. We construct a fake DataContextDb whose db exposes
    // a counting executor: every executeQuery call increments the counter. markRead only
    // invokes `sql...execute(scopedDb.db)` once, so the counter must read exactly 1 after
    // the call (no follow-up getById). assertDataContextDb passes because we attach the
    // brand symbol.
    let executeCount = 0;
    const fakeExecutor = {
      transformQuery: (node: unknown) => node,
      compileQuery: () => ({ query: { sql: "FAKE", parameters: [] as unknown[] } }),
      executeQuery: async () => {
        executeCount += 1;
        return { rows: [] as NotificationWithReadState[] };
      },
      withPlugins: () => fakeExecutor
    };
    const countingScopedDb = {
      db: {
        getExecutor: () => fakeExecutor
      },
      [dataContextBrand]: true
    } as unknown as DataContextDb;

    const spyResult = await repository.markRead(countingScopedDb, created.id);
    expect(spyResult).toBeUndefined();
    expect(executeCount).toBe(1);
  });

  it("markRead absent-vs-denied is indistinguishable at the repository layer (Verification 6/repo)", async () => {
    const absentResult = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markRead(scopedDb, nonexistentNotificationId)
    );
    // bPrivate exists but is RLS-invisible to userA (recipient=userB).
    const deniedResult = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markRead(scopedDb, notificationIds.bPrivate)
    );
    expect(absentResult).toBeUndefined();
    expect(deniedResult).toBeUndefined();
    // No information side-channel: both are deeply equal.
    expect(absentResult).toEqual(deniedResult);
  });

  it("the DB-level metadata CHECK blocks inserts over 4096 bytes (Verification 8)", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      // 5000-character single-string value: jsonb::text exceeds 4096 bytes.
      const oversized = JSON.stringify({ overflow: "x".repeat(5000) });
      await expect(
        client.query(
          `
            INSERT INTO app.notifications (id, actor_user_id, recipient_user_id, title, body, metadata)
            VALUES ($1, $2, $3, 'oversized metadata probe', null, $4::jsonb)
          `,
          [randomUUID(), ids.userA, ids.userA, oversized]
        )
      ).rejects.toThrow(/notifications_metadata_size_check/);
    } finally {
      await client.end();
    }
  });

  it("the defense-in-depth SQL comments are present on notifications + notification_reads (Verification 9)", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      const tableComments = await client.query<{ obj_description: string }>(
        `
          SELECT obj_description(c.oid) AS obj_description
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app'
            AND c.relname IN ('notifications', 'notification_reads')
          ORDER BY c.relname
        `
      );
      expect(tableComments.rows).toHaveLength(2);
      const descriptions = tableComments.rows.map((r) => r.obj_description).join("\n");
      // The notifications comment must mention the actor-scoped invariant.
      expect(descriptions).toContain("actor-scoped");
      // The notification_reads comment must mention the EXISTS defense-in-depth clause.
      expect(descriptions).toContain("EXISTS");
      expect(descriptions).toContain("defense-in-depth");

      // Spot-check one policy comment too: notification_reads_select's comment.
      const policyComments = await client.query<{ description: string }>(
        `
          SELECT pol.polname, pg_catalog.obj_description(pol.oid) AS description
          FROM pg_policy pol
          JOIN pg_class c ON c.oid = pol.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app'
            AND c.relname = 'notification_reads'
            AND pol.polname = 'notification_reads_select'
        `
      );
      expect(policyComments.rows[0]?.description).toContain("defense-in-depth");
    } finally {
      await client.end();
    }
  });

  it("metadata is typed as the bounded NotificationMetadata primitive union (Verification 4/type)", () => {
    // Compile-time guard: a NotificationDto.metadata assignment of an unbounded
    // Record<string, unknown> must fail typecheck. The @ts-expect-error will become
    // unused if the type is silently widened back to Record<string, unknown>.
    const sample: NotificationMetadata = { ok: true, n: 1, s: "x", z: null };
    expect(sample.ok).toBe(true);
    // @ts-expect-error — NotificationMetadata values must be primitive; objects are rejected.
    const badNested: NotificationMetadata = { nested: { leak: true } };
    expect(badNested).toBeDefined();
  });

  it("new notification defaults to urgency 'normal' and deferred_until is null without a port", async () => {
    const n = (await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, { moduleId: "briefings", title: "Default urgency" })
    ))!;
    expect(n.urgency).toBe("normal");
    expect(n.deferred_until).toBeNull();
  });

  it("urgency 'urgent' bypasses deferral even with active quiet hours", async () => {
    const allDayPort: QuietHoursPort = {
      getSettings: async () => ({ enabled: true, start: "00:00", end: "23:59", timezone: "UTC" }),
      getLocaleTimezone: async () => null
    };
    const repo = new NotificationsRepository(allDayPort);
    const n = (await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repo.create(scopedDb, {
        moduleId: "briefings",
        title: "Urgent skip deferral",
        urgency: "urgent"
      })
    ))!;
    expect(n.urgency).toBe("urgent");
    expect(n.deferred_until).toBeNull();
  });

  it("normal notification deferred during active quiet hours; hidden from listVisible", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-08-08T23:58:30.000Z"));
    try {
      // All-day UTC window (00:00–23:59) means now() is always inside quiet hours.
      const allDayPort: QuietHoursPort = {
        getSettings: async () => ({ enabled: true, start: "00:00", end: "23:59", timezone: "UTC" }),
        getLocaleTimezone: async () => null
      };
      const repo = new NotificationsRepository(allDayPort);

      const deferred = (await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.create(scopedDb, {
          moduleId: "briefings",
          title: "Deferred normal",
          urgency: "normal"
        })
      ))!;
      expect(deferred.deferred_until).toBeInstanceOf(Date);
      // deferred_until must be in the future (end of the fixed 23:59 UTC window)
      expect(deferred.deferred_until!.getTime()).toBeGreaterThan(Date.now());

      // Must be hidden from listVisible (filter: deferred_until IS NULL OR now() >= deferred_until)
      const byId = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.getById(scopedDb, deferred.id)
      );
      expect(byId).toBeUndefined();

      const listed = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.listVisible(scopedDb)
      );
      expect(listed.notifications).not.toContainEqual(expect.objectContaining({ id: deferred.id }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("locale timezone used as fallback; overnight math correct with real PT offset", async () => {
    // Spec exit criterion: window 22:00-07:00, timezone = null, locale tz = America/Los_Angeles.
    // resolveTimezone must return the locale tz; computeDeferredUntil must release at 07:00 PT
    // (= 15:00 UTC in PST/UTC-8), NOT at 07:00 UTC.
    //
    // Fixed "now" = 2024-01-15T06:00:00Z = 10:00 PM PST Jan 14 — inside the overnight window.
    const localePort: QuietHoursPort = {
      getSettings: async () => ({
        enabled: true,
        start: "22:00",
        end: "07:00",
        timezone: null
      }),
      getLocaleTimezone: async () => "America/Los_Angeles"
    };

    // resolveTimezone: null explicit override → falls back to locale tz
    const resolvedTz = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      resolveTimezone(localePort, scopedDb, null)
    );
    expect(resolvedTz).toBe("America/Los_Angeles");

    // computeDeferredUntil: 22:00-07:00 PT overnight window, now = 22:00 PST Jan 14
    const midWindowNow = new Date("2024-01-15T06:00:00Z"); // 10:00 PM PST Jan 14
    const overnightSettings: QuietHoursSettings = {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: null
    };
    const deferred = computeDeferredUntil(midWindowNow, overnightSettings, resolvedTz);

    expect(deferred).not.toBeNull();
    // 07:00 AM PST (UTC-8) Jan 15 = 15:00 UTC Jan 15
    const expectedRelease = new Date("2024-01-15T15:00:00Z");
    // Allow ±2 min for the iterative UTC-offset correction in computeDeferredUntil
    expect(Math.abs(deferred!.getTime() - expectedRelease.getTime())).toBeLessThan(2 * 60 * 1000);

    // Sanity: if UTC were used instead, release would have been 07:00 UTC = 08 hours earlier
    const wrongUtcRelease = new Date("2024-01-15T07:00:00Z");
    expect(deferred!.getTime()).not.toBeCloseTo(wrongUtcRelease.getTime(), -4);
  });

  it("disabled quiet hours leaves deferred_until null", async () => {
    const disabledPort: QuietHoursPort = {
      getSettings: async () => ({ enabled: false, start: "00:00", end: "23:59", timezone: "UTC" }),
      getLocaleTimezone: async () => null
    };
    const repo = new NotificationsRepository(disabledPort);
    const n = (await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repo.create(scopedDb, { moduleId: "briefings", title: "Disabled quiet hours" })
    ))!;
    expect(n.deferred_until).toBeNull();
  });
});
