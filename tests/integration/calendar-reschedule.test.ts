import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import {
  ConnectorsRepository,
  createConnectorSecretCipher,
  featureGrantsPrefKey,
  GoogleApiClient,
  GoogleApiError
} from "@moss/connectors";
import { CalendarRepository } from "@moss/calendar";
import { PreferencesRepository } from "@moss/structured-state";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// ─── Section B: GoogleApiClient.patchEvent ───────────────────────────────────

describe("Section B — GoogleApiClient.patchEvent", () => {
  function makeClient(
    reply: (url: string, init?: RequestInit) => { status?: number; body?: unknown }
  ) {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined
      });
      const r = reply(url, init);
      return {
        ok: (r.status ?? 200) < 400,
        status: r.status ?? 200,
        json: async () => r.body ?? {},
        text: async () => JSON.stringify(r.body ?? {})
      } as Response;
    }) as unknown as typeof fetch;
    return { client: new GoogleApiClient({ fetchFn }), calls };
  }

  it("issues a PATCH to the event's URL with start/end in the body", async () => {
    const { client, calls } = makeClient(() => ({ status: 200, body: { id: "evt-1" } }));
    await client.patchEvent("tok", "primary", "evt-123", {
      start: { dateTime: "2026-06-28T15:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-06-28T16:00:00.000Z", timeZone: "UTC" }
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toContain("/calendars/primary/events/evt-123");
    expect(calls[0]?.body).toEqual({
      start: { dateTime: "2026-06-28T15:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-06-28T16:00:00.000Z", timeZone: "UTC" }
    });
  });

  it("403 → throws GoogleApiError with statusCode 403", async () => {
    const { client } = makeClient(() => ({
      status: 403,
      body: { error: { message: "SECRET_BODY" } }
    }));
    await expect(
      client.patchEvent("tok", "primary", "evt-403", {
        start: { dateTime: "2026-06-28T15:00:00.000Z", timeZone: "UTC" },
        end: { dateTime: "2026-06-28T16:00:00.000Z", timeZone: "UTC" }
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("403 error message does NOT contain the response body", async () => {
    const { client } = makeClient(() => ({
      status: 403,
      body: { error: { message: "SECRET_BODY" } }
    }));
    try {
      await client.patchEvent("tok", "primary", "evt-403", {
        start: { dateTime: "2026-06-28T15:00:00.000Z", timeZone: "UTC" },
        end: { dateTime: "2026-06-28T16:00:00.000Z", timeZone: "UTC" }
      });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as Error).message).not.toContain("SECRET_BODY");
    }
  });

  it("500 → throws GoogleApiError with statusCode 500", async () => {
    const { client } = makeClient(() => ({ status: 500, body: { error: "internal" } }));
    await expect(
      client.patchEvent("tok", "primary", "evt-500", {
        start: { dateTime: "2026-06-28T15:00:00.000Z", timeZone: "UTC" },
        end: { dateTime: "2026-06-28T16:00:00.000Z", timeZone: "UTC" }
      })
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});

// ─── Section C: manifest structure + gateway routing ─────────────────────────

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord,
  type SessionNotifier
} from "@moss/ai";
import { calendarModuleManifest } from "@moss/calendar";
import type { MossModuleManifest, ModuleAssistantToolManifest } from "@moss/module-sdk";
import { buildCalendarWriteService } from "@moss/chat";
import { GoogleConnectionService, GoogleOAuthClient } from "@moss/connectors";

describe("Section C — manifest structure + gateway routing", () => {
  it("calendar.rescheduleEvent is registered with correct risk/family/services/user_promotable", () => {
    const tool = (calendarModuleManifest as MossModuleManifest).assistantTools?.find(
      (t) => t.name === "calendar.rescheduleEvent"
    ) as ModuleAssistantToolManifest | undefined;
    expect(tool).toBeDefined();
    expect(tool!.risk).toBe("write");
    expect(tool!.actionFamilyId).toBe("calendar_management");
    expect(tool!.requiresServices).toEqual(["calendarWrite"]);
    expect(tool!.executionPolicy).toBe("auto");
    expect(tool!.selfOperationGrant).toBe("user_promotable");
    expect(tool!.permissionId).toBe("calendar.manage");
    expect(typeof tool!.execute).toBe("function");
    expect(typeof tool!.summarize).toBe("function");
  });

  it("summarizeRescheduleEvent with displayTitle + displayWhen renders full card text", () => {
    const tool = calendarModuleManifest.assistantTools!.find(
      (t) => t.name === "calendar.rescheduleEvent"
    )!;
    const text = tool.summarize!(
      { eventRef: "uuid-1", displayTitle: "Board sync", displayWhen: "Fri Jun 28, 15:00–16:00" },
      { actorUserId: "u", requestId: "r", chatSessionId: "s" }
    );
    expect(text).toContain("Board sync");
    expect(text).toContain("Fri Jun 28, 15:00–16:00");
  });

  it("summarizeRescheduleEvent with no display fields renders generic fallback", () => {
    const tool = calendarModuleManifest.assistantTools!.find(
      (t) => t.name === "calendar.rescheduleEvent"
    )!;
    const text = tool.summarize!(
      { eventRef: "uuid-1" },
      { actorUserId: "u", requestId: "r", chatSessionId: "s" }
    );
    expect(text).toMatch(/move this calendar event/i);
  });

  // Gateway routing tests (need a real DB)
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
  });
  afterAll(async () => {
    await appDb.destroy();
  });

  function buildGateway(
    modules: MossModuleManifest[],
    services: Record<string, unknown>,
    actionPolicy?: ConstructorParameters<typeof AssistantToolGateway>[0]["actionPolicy"]
  ) {
    const tokens = new SessionTokenRegistry();
    const emitted: GatewaySessionRecord[] = [];
    const notifier: SessionNotifier = {
      emit(_sessionId, record) {
        emitted.push(record);
      }
    };
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => modules,
      repository: new AiRepository(),
      runner: dataContext,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier,
      confirmTimeoutMs: 5_000,
      toolServices: services,
      actionPolicy
    });
    return { gateway, tokens, emitted };
  }

  async function seedTrustedAutoAccountAndEvent(opts: {
    externalId: string;
    attendeeCount?: number;
  }) {
    const cipher = createConnectorSecretCipher();
    const connectorsRepo = new ConnectorsRepository();
    const account = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed" },
      (scopedDb) =>
        connectorsRepo.upsertGoogleAccount(scopedDb, {
          scopes: ["https://www.googleapis.com/auth/calendar"],
          encryptedSecret: cipher.encryptJson({
            kind: "google-oauth",
            clientId: "cid",
            clientSecret: "csecret",
            accessToken: "atoken",
            refreshToken: "rtoken",
            tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
            grantedScopes: ["https://www.googleapis.com/auth/calendar"]
          })
        })
    );
    const calendarRepo = new CalendarRepository();
    const event = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed" },
      (scopedDb) =>
        calendarRepo.upsertCachedEvent(scopedDb, {
          connectorAccountId: account.id,
          externalId: opts.externalId,
          title: "Board sync",
          startsAt: new Date("2026-06-28T14:00:00Z"),
          endsAt: new Date("2026-06-28T15:00:00Z"),
          externalMetadata: { jarvisCreated: true, attendeeCount: opts.attendeeCount ?? 0 }
        })
    );
    return event;
  }

  it("gateway auto-runs calendar.rescheduleEvent (0 attendees) once promoted to trusted_auto", async () => {
    const event = await seedTrustedAutoAccountAndEvent({
      externalId: "google-evt-reschedule-trusted-auto"
    });

    let patchCalled = false;
    const fakeReschedule = {
      async createEvent() {
        throw new Error("should not be called");
      },
      async deleteEvent() {
        throw new Error("should not be called");
      },
      async rescheduleEvent() {
        patchCalled = true;
        return { ok: true as const, calendarEventId: event.id };
      }
    };
    const { gateway, tokens, emitted } = buildGateway(
      [calendarModuleManifest],
      { calendarWrite: fakeReschedule },
      () => ({
        getFamilyTier: async () => "trusted_auto",
        getFamilyManifest: async (_moduleId, familyId) =>
          calendarModuleManifest.assistantActionFamilies!.find((f) => f.id === familyId) ?? null
      })
    );
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });

    const result = await gateway.callTool(token, "calendar.rescheduleEvent", {
      eventRef: event.id,
      newStart: "2026-06-28T15:00:00.000Z",
      newEnd: "2026-06-28T16:00:00.000Z",
      displayTitle: "Board sync"
    });

    expect(result.ok).toBe(true);
    expect(patchCalled).toBe(true);
    expect(emitted.some((r) => r.kind === "action_request")).toBe(false);
  });

  it("event with attendees still shows a confirmation card under trusted_auto (fail-closed: unresolvable-by-confirmation-hook external ref)", async () => {
    // rescheduleEventRequiresConfirmation resolves with connectorAccountId=undefined, so it can
    // only verify a moss_id (uuid) ref's provenance — this uses the moss id, so it CAN resolve
    // provenance and see jarvisCreated:true, meaning the card is skipped by tier alone. The
    // attendee refusal itself is enforced inside rescheduleEvent, independent of the card.
    const event = await seedTrustedAutoAccountAndEvent({
      externalId: "google-evt-reschedule-attendees",
      attendeeCount: 3
    });

    let patchCalled = false;
    const fakeReschedule = {
      async createEvent() {
        throw new Error("should not be called");
      },
      async deleteEvent() {
        throw new Error("should not be called");
      },
      async rescheduleEvent() {
        patchCalled = true;
        return { ok: false as const, reason: "has_attendees" as const };
      }
    };
    const { gateway, tokens } = buildGateway(
      [calendarModuleManifest],
      { calendarWrite: fakeReschedule },
      () => ({
        getFamilyTier: async () => "trusted_auto",
        getFamilyManifest: async (_moduleId, familyId) =>
          calendarModuleManifest.assistantActionFamilies!.find((f) => f.id === familyId) ?? null
      })
    );
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });

    const result = await gateway.callTool(token, "calendar.rescheduleEvent", {
      eventRef: event.id,
      newStart: "2026-06-28T15:00:00.000Z",
      newEnd: "2026-06-28T16:00:00.000Z"
    });

    // The tool ran (trusted_auto let it through) but the implementation's own hard refusal fired.
    // The gateway envelope is ok:true (the call itself succeeded); the business-level refusal is
    // inside the rendered tool-result text, per renderAndCap's {text} shape.
    expect(patchCalled).toBe(true);
    expect(result.ok).toBe(true);
    const rendered = (result as { ok: true; data: Record<string, unknown> }).data.text;
    expect(String(rendered)).toContain("has_attendees");
  });
});

// ─── Section D: buildCalendarWriteService.rescheduleEvent (faked Google fetch) ─

describe("Section D — buildCalendarWriteService.rescheduleEvent", () => {
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

  async function seedGoogleAccount(ownerId: string, scopes: string[]): Promise<string> {
    const cipher = createConnectorSecretCipher();
    const repo = new ConnectorsRepository();
    const account = await dataContext.withDataContext(
      { actorUserId: ownerId, requestId: "seed" },
      (scopedDb) =>
        repo.upsertGoogleAccount(scopedDb, {
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
    await dataContext.withDataContext({ actorUserId: ownerId, requestId: "seed-grants" }, (db) =>
      new PreferencesRepository().upsert(db, featureGrantsPrefKey(account.id), {
        email: true,
        calendar: true
      })
    );
    return account.id;
  }

  async function insertCacheRow(
    ownerId: string,
    accountId: string,
    externalId: string,
    title: string,
    attendeeCount = 0
  ): Promise<string> {
    const repo = new CalendarRepository();
    const row = await dataContext.withDataContext(
      { actorUserId: ownerId, requestId: "insert" },
      (scopedDb) =>
        repo.upsertCachedEvent(scopedDb, {
          connectorAccountId: accountId,
          externalId,
          title,
          startsAt: new Date("2026-06-28T14:00:00Z"),
          endsAt: new Date("2026-06-28T15:00:00Z"),
          externalMetadata: { attendeeCount }
        })
    );
    return row.id;
  }

  function buildImpl(opts: { patchStatus?: number }) {
    const patchCalls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchCalls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
        const status = opts.patchStatus ?? 200;
        return {
          ok: status < 400,
          status,
          json: async () => ({ id: "google-side-id" }),
          text: async () => "{}"
        } as Response;
      }
      if (url.includes("oauth2") || url.includes("token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "fresh-tok",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "https://www.googleapis.com/auth/calendar"
          }),
          text: async () => ""
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" } as Response;
    }) as unknown as typeof fetch;

    const cipher = createConnectorSecretCipher();
    const connectorsRepo = new ConnectorsRepository();
    const impl = buildCalendarWriteService({
      googleService: new GoogleConnectionService({
        repository: connectorsRepo,
        cipher,
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: connectorsRepo,
      calendarRepository: new CalendarRepository()
    });
    return { impl, patchCalls };
  }

  const ctx = { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" };
  const newStart = new Date("2026-06-28T15:00:00.000Z");
  const newEnd = new Date("2026-06-28T16:00:00.000Z");

  it("unrecognized eventRef → ok:false, reason:not_found, no Google call", async () => {
    const { impl, patchCalls } = buildImpl({});
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (db) => impl.rescheduleEvent(db, ctx, { eventRef: "no-such-event", newStart, newEnd })
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("not_found");
    expect(patchCalls).toHaveLength(0);
  });

  it("attendeeCount > 0 → ok:false, reason:has_attendees, no Google call (hard refusal)", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const eventId = await insertCacheRow(
      ids.userA,
      accountId,
      "google-evt-attendees",
      "Standup",
      3
    );
    const { impl, patchCalls } = buildImpl({});
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (db) => impl.rescheduleEvent(db, ctx, { eventRef: eventId, newStart, newEnd })
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("has_attendees");
    expect(patchCalls).toHaveLength(0);
  });

  it("missing calendar-write scope → ok:false, reason:no_scope, no Google call", async () => {
    const accountIdWithScope = await seedGoogleAccount(ids.userB, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const eventId = await insertCacheRow(
      ids.userB,
      accountIdWithScope,
      "google-evt-scope-check",
      "Scoped event"
    );
    await seedGoogleAccount(ids.userB, ["https://www.googleapis.com/auth/gmail.modify"]);
    const { impl, patchCalls } = buildImpl({});
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "t" },
      (db) => impl.rescheduleEvent(db, { ...ctx, actorUserId: ids.userB }, { eventRef: eventId, newStart, newEnd })
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("no_scope");
    expect(patchCalls).toHaveLength(0);
  });

  it("Google 403 → ok:false, reason:provider_error, permission message", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const eventId = await insertCacheRow(ids.userA, accountId, "google-evt-403", "Read-only");
    const { impl } = buildImpl({ patchStatus: 403 });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (db) => impl.rescheduleEvent(db, ctx, { eventRef: eventId, newStart, newEnd })
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("provider_error");
    expect((res as { message?: string }).message).toMatch(/permission/i);
  });

  it("Google 500 → ok:false, reason:provider_error, try-again message", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const eventId = await insertCacheRow(ids.userA, accountId, "google-evt-500", "Planning");
    const { impl } = buildImpl({ patchStatus: 500 });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (db) => impl.rescheduleEvent(db, ctx, { eventRef: eventId, newStart, newEnd })
    );
    expect(res.ok).toBe(false);
    expect((res as { message?: string }).message).toMatch(/try again/i);
  });

  it("happy path: preserves the external event id (patch, never delete-then-create) and mirrors the cache", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const eventId = await insertCacheRow(ids.userA, accountId, "google-evt-happy", "Board sync");
    const { impl, patchCalls } = buildImpl({ patchStatus: 200 });

    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (db) => impl.rescheduleEvent(db, ctx, { eventRef: eventId, newStart, newEnd })
    );
    expect(res.ok).toBe(true);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.url).toContain("google-evt-happy");
    expect(patchCalls[0]!.body).toEqual({
      start: { dateTime: newStart.toISOString(), timeZone: "UTC" },
      end: { dateTime: newEnd.toISOString(), timeZone: "UTC" }
    });

    // Cache mirror reflects the new window; same event id (patch, not delete+recreate)
    const calRepo = new CalendarRepository();
    const found = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "check" },
      (db) => calRepo.getById(db, eventId)
    );
    expect(found).toBeDefined();
    expect(found!.external_id).toBe("google-evt-happy");
    expect(new Date(found!.starts_at).toISOString()).toBe(newStart.toISOString());
    expect(new Date(found!.ends_at).toISOString()).toBe(newEnd.toISOString());
  });

  it("resolves by external_id ref (not just moss uuid)", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    await insertCacheRow(ids.userA, accountId, "google-evt-by-external-id", "Retro");
    const { impl, patchCalls } = buildImpl({ patchStatus: 200 });

    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (db) =>
        impl.rescheduleEvent(db, ctx, {
          eventRef: "google-evt-by-external-id",
          newStart,
          newEnd
        })
    );
    expect(res.ok).toBe(true);
    expect(patchCalls[0]!.url).toContain("google-evt-by-external-id");
  });

  it("result does NOT contain access token or connector secret", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const eventId = await insertCacheRow(ids.userA, accountId, "google-evt-secret-check", "Sync");
    const { impl } = buildImpl({ patchStatus: 200 });

    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (db) => impl.rescheduleEvent(db, ctx, { eventRef: eventId, newStart, newEnd })
    );
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("atoken");
    expect(serialized).not.toContain("fresh-tok");
    expect(serialized).not.toContain("csecret");
    expect(serialized).not.toContain("rtoken");
  });

  it("RLS isolation: userA cannot rescheduleEvent for an event owned by userB", async () => {
    const accountIdB = await seedGoogleAccount(ids.userB, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const eventId = await insertCacheRow(ids.userB, accountIdB, "google-evt-rls", "B private");
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const { impl, patchCalls } = buildImpl({ patchStatus: 200 });

    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (db) => impl.rescheduleEvent(db, ctx, { eventRef: eventId, newStart, newEnd })
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("not_found");
    expect(patchCalls).toHaveLength(0);
  });
});
