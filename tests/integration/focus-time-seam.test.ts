import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ToolExecute,
  ToolServices,
  ModuleAssistantToolManifest,
  MossModuleManifest
} from "@moss/module-sdk";
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
  createConnectorSecretCipher
} from "@moss/connectors";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { captureFetch, okText } from "./focus-time-helpers.js";

describe("Group A — tool-service injection seam (module-sdk types)", () => {
  it("a ToolExecute handler may accept a 4th services argument and read a named service", async () => {
    const handler: ToolExecute = async (_scopedDb, _input, _ctx, services?: ToolServices) => {
      const svc = (services ?? {}).demo as { ping: () => string } | undefined;
      return { data: { value: svc ? svc.ping() : "no-service" } };
    };
    const result = await handler(
      {},
      {},
      { actorUserId: "u", requestId: "r", chatSessionId: "s" },
      {
        demo: { ping: () => "pong" }
      }
    );
    expect(result.data.value).toBe("pong");
  });

  it("a 3-arg handler still satisfies ToolExecute (backwards compatible)", async () => {
    const legacy: ToolExecute = async (_scopedDb, _input, _ctx) => ({ data: { ok: true } });
    const result = await legacy({}, {}, { actorUserId: "u", requestId: "r", chatSessionId: "s" });
    expect(result.data.ok).toBe(true);
  });

  it("ModuleAssistantToolManifest accepts an optional requiresServices array", () => {
    const tool: ModuleAssistantToolManifest = {
      name: "demo.tool",
      description: "demo",
      permissionId: "demo.manage",
      risk: "write",
      requiresServices: ["demo"]
    };
    expect(tool.requiresServices).toEqual(["demo"]);
  });
});

describe("Group A — gateway passes toolServices as the 4th execute argument", () => {
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

  function gatewayWith(modules: MossModuleManifest[], toolServices: Record<string, unknown>) {
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
      confirmTimeoutMs: 150_000,
      toolServices
    });
    return { gateway, tokens, emitted };
  }

  // Drive a write/destructive tool through the confirm gate with an Approve. Reads the pending
  // actionRequestId off the emitted action_request card (no DB polling), then resolves it.
  async function callAndApprove(
    gateway: AssistantToolGateway,
    emitted: GatewaySessionRecord[],
    token: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<GatewayToolResponse> {
    const callP = gateway.callTool(token, toolName, input);
    // The action_request card is emitted synchronously inside confirmAndRun before it awaits
    // resolution; let the microtask + the createPendingAssistantAction round-trip settle.
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

  it("a WRITE tool declaring requiresServices receives the registered service (after approve)", async () => {
    const module: MossModuleManifest = {
      id: "demo",
      name: "Demo",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          name: "demo.ping",
          description: "d",
          permissionId: "demo.view",
          risk: "write",
          inputSchema: { type: "object", properties: {} },
          requiresServices: ["demo"],
          execute: async (_db, _i, _c, services) => {
            const svc = (services ?? {}).demo as { ping: () => string };
            return { data: { value: svc.ping() } };
          }
        }
      ]
    };
    const { gateway, tokens, emitted } = gatewayWith([module], { demo: { ping: () => "pong" } });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await callAndApprove(gateway, emitted, token, "demo.ping", {});
    expect(res.ok).toBe(true);
    expect(okText(res)).toContain("pong");
  });

  it("a legacy 3-arg read tool still dispatches when toolServices is empty", async () => {
    const module: MossModuleManifest = {
      id: "legacy",
      name: "Legacy",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          name: "legacy.read",
          description: "d",
          permissionId: "legacy.view",
          risk: "read",
          inputSchema: { type: "object", properties: {} },
          execute: async (_db, _i, _c) => ({ data: { ok: true } })
        }
      ]
    };
    const { gateway, tokens } = gatewayWith([module], {});
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "legacy.read", {});
    expect(res.ok).toBe(true);
  });

  it("a WRITE tool receives ONLY its declared services, never the whole registry (HIGH #1)", async () => {
    const module: MossModuleManifest = {
      id: "iso",
      name: "Iso",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          // declares "allowed" only — must NOT be able to see "secret"
          name: "iso.write",
          description: "d",
          permissionId: "iso.manage",
          risk: "write",
          inputSchema: { type: "object", properties: {} },
          requiresServices: ["allowed"],
          execute: async (_db, _i, _c, services) => {
            const s = services ?? {};
            return { data: { sawAllowed: "allowed" in s, sawSecret: "secret" in s } };
          }
        }
      ]
    };
    const { gateway, tokens, emitted } = gatewayWith([module], {
      allowed: { ok: () => "yes" },
      secret: { createEvent: () => "WOULD-WRITE" }
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await callAndApprove(gateway, emitted, token, "iso.write", {});
    expect(res.ok).toBe(true);
    // renderToolResult pretty-prints scalar `data` JSON (key: value with a space).
    expect(okText(res)).toContain('"sawAllowed": true');
    expect(okText(res)).toContain('"sawSecret": false');
  });

  it("a READ tool NEVER receives an injected service, even if it declares one (HIGH #5)", async () => {
    // A read tool dispatches WITHOUT confirmAndRun; handing it a (possibly write-capable) service
    // would bypass the write→confirm floor. The gateway must hide it at listing AND withhold the
    // service if somehow invoked. Both are asserted here.
    const module: MossModuleManifest = {
      id: "sneaky",
      name: "Sneaky",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          name: "sneaky.read",
          description: "d",
          permissionId: "sneaky.view",
          risk: "read",
          inputSchema: { type: "object", properties: {} },
          requiresServices: ["writeCapable"],
          execute: async (_db, _i, _c, services) => ({
            data: { saw: "writeCapable" in (services ?? {}) }
          })
        }
      ]
    };
    const { gateway, tokens } = gatewayWith([module], {
      writeCapable: { createEvent: () => "WOULD-WRITE-NO-CONFIRM" }
    });
    // Hidden at listing (read tool declaring services is a misconfiguration).
    const listed = await gateway.listToolsForActor(ids.userA);
    expect(listed.find((t) => t.name === "sneaky.read")).toBeUndefined();
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "sneaky.read", {});
    expect(res.ok).toBe(false); // not available — never reaches execute, never sees the service
  });

  it("a WRITE tool whose required service is NOT registered is not listed or invokable (HIGH #2)", async () => {
    const module: MossModuleManifest = {
      id: "needs",
      name: "Needs",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          name: "needs.tool",
          description: "d",
          permissionId: "needs.manage",
          risk: "write",
          inputSchema: { type: "object", properties: {} },
          requiresServices: ["absent"],
          execute: async () => ({ data: { ok: true } })
        }
      ]
    };
    const { gateway, tokens } = gatewayWith([module], {}); // "absent" not registered
    const listed = await gateway.listToolsForActor(ids.userA);
    expect(listed.find((t) => t.name === "needs.tool")).toBeUndefined();
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "needs.tool", {});
    expect(res.ok).toBe(false); // "Tool not available" — fail closed, no execute reached
  });
});

describe("Group B — GoogleApiClient.freeBusy + insertEvent", () => {
  it("freeBusy posts to the freeBusy endpoint and returns busy intervals for primary", async () => {
    const { calls, fetchFn } = captureFetch(() => ({
      body: {
        calendars: {
          primary: { busy: [{ start: "2026-06-17T09:00:00Z", end: "2026-06-17T10:00:00Z" }] }
        }
      }
    }));
    const client = new GoogleApiClient({ fetchFn });
    const result = await client.freeBusy({
      accessToken: "tok",
      timeMin: "2026-06-17T09:00:00Z",
      timeMax: "2026-06-17T12:00:00Z",
      calendarId: "primary"
    });
    expect(calls[0]!.url).toContain("/freeBusy");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(result.busy).toEqual([{ start: "2026-06-17T09:00:00Z", end: "2026-06-17T10:00:00Z" }]);
  });

  it("insertEvent posts to the primary calendar events endpoint and returns the created id + htmlLink", async () => {
    const { calls, fetchFn } = captureFetch(() => ({
      body: { id: "evt-123", htmlLink: "https://calendar.google.com/evt-123" }
    }));
    const client = new GoogleApiClient({ fetchFn });
    const created = await client.insertEvent({
      accessToken: "tok",
      calendarId: "primary",
      summary: "Focus time",
      start: "2026-06-17T09:00:00Z",
      end: "2026-06-17T11:00:00Z",
      extendedPrivateProperties: { jarvisCreated: "true", jarvisTool: "createEvent" }
    });
    expect(calls[0]!.url).toContain("/calendars/primary/events");
    expect(calls[0]!.init?.method).toBe("POST");
    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    expect(sentBody.extendedProperties.private.jarvisCreated).toBe("true");
    expect(created.id).toBe("evt-123");
    expect(created.htmlLink).toBe("https://calendar.google.com/evt-123");
  });

  it("insertEvent sends a caller-supplied eventId as the body 'id' (idempotency floor)", async () => {
    const { calls, fetchFn } = captureFetch(() => ({ body: { id: "jfbdeadbeef" } }));
    const client = new GoogleApiClient({ fetchFn });
    await client.insertEvent({
      accessToken: "tok",
      calendarId: "primary",
      summary: "Focus time",
      start: "2026-06-17T09:00:00Z",
      end: "2026-06-17T11:00:00Z",
      eventId: "jfbdeadbeef"
    });
    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    // Google enforces id uniqueness per calendar — a duplicate id returns 409, not a 2nd event.
    expect(sentBody.id).toBe("jfbdeadbeef");
  });

  it("insertEvent surfaces a 409 as a GoogleApiError with statusCode 409 (duplicate id)", async () => {
    const { fetchFn } = captureFetch(() => ({ status: 409, body: { error: "duplicate" } }));
    const client = new GoogleApiClient({ fetchFn });
    await expect(
      client
        .insertEvent({
          accessToken: "tok",
          calendarId: "primary",
          summary: "x",
          start: "2026-06-17T09:00:00Z",
          end: "2026-06-17T11:00:00Z",
          eventId: "jfbdup"
        })
        .catch((e) => {
          expect((e as { statusCode?: number }).statusCode).toBe(409);
          throw e;
        })
    ).rejects.toThrow("Google calendar returned 409");
  });

  it("insertEvent throws a body-free GoogleApiError on a non-2xx", async () => {
    const { fetchFn } = captureFetch(() => ({
      status: 500,
      body: { error: "SECRET-INTERNAL-DETAIL" }
    }));
    const client = new GoogleApiClient({ fetchFn });
    await expect(
      client.insertEvent({
        accessToken: "tok",
        calendarId: "primary",
        summary: "x",
        start: "2026-06-17T09:00:00Z",
        end: "2026-06-17T11:00:00Z"
      })
    ).rejects.toThrow("Google calendar returned 500");
    await expect(
      client.insertEvent({
        accessToken: "tok",
        calendarId: "primary",
        summary: "x",
        start: "2026-06-17T09:00:00Z",
        end: "2026-06-17T11:00:00Z"
      })
    ).rejects.not.toThrow(/SECRET-INTERNAL-DETAIL/);
  });
});

describe("Group B — hasCalendarWriteScope (owner-scoped, read-only)", () => {
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
  // owner's RLS, with an encrypted bundle so has_secret is true — the bundle contents are never read
  // by the scope check.
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

  it("returns true when the active google account holds the calendar scope", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    expect(accountId).toBeTruthy();
    const repo = new ConnectorsRepository();
    const has = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repo.hasCalendarWriteScope(scopedDb)
    );
    expect(has).toBe(true);
  });

  it("returns false when the active google account lacks the calendar scope", async () => {
    await seedGoogleAccount(ids.userB, ["https://www.googleapis.com/auth/gmail.modify"]);
    const repo = new ConnectorsRepository();
    const has = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "test" },
      (scopedDb) => repo.hasCalendarWriteScope(scopedDb)
    );
    expect(has).toBe(false);
  });

  it("returns false when there is no active google connection", async () => {
    // ids.adminUser is a seeded foundation user with NO google account in this suite — the honest
    // "no connection" actor. (test-database.ts seeds only userA/userB/adminUser; there is no userC.)
    const repo = new ConnectorsRepository();
    const has = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "test" },
      (scopedDb) => repo.hasCalendarWriteScope(scopedDb)
    );
    expect(has).toBe(false);
  });
});
