import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord,
  type GatewayToolResponse,
  type SessionNotifier
} from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import {
  ConnectorsRepository,
  GoogleApiClient,
  GoogleConnectionService,
  GoogleOAuthClient,
  createConnectorSecretCipher
} from "@moss/connectors";
import {
  buildCalendarWriteService,
  buildChatGatewayDependencies,
  buildChatToolServices
} from "@moss/chat";
import { calendarModuleManifest, CalendarRepository } from "@moss/calendar";
import type { ProposeFocusResult } from "@moss/calendar";
// registerMcpTransportRoute is NOT re-exported from @moss/chat — import it via the deep src path
// exactly as chat-mcp-transport.test.ts does (verified).
import { registerMcpTransportRoute } from "../../packages/chat/src/mcp-transport.js";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import {
  captureFetch,
  GenericFailingCalendarRepository,
  okText,
  RlsRejectingCalendarRepository
} from "./focus-time-helpers.js";

describe("Group C — calendar.createEvent tool wiring", () => {
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

  // Drive the focus-time write tool through the confirm gate with an Approve. Reads the pending
  // actionRequestId off the emitted action_request card (no DB polling), then resolves it.
  async function callAndApprove(
    gateway: AssistantToolGateway,
    emitted: GatewaySessionRecord[],
    token: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<GatewayToolResponse> {
    const callP = gateway.callTool(token, toolName, input);
    let card: Extract<GatewaySessionRecord, { kind: "action_request" }> | undefined;
    for (let i = 0; i < 200 && !card; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      card = emitted.find(
        (r): r is Extract<GatewaySessionRecord, { kind: "action_request" }> =>
          r.kind === "action_request" && r.toolName === toolName
      );
    }
    if (!card) throw new Error(`no action_request card emitted for ${toolName}`);
    await gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    return callP;
  }

  it("summarize renders requested-window card text mentioning the next-clear-slot caveat", () => {
    const tool = calendarModuleManifest.assistantTools!.find(
      (t) => t.name === "calendar.createEvent"
    );
    expect(tool).toBeTruthy();
    expect(tool!.risk).toBe("write");
    expect(tool!.permissionId).toBe("calendar.manage");
    expect(tool!.requiresServices).toEqual(["calendarWrite"]);
    const text = tool!.summarize!(
      { partOfDay: "morning", durationMinutes: 120, title: "Deep work" },
      { actorUserId: "u", requestId: "r", chatSessionId: "s" }
    );
    expect(text).toMatch(/Deep work/);
    expect(text).toMatch(/next clear slot/i);
  });

  it("calendar.createEvent belongs to calendar_writeback and can be trusted_auto", () => {
    const family = calendarModuleManifest.assistantActionFamilies?.find(
      (f) => f.id === "calendar_writeback"
    );
    expect(family?.defaultTier).toBe("ask_each_time");
    // #1263: every family's allowedTiers must include always_confirm so the user can always
    // demand a confirmation prompt back for a family, even one that also allows trusted_auto.
    expect(family?.allowedTiers).toEqual(["ask_each_time", "trusted_auto", "always_confirm"]);

    const tool = calendarModuleManifest.assistantTools?.find(
      (t) => t.name === "calendar.createEvent"
    );
    expect(tool?.actionFamilyId).toBe("calendar_writeback");
    expect(tool?.executionPolicy).toBe("auto");
  });

  it("on approve, execute resolves a window and delegates to services.calendarWrite", async () => {
    let captured: { start: Date; end: Date; durationMinutes: number; title: string } | null = null;
    const fakeService = {
      async createEvent(
        _db: unknown,
        _ctx: unknown,
        window: { start: Date; end: Date; durationMinutes: number; title: string }
      ) {
        captured = window;
        const r: ProposeFocusResult = {
          created: true,
          resolvedStart: window.start.toISOString(),
          resolvedEnd: window.end.toISOString(),
          shifted: false,
          conflict: "none",
          googleEventId: "evt-xyz",
          calendarMirror: "skipped-rls"
        };
        return r;
      }
    };

    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const emitted: GatewaySessionRecord[] = [];
    const notifier: SessionNotifier = {
      emit(_sessionId, record) {
        emitted.push(record);
      }
    };
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [calendarModuleManifest],
      repository: new AiRepository(),
      runner: dataContext,
      tokens,
      confirmations,
      notifier,
      confirmTimeoutMs: 150_000,
      toolServices: { calendarWrite: fakeService }
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });

    const res = await callAndApprove(gateway, emitted, token, "calendar.createEvent", {
      partOfDay: "morning",
      durationMinutes: 120,
      title: "Deep work"
    });
    expect(res.ok).toBe(true);
    expect(captured).not.toBeNull();
    // The seam must carry the REQUESTED duration (120m), not the band width (Codex HIGH #3).
    expect(captured!.durationMinutes).toBe(120);
    expect(okText(res)).toContain("evt-xyz");
  });
});

describe("Group D — CalendarWriteService impl (faked Google fetch)", () => {
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

  // Inserts a real app.connector_accounts row via ConnectorsRepository.upsertGoogleAccount under the
  // owner's RLS, with an encrypted bundle so has_secret is true.
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
    return account.id;
  }

  function buildImpl(opts: {
    freeBusyBusy?: Array<{ start: string; end: string }>;
    insertReply?: { id: string; htmlLink?: string };
    insertStatus?: number;
    /** Override the calendar repository (D2 injects one whose upsertCachedEvent throws 42501). */
    calendarRepository?: CalendarRepository;
  }) {
    const { fetchFn } = captureFetch((url) => {
      if (url.includes("/freeBusy")) {
        return { body: { calendars: { primary: { busy: opts.freeBusyBusy ?? [] } } } };
      }
      if (url.includes("/events")) {
        if (opts.insertStatus) return { status: opts.insertStatus, body: { error: "SECRET" } };
        return { body: opts.insertReply ?? { id: "evt-new", htmlLink: "https://x/evt-new" } };
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
    return buildCalendarWriteService({
      googleService,
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: repository,
      calendarRepository: opts.calendarRepository ?? new CalendarRepository()
    });
  }

  it("happy path: clear window → insertEvent with jarvisCreated tag → created:true", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({ freeBusyBusy: [] });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true);
    expect(res.googleEventId).toBe("evt-new");
    expect(res.conflict).toBe("none");
    // Duration regression guard: a 120-minute request over a 09:00–12:00 (180-min) band
    // must insert a 120-minute block, NOT the whole band. resolvedEnd - resolvedStart = 120m.
    const inserted =
      (new Date(res.resolvedEnd).getTime() - new Date(res.resolvedStart).getTime()) / 60_000;
    expect(inserted).toBe(120);
  });

  it("conflict: a busy interval shifts the slot (shifted:true)", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({
      freeBusyBusy: [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T13:30:00Z" }]
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true);
    expect(res.shifted).toBe(true);
    expect(res.conflict).toBe("shifted");
  });

  it("fully busy: no-clear-slot → created:false, no insert call", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({
      freeBusyBusy: [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T16:00:00Z" }]
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(false);
    expect(res.conflict).toBe("no-clear-slot");
  });

  it("freeBusy per-calendar errors[] → created:false, NO insert (no double-booking)", async () => {
    // A freeBusy 200 carrying a per-calendar errors[] with empty busy must NOT be read as
    // "fully free": fail-closed in freeBusy() throws, createEvent returns created:false,
    // and the events POST is never reached — so a focus block can't double-book a real event.
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    let insertCalls = 0;
    const { fetchFn } = captureFetch((url) => {
      if (url.includes("/freeBusy")) {
        return {
          body: { calendars: { primary: { busy: [], errors: [{ reason: "rateLimitExceeded" }] } } }
        };
      }
      if (url.includes("/events")) {
        insertCalls += 1;
        return { body: { id: "evt-should-not-exist" } };
      }
      return { body: {} };
    });
    const cipher = createConnectorSecretCipher();
    const repository = new ConnectorsRepository();
    const impl = buildCalendarWriteService({
      googleService: new GoogleConnectionService({
        repository,
        cipher,
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: repository,
      calendarRepository: new CalendarRepository()
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(false);
    expect(insertCalls).toBe(0);
    expect(res.message).toMatch(/availability/i);
  });

  it("missing scope: returns created:false with a re-consent message, no Google call", async () => {
    await seedGoogleAccount(ids.userB, ["https://www.googleapis.com/auth/gmail.modify"]);
    const impl = buildImpl({ freeBusyBusy: [] });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userB, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(false);
    expect(res.message).toMatch(/reconnect/i);
  });

  // D2 — cache mirror gating (deterministic). Inject a calendar repository whose
  // upsertCachedEvent throws the exact SQLSTATE Postgres raises for an RLS WITH CHECK
  // violation (42501), so the test exercises the classification branch in mirrorEvent
  // regardless of whether connector-sync's RLS-relax migration is applied in the run DB
  // (Codex MED #6). The call must still return created:true and never throw — the Google
  // event is the source of truth; the mirror is best-effort.
  it("classifies an RLS (42501) mirror failure as skipped-rls; call still created:true", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({
      freeBusyBusy: [],
      calendarRepository: new RlsRejectingCalendarRepository()
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true); // the Google event is the source of truth; mirror is best-effort
    expect(res.calendarMirror).toBe("skipped-rls");
    expect(res.googleEventId).toBe("evt-new");
  });

  it("idempotency: a 409 on insert (duplicate approved proposal) returns created:true, no duplicate", async () => {
    // A 409 means an event with the deterministic id already exists — i.e. this exact approved
    // proposal was already inserted (a retry after a lost response). The impl must treat it as
    // idempotent success (created:true) rather than prompting "try again", which would risk a
    // SECOND real calendar event. This is the outbound-write idempotency floor (Codex HIGH).
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({ freeBusyBusy: [], insertStatus: 409 });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true); // duplicate insert is a no-op, not a failure
    expect(res.googleEventId).toMatch(/^jfb/); // the deterministic id of the already-existing event
  });

  it("a non-409 insert error still returns created:false (try-again), never a silent success", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({ freeBusyBusy: [], insertStatus: 500 });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(false);
    expect(res.message).toMatch(/try again/i);
  });

  it("retry whose freeBusy shifts the slot still hits 409 (window-keyed id), no 2nd event", async () => {
    // The realistic double-book: 1st insert succeeds but the response is lost; the created block
    // now shows as busy, so the retry's freeBusy shifts the chosen slot. The id must STILL match
    // (it is keyed on the requested window, not the shifted slot) so Google returns 409 and no
    // second event is created (Codex HIGH round 2). We simulate the retry directly: freeBusy
    // reports the first block busy (forcing a shift) AND the events POST returns 409.
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    let insertCalls = 0;
    const { fetchFn } = captureFetch((url) => {
      if (url.includes("/freeBusy")) {
        // The already-created block occupies the unshifted slot, forcing chooseSlot to shift.
        return {
          body: {
            calendars: {
              primary: { busy: [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T13:30:00Z" }] }
            }
          }
        };
      }
      if (url.includes("/events")) {
        insertCalls += 1;
        return { status: 409, body: { error: "duplicate" } }; // id already exists
      }
      return { body: {} };
    });
    const cipher = createConnectorSecretCipher();
    const repository = new ConnectorsRepository();
    const impl = buildCalendarWriteService({
      googleService: new GoogleConnectionService({
        repository,
        cipher,
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: repository,
      calendarRepository: new CalendarRepository()
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true); // the 409 (same window-keyed id) made the retry idempotent
    expect(insertCalls).toBe(1); // exactly one insert attempt, which 409'd — no duplicate created
    // On 409 we do NOT report the retry's shifted guess (the real event sits at the first-attempt
    // slot, which we don't re-fetch) — we honestly report the requested window, unshifted, and skip
    // the mirror so the cache is never written with a wrong time (Codex HIGH round 3).
    expect(res.shifted).toBe(false);
    expect(res.calendarMirror).toBe("skipped-error");
    expect(res.resolvedStart).toBe("2026-06-17T13:00:00.000Z"); // requested window start, not shifted
    expect(res.message).toMatch(/already on your calendar/i);
  });

  it("the deterministic event id is sent on insert (idempotent retry key)", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    // Capture the events POST body to assert the deterministic id reached Google.
    let sentEventId: string | undefined;
    const { fetchFn } = captureFetch((url, init) => {
      if (url.includes("/freeBusy")) return { body: { calendars: { primary: { busy: [] } } } };
      if (url.includes("/events")) {
        sentEventId = JSON.parse(String(init?.body)).id;
        return { body: { id: sentEventId, htmlLink: "https://x" } };
      }
      return { body: {} };
    });
    const cipher = createConnectorSecretCipher();
    const repository = new ConnectorsRepository();
    const impl = buildCalendarWriteService({
      googleService: new GoogleConnectionService({
        repository,
        cipher,
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository: repository,
      calendarRepository: new CalendarRepository()
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(sentEventId).toMatch(/^jfb[0-9a-v]+$/);
    expect(res.googleEventId).toBe(sentEventId);
  });

  it("classifies a non-RLS DB error as skipped-error; call still created:true", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({
      freeBusyBusy: [],
      calendarRepository: new GenericFailingCalendarRepository()
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.createEvent(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true);
    expect(res.calendarMirror).toBe("skipped-error");
  });
});

describe("Group D — buildChatToolServices wires calendarWrite into the gateway (MCP path)", () => {
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
    return account.id;
  }

  // The plan harness uses a discarding notifier ({ emit() {} }), so the pending action id is
  // discovered by reading the owner's pending action requests under their own RLS context.
  async function waitForPendingActionId(
    runner: DataContextRunner,
    actorUserId: string
  ): Promise<string> {
    const repo = new AiRepository();
    for (let i = 0; i < 200; i++) {
      const pending = await runner.withDataContext(
        { actorUserId, requestId: "wait-pending" },
        (scopedDb) => repo.listAssistantActions(scopedDb)
      );
      const found = pending.find((a) => a.status === "pending");
      if (found) return found.id;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no pending action request appeared");
  }

  // Build an app whose gateway uses toolServices PRODUCED BY THE REAL FACTORY (not a literal).
  function buildGatewayAppFromFactory(collaborators: {
    googleConnectionService?: GoogleConnectionService;
    googleApiClient?: GoogleApiClient;
    connectorsRepository?: ConnectorsRepository;
  }) {
    const toolServices = buildChatToolServices(collaborators); // ← exercises D3's code path
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [calendarModuleManifest],
      repository: new AiRepository(),
      runner: dataContext,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit() {} },
      confirmTimeoutMs: 150_000,
      toolServices
    });
    const app = Fastify({ logger: false });
    registerMcpTransportRoute(app, { gateway, tokens });
    app.post<{ Params: { id: string }; Body: { status: string } }>(
      "/api/chat/action-requests/:id/resolve",
      async (request, reply) => {
        await gateway.resolveActionRequest(
          ids.userA,
          request.params.id,
          request.body.status as "confirmed"
        );
        return reply.code(204).send();
      }
    );
    return { app, tokens };
  }

  async function mcp(app: FastifyInstance, token: string, method: string, params: unknown) {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { authorization: `Bearer ${token}` },
      body: { jsonrpc: "2.0", id: 1, method, params }
    });
    return res.json();
  }

  it("WITH collaborators: the factory yields calendarWrite; tools/list includes it and tools/call+resolve executes it", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    // Real collaborators over a faked Google fetch — buildChatToolServices builds a real
    // buildCalendarWriteService from them, so a successful tools/call proves the whole D3 chain.
    const { fetchFn } = captureFetch((url) =>
      url.includes("/freeBusy")
        ? { body: { calendars: { primary: { busy: [] } } } }
        : { body: { id: "evt-mcp", htmlLink: "https://x/evt-mcp" } }
    );
    const cipher = createConnectorSecretCipher();
    const connectorsRepository = new ConnectorsRepository();
    const { app, tokens } = buildGatewayAppFromFactory({
      googleConnectionService: new GoogleConnectionService({
        repository: connectorsRepository,
        cipher,
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository
    });
    await app.ready();
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });

    const list = await mcp(app, token, "tools/list", {});
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("calendar.createEvent"); // factory produced calendarWrite ⇒ tool listed

    const callP = mcp(app, token, "tools/call", {
      name: "calendar.createEvent",
      arguments: { partOfDay: "morning", durationMinutes: 120 }
    });
    const actionId = await waitForPendingActionId(dataContext, ids.userA);
    await app.inject({
      method: "POST",
      url: `/api/chat/action-requests/${actionId}/resolve`,
      payload: { status: "confirmed" }
    });
    const callResult = await callP;
    // tools/call surfaces the created event id once approved + executed via the real wired service.
    expect(JSON.stringify(callResult)).toContain("evt-mcp");
    await app.close();
  });

  it("WITHOUT collaborators: the factory yields {} so tools/list EXCLUDES the tool and tools/call is rejected", async () => {
    const { app, tokens } = buildGatewayAppFromFactory({}); // factory returns {}
    await app.ready();
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const list = await mcp(app, token, "tools/list", {});
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("calendar.createEvent"); // fail-closed: hidden
    const call = await mcp(app, token, "tools/call", {
      name: "calendar.createEvent",
      arguments: {}
    });
    // gateway returns ok:false "Tool not available" → MCP surfaces an error, never reaches execute.
    expect(JSON.stringify(call).toLowerCase()).toMatch(/not available|error/);
    await app.close();
  });

  // Guards the "factory exists but registerChatRoutes forgot to pass toolServices" gap (Codex Round-4 MED):
  // assert the EXACT dependency object registerChatRoutes builds carries toolServices from the factory.
  it("buildChatGatewayDependencies (the helper registerChatRoutes uses) carries toolServices.calendarWrite", () => {
    const { fetchFn } = captureFetch(() => ({ body: {} }));
    const connectorsRepository = new ConnectorsRepository();
    const deps = buildChatGatewayDependencies({
      resolveActiveModules: async () => [calendarModuleManifest],
      repository: new AiRepository(),
      runner: dataContext,
      tokens: new SessionTokenRegistry(),
      confirmations: new ConfirmationRegistry(),
      notifier: { emit() {} },
      collaborators: {
        googleConnectionService: new GoogleConnectionService({
          repository: connectorsRepository,
          cipher: createConnectorSecretCipher(),
          oauthClient: new GoogleOAuthClient({ fetchFn })
        }),
        googleApiClient: new GoogleApiClient({ fetchFn }),
        connectorsRepository
      }
    });
    expect(deps.toolServices).toBeDefined();
    expect((deps.toolServices as Record<string, unknown>).calendarWrite).toBeDefined();
    // and WITHOUT collaborators, the same helper omits it:
    const bare = buildChatGatewayDependencies({
      resolveActiveModules: async () => [calendarModuleManifest],
      repository: new AiRepository(),
      runner: dataContext,
      tokens: new SessionTokenRegistry(),
      confirmations: new ConfirmationRegistry(),
      notifier: { emit() {} },
      collaborators: {}
    });
    expect((bare.toolServices as Record<string, unknown>).calendarWrite).toBeUndefined();
  });
});

describe("Group D — no write without approval (safety property)", () => {
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

  // Snapshot the owner's already-pending action ids (read under their own RLS). The deny/timeout
  // cases run before the approve case and can leave a stale pending row in the shared DB (a timed-out
  // confirmation deliberately stays "pending in the drawer", gateway.ts:187). We must therefore wait
  // for a NEW pending row, not the first one we see — otherwise we'd resolve the stale row on a
  // gateway whose ConfirmationRegistry has no waiter for it, and the live call would hang.
  async function snapshotPendingIds(
    runner: DataContextRunner,
    actorUserId: string
  ): Promise<Set<string>> {
    const repo = new AiRepository();
    const pending = await runner.withDataContext(
      { actorUserId, requestId: "snapshot-pending" },
      (scopedDb) => repo.listAssistantActions(scopedDb)
    );
    return new Set(pending.filter((a) => a.status === "pending").map((a) => a.id));
  }

  // Discover the pending action id created AFTER `existing` was snapshotted (the current call's),
  // reading the owner's pending action requests under their own RLS context (the harness uses a
  // discarding notifier, so there is no card to read off `emitted`).
  async function waitForNewPendingActionId(
    runner: DataContextRunner,
    actorUserId: string,
    existing: Set<string>
  ): Promise<string> {
    const repo = new AiRepository();
    for (let i = 0; i < 200; i++) {
      const pending = await runner.withDataContext(
        { actorUserId, requestId: "wait-pending" },
        (scopedDb) => repo.listAssistantActions(scopedDb)
      );
      const found = pending.find((a) => a.status === "pending" && !existing.has(a.id));
      if (found) return found.id;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no new pending action request appeared");
  }

  function gatewayWithCountingService(confirmTimeoutMs: number) {
    let inserts = 0;
    const service = {
      async createEvent(
        _db: unknown,
        _ctx: unknown,
        window: { start: Date; end: Date; durationMinutes: number; title: string }
      ) {
        inserts += 1;
        return {
          created: true,
          resolvedStart: window.start.toISOString(),
          resolvedEnd: window.end.toISOString(),
          shifted: false,
          conflict: "none" as const,
          googleEventId: "evt",
          calendarMirror: "skipped-rls" as const
        };
      }
    };
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [calendarModuleManifest],
      repository: new AiRepository(),
      runner: dataContext,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit() {} },
      confirmTimeoutMs,
      toolServices: { calendarWrite: service }
    });
    return { gateway, tokens, getInserts: () => inserts };
  }

  it("a denied proposal performs no insert", async () => {
    const { gateway, tokens, getInserts } = gatewayWithCountingService(150_000);
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const existing = await snapshotPendingIds(dataContext, ids.userA);
    const callPromise = gateway.callTool(token, "calendar.createEvent", {
      partOfDay: "morning"
    });
    const actionId = await waitForNewPendingActionId(dataContext, ids.userA, existing);
    await gateway.resolveActionRequest(ids.userA, actionId, "rejected");
    const res = await callPromise;
    expect(res.ok).toBe(false);
    expect(getInserts()).toBe(0);
  });

  it("a timed-out proposal performs no insert", async () => {
    const { gateway, tokens, getInserts } = gatewayWithCountingService(50); // 50ms timeout
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "calendar.createEvent", {
      partOfDay: "morning"
    });
    expect(res.ok).toBe(false);
    expect(getInserts()).toBe(0);
  });

  it("an approved proposal performs exactly one insert", async () => {
    const { gateway, tokens, getInserts } = gatewayWithCountingService(150_000);
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const existing = await snapshotPendingIds(dataContext, ids.userA);
    const callPromise = gateway.callTool(token, "calendar.createEvent", {
      partOfDay: "morning"
    });
    const actionId = await waitForNewPendingActionId(dataContext, ids.userA, existing);
    await gateway.resolveActionRequest(ids.userA, actionId, "confirmed");
    await callPromise;
    expect(getInserts()).toBe(1);
  });
});
