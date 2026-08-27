import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  AuthSessionResolver,
  DataContextRunner,
  SharesRepository,
  assertDataContextDb,
  createDatabase,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { CalendarRepository, calendarModuleManifest, serializeCalendarEvent } from "@moss/calendar";
import { EmailRepository, emailListVisibleMessagesExecute, emailModuleManifest } from "@moss/email";
import {
  getBuiltInModuleManifests,
  getBuiltInModuleRegistrations,
  getBuiltInSqlMigrationDirectories
} from "@moss/module-registry";
import { ConnectorsRepository } from "@moss/connectors";
import { createPgBossClient, type PgBoss } from "@moss/jobs";

import {
  buildTestSourceContextService,
  fakeEmailProvider,
  transientProviderError
} from "./source-context-helpers.js";
import {
  connectionStrings,
  expectedBuiltInModuleIds,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

const { Client } = pg;

async function insertCalendarEventForTest(
  scopedDb: DataContextDb,
  input: {
    connectorAccountId: string;
    title: string;
    startsAt: string;
    endsAt: string;
    externalId: string;
    externalMetadata?: Record<string, unknown>;
    id?: string;
  }
) {
  assertDataContextDb(scopedDb);
  const now = new Date();
  return scopedDb.db
    .insertInto("app.calendar_events")
    .values({
      id: input.id ?? randomUUID(),
      connector_account_id: input.connectorAccountId,
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      title: input.title,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      location: null,
      summary: null,
      body_excerpt: null,
      external_id: input.externalId,
      external_metadata: input.externalMetadata ?? {},
      created_at: now,
      updated_at: now
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

const connectorAccountIds = {
  aCalendar: "60000000-0000-4000-8000-000000000001",
  aEmail: "60000000-0000-4000-8000-000000000002",
  bCalendar: "60000000-0000-4000-8000-000000000003",
  bEmail: "60000000-0000-4000-8000-000000000004"
} as const;

const calendarEventIds = {
  aPrivate: "61000000-0000-4000-8000-000000000001",
  bPrivate: "61000000-0000-4000-8000-000000000002",
  bWorkspace: "61000000-0000-4000-8000-000000000003"
} as const;

const emailMessageIds = {
  aPrivate: "62000000-0000-4000-8000-000000000001",
  bPrivate: "62000000-0000-4000-8000-000000000002",
  bWorkspace: "62000000-0000-4000-8000-000000000003"
} as const;

describe("Calendar and Email connector-backed read modules", () => {
  let appDb: Kysely<MossDatabase>;
  let auth: AuthSessionResolver;
  let dataContext: DataContextRunner;
  let calendarRepository: CalendarRepository;
  let emailRepository: EmailRepository;
  let sharesRepository: SharesRepository;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await seedConnectorBackedReadData();

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    auth = new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    calendarRepository = new CalendarRepository();
    emailRepository = new EmailRepository();
    sharesRepository = new SharesRepository();
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 }); // #1124: CI PG connect can exceed pg-boss's 10s default even on success (test-only)
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

  it("applies Calendar and Email migrations with forced RLS and scoped worker grants", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });

    await client.connect();
    try {
      const migrations = await client.query<{ version: string; name: string }>(
        `
          SELECT version, name
          FROM app.schema_migrations
          WHERE version IN ('0011', '0012')
          ORDER BY version
        `
      );
      const tables = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owner: string;
        worker_can_select: boolean;
      }>(
        `
          SELECT
            c.relname,
            c.relrowsecurity,
            c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) AS owner,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'SELECT') AS worker_can_select
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app'
            AND c.relname IN ('calendar_events', 'email_messages')
          ORDER BY c.relname
        `
      );
      const unsafeColumns = await client.query<{ column_name: string }>(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'app'
            AND table_name IN ('calendar_events', 'email_messages')
            AND column_name IN ('raw_payload', 'encrypted_secret', 'access_token', 'refresh_token')
        `
      );

      expect(migrations.rows).toEqual([
        { version: "0011", name: "0011_calendar_module.sql" },
        { version: "0012", name: "0012_email_module.sql" }
      ]);
      expect(tables.rows).toEqual([
        {
          relname: "calendar_events",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner",
          // P3 connector-sync (calendar 0066): the google-sync worker is granted SELECT
          // (+ INSERT/UPDATE) on calendar_events so it can populate the read cache. RLS
          // still scopes every read/write to the actor; the grant only opens the table to
          // the worker role under those policies.
          worker_can_select: true
        },
        {
          relname: "email_messages",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner",
          // P3 connector-sync (email 0068): the google-sync worker is granted SELECT
          // (+ INSERT/UPDATE) on email_messages so it can populate the read cache. RLS
          // still scopes every read/write to the actor; the grant only opens the table to
          // the worker role under those policies.
          worker_can_select: true
        }
      ]);
      expect(unsafeColumns.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("loads Calendar and Email as built-in modules with expected queue definitions", () => {
    const manifests = getBuiltInModuleManifests();
    const registrations = getBuiltInModuleRegistrations();
    const calendarRegistration = registrations.find(
      (item) => item.manifest.id === calendarModuleManifest.id
    );
    const emailRegistration = registrations.find(
      (item) => item.manifest.id === emailModuleManifest.id
    );

    expect(manifests.map((item) => item.id)).toEqual(expectedBuiltInModuleIds);
    expect(calendarModuleManifest.database?.ownedTables).toEqual(["app.calendar_events"]);
    expect(emailModuleManifest.database?.ownedTables).toEqual(["app.email_messages"]);
    expect(calendarModuleManifest.navigation?.[0]).toMatchObject({
      id: "calendar",
      path: "/calendar",
      permissionId: "calendar.view"
    });
    // Email has no user-facing surface: the viewer was retired and the module is now an
    // ingestion source only (assistant tool + cache APIs), so it declares no sidebar nav.
    expect(emailModuleManifest.navigation).toEqual([]);
    expect(calendarRegistration?.queueDefinitions.map((q) => q.name)).toEqual([
      "calendar.cache-evict-event"
    ]);
    expect(emailRegistration?.queueDefinitions).toEqual([]);
    expect(getBuiltInSqlMigrationDirectories()).toContainEqual(
      expect.stringContaining("packages/calendar/sql")
    );
    expect(getBuiltInSqlMigrationDirectories()).toContainEqual(
      expect.stringContaining("packages/email/sql")
    );
  });

  it("denies cached rows when no data context is set", async () => {
    await expect(appDb.selectFrom("app.calendar_events").select("id").execute()).resolves.toEqual(
      []
    );
    await expect(appDb.selectFrom("app.email_messages").select("id").execute()).resolves.toEqual(
      []
    );
  });

  it("creates local cache rows only for connector accounts owned by the active actor", async () => {
    const event = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      insertCalendarEventForTest(scopedDb, {
        connectorAccountId: connectorAccountIds.aCalendar,
        title: "Repository cached event",
        startsAt: "2026-06-07T10:00:00.000Z",
        endsAt: "2026-06-07T11:00:00.000Z",
        externalId: "repo-calendar-event"
      })
    );
    const message = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      emailRepository.createCachedMessageForTest(scopedDb, {
        connectorAccountId: connectorAccountIds.aEmail,
        sender: "sender@example.test",
        recipients: ["owner@example.test"],
        subject: "Repository cached message",
        receivedAt: "2026-06-07T12:00:00.000Z",
        externalId: "repo-email-message"
      })
    );

    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        insertCalendarEventForTest(scopedDb, {
          connectorAccountId: connectorAccountIds.aEmail,
          title: "Wrong provider event",
          startsAt: "2026-06-07T10:00:00.000Z",
          endsAt: "2026-06-07T11:00:00.000Z",
          externalId: "wrong-provider-event"
        })
      )
    ).rejects.toThrow();
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        emailRepository.createCachedMessageForTest(scopedDb, {
          connectorAccountId: connectorAccountIds.bEmail,
          sender: "sender@example.test",
          subject: "Wrong owner message",
          receivedAt: "2026-06-07T12:00:00.000Z",
          externalId: "wrong-owner-message"
        })
      )
    ).rejects.toThrow();
    expect(event.owner_user_id).toBe(ids.userA);
    expect(message.owner_user_id).toBe(ids.userA);
  });

  it("owner can create private cache rows without workspace context", async () => {
    // Under owner-or-share RLS the INSERT policy no longer requires a workspace
    // context for private rows — only the connector-account integrity check and
    // owner_user_id match are enforced.
    const event = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      insertCalendarEventForTest(scopedDb, {
        connectorAccountId: connectorAccountIds.aCalendar,
        title: "Owner private event no workspace",
        startsAt: "2026-06-07T13:00:00.000Z",
        endsAt: "2026-06-07T14:00:00.000Z",
        externalId: "owner-private-event-no-ws"
      })
    );
    const message = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      emailRepository.createCachedMessageForTest(scopedDb, {
        connectorAccountId: connectorAccountIds.aEmail,
        sender: "sender@example.test",
        subject: "Owner private message no workspace",
        receivedAt: "2026-06-07T13:30:00.000Z",
        externalId: "owner-private-message-no-ws"
      })
    );

    expect(event.owner_user_id).toBe(ids.userA);
    expect(message.owner_user_id).toBe(ids.userA);
  });

  it("keeps private calendar and email rows hidden from other users and admins", async () => {
    const userEventRead = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      calendarRepository.getById(scopedDb, calendarEventIds.bPrivate)
    );
    const userMessageRead = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      emailRepository.getById(scopedDb, emailMessageIds.bPrivate)
    );
    const adminContext = await auth.resolveAccessContext(ids.sessionAdmin, "request:admin-cache");
    const adminEventRead = await dataContext.withDataContext(adminContext, (scopedDb) =>
      calendarRepository.getById(scopedDb, calendarEventIds.bPrivate)
    );
    const adminMessageRead = await dataContext.withDataContext(adminContext, (scopedDb) =>
      emailRepository.getById(scopedDb, emailMessageIds.bPrivate)
    );

    expect(userEventRead).toBeUndefined();
    expect(userMessageRead).toBeUndefined();
    expect(adminEventRead).toBeUndefined();
    expect(adminMessageRead).toBeUndefined();
  });

  it("hides another user's rows regardless of workspace context (owner-or-share model)", async () => {
    // Under owner-or-share RLS, bWorkspace rows (owned by userB) are NOT visible
    // to userA via workspace membership alone — a share is required.
    const eventWithoutWorkspace = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      calendarRepository.getById(scopedDb, calendarEventIds.bWorkspace)
    );
    const messageWithoutWorkspace = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      emailRepository.getById(scopedDb, emailMessageIds.bWorkspace)
    );
    expect(eventWithoutWorkspace).toBeUndefined();
    expect(messageWithoutWorkspace).toBeUndefined();
  });

  it("allows calendar event read through a view share", async () => {
    // calendarEventIds.bWorkspace is owned by ids.userB
    await dataContext.withDataContext(userBContext(), (scopedDb) =>
      sharesRepository.grant(scopedDb, {
        resourceType: "calendar_event",
        resourceId: calendarEventIds.bWorkspace,
        ownerUserId: ids.userB,
        granteeUserId: ids.userA,
        level: "view"
      })
    );
    const visibleToA = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      calendarRepository.getById(scopedDb, calendarEventIds.bWorkspace)
    );

    expect(visibleToA?.id).toBe(calendarEventIds.bWorkspace);
  });

  it("allows email message read through a view share", async () => {
    // emailMessageIds.bWorkspace is owned by ids.userB
    await dataContext.withDataContext(userBContext(), (scopedDb) =>
      sharesRepository.grant(scopedDb, {
        resourceType: "email_message",
        resourceId: emailMessageIds.bWorkspace,
        ownerUserId: ids.userB,
        granteeUserId: ids.userA,
        level: "view"
      })
    );
    const visibleToA = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      emailRepository.getById(scopedDb, emailMessageIds.bWorkspace)
    );

    expect(visibleToA?.id).toBe(emailMessageIds.bWorkspace);
  });

  it("serves read-only Calendar and Email APIs from session context (owner-or-share model)", async () => {
    // NOTE: at this point bWorkspace rows have been shared to userA by the two
    // preceding share tests, so they appear in all userA list responses.
    const deniedCalendarResponse = await server.inject({
      method: "GET",
      url: "/api/calendar/events"
    });
    const calendarListResponse = await server.inject({
      method: "GET",
      url: "/api/calendar/events",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const calendarSharedReadResponse = await server.inject({
      method: "GET",
      url: `/api/calendar/events/${calendarEventIds.bWorkspace}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const hiddenCalendarReadResponse = await server.inject({
      method: "GET",
      url: `/api/calendar/events/${calendarEventIds.bPrivate}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const emailListResponse = await server.inject({
      method: "GET",
      url: "/api/email/messages",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const emailSharedReadResponse = await server.inject({
      method: "GET",
      url: `/api/email/messages/${emailMessageIds.bWorkspace}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const hiddenEmailReadResponse = await server.inject({
      method: "GET",
      url: `/api/email/messages/${emailMessageIds.bPrivate}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });

    expect(deniedCalendarResponse.statusCode).toBe(401);
    expect(calendarListResponse.statusCode).toBe(200);
    expect(calendarSharedReadResponse.statusCode).toBe(200);
    expect(hiddenCalendarReadResponse.statusCode).toBe(404);
    // bWorkspace is shared to userA so it appears in the list
    expect(
      calendarListResponse
        .json<{ events: Array<{ id: string }> }>()
        .events.some((event) => event.id === calendarEventIds.bWorkspace)
    ).toBe(true);
    // bPrivate is never shared and must remain invisible
    expect(
      calendarListResponse
        .json<{ events: Array<{ id: string }> }>()
        .events.some((event) => event.id === calendarEventIds.bPrivate)
    ).toBe(false);
    expect(emailListResponse.statusCode).toBe(200);
    expect(emailSharedReadResponse.statusCode).toBe(200);
    expect(hiddenEmailReadResponse.statusCode).toBe(404);
    // bWorkspace is shared to userA so it appears in the list
    expect(
      emailListResponse
        .json<{ messages: Array<{ id: string }> }>()
        .messages.some((message) => message.id === emailMessageIds.bWorkspace)
    ).toBe(true);
    // bPrivate is never shared and must remain invisible
    expect(
      emailListResponse
        .json<{ messages: Array<{ id: string }> }>()
        .messages.some((message) => message.id === emailMessageIds.bPrivate)
    ).toBe(false);
    expect(calendarSharedReadResponse.body).not.toContain("encrypted_secret");
    expect(emailSharedReadResponse.body).not.toContain("encrypted_secret");
  });

  it("serves email-derived fields as inert strings without internal metadata", async () => {
    const htmlSubject = `<img src=x onerror="alert('subject')">`;
    const htmlSnippet = `<script>alert('snippet')</script>`;
    const htmlBodyExcerpt = `<a href="javascript:alert('body')">open</a>`;

    const row = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      emailRepository.upsertCachedMessage(scopedDb, {
        connectorAccountId: connectorAccountIds.aEmail,
        sender: `"Bad <script>alert('sender')</script>" <bad@example.test>`,
        recipients: ["owner@example.test"],
        subject: htmlSubject,
        snippet: htmlSnippet,
        bodyExcerpt: htmlBodyExcerpt,
        receivedAt: "2026-06-09T09:00:00.000Z",
        externalId: "html-payload-message",
        externalMetadata: {
          historyId: "secret-history",
          providerToken: "must-not-leak"
        }
      })
    );

    const response = await server.inject({
      method: "GET",
      url: `/api/email/messages/${row.id}`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json<{
      message: {
        sender: string;
        subject: string;
        snippet: string | null;
        bodyExcerpt: string | null;
      };
    }>();
    expect(payload.message.subject).toBe(htmlSubject);
    expect(payload.message.snippet).toBe(htmlSnippet);
    expect(payload.message.bodyExcerpt).toBe(htmlBodyExcerpt);
    expect(payload.message.sender).toContain("<script>");
    expect(response.body).not.toContain("connectorAccountId");
    expect(response.body).not.toContain("externalMetadata");
    expect(response.body).not.toContain("secret-history");
    expect(response.body).not.toContain("providerToken");
  });

  it("serves default calendar and email briefing settings, then persists user overrides", async () => {
    const initialCalendar = await server.inject({
      method: "GET",
      url: "/api/calendar/briefing-settings",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    const initialEmail = await server.inject({
      method: "GET",
      url: "/api/email/briefing-settings",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(initialCalendar.statusCode).toBe(200);
    expect(initialCalendar.json<{ settings: Record<string, unknown> }>().settings).toEqual({
      lookaheadDays: 2,
      prepTaskMode: "suggest",
      timeBlockMode: "suggest",
      suggestTasks: true,
      createTasks: false,
      suggestTimeBlocks: true,
      blockTime: false
    });
    expect(initialEmail.statusCode).toBe(200);
    expect(initialEmail.json<{ settings: Record<string, unknown> }>().settings).toEqual({
      createTasks: true,
      suggestReplies: true,
      draftReplies: true,
      autoSend: false
    });

    const updateCalendar = await server.inject({
      method: "PATCH",
      url: "/api/calendar/briefing-settings",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { lookaheadDays: 0, createTasks: true, blockTime: true }
    });
    const updateEmail = await server.inject({
      method: "PATCH",
      url: "/api/email/briefing-settings",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { createTasks: false, autoSend: true }
    });

    expect(updateCalendar.statusCode).toBe(200);
    expect(updateCalendar.json<{ settings: Record<string, unknown> }>().settings).toMatchObject({
      lookaheadDays: 0,
      prepTaskMode: "auto",
      timeBlockMode: "auto",
      suggestTasks: true,
      createTasks: true,
      suggestTimeBlocks: true,
      blockTime: true
    });
    expect(updateEmail.statusCode).toBe(200);
    expect(updateEmail.json<{ settings: Record<string, unknown> }>().settings).toMatchObject({
      createTasks: false,
      suggestReplies: true,
      draftReplies: true,
      autoSend: true
    });
  });

  it("keeps email connector-account context on the assistant-tool path without widening REST egress", async () => {
    // Live-first (#729): this test focuses on connector-account context riding along in
    // the tool result, not on grant filtering. The suite's legacy split-provider seed is
    // projected to the unified google shape so the live reader accepts the account, and
    // a transient provider failure drops the read to the seeded cache row.
    const realConnectors = new ConnectorsRepository();
    const sourceContext = buildTestSourceContextService({
      connectorsRepository: {
        listAccounts: async (scopedDb) =>
          (await realConnectors.listAccounts(scopedDb))
            .filter((row) => row.id === connectorAccountIds.aEmail)
            .map((row) => ({
              ...row,
              provider_id: "google",
              provider_type: "google" as const,
              scopes: ["https://www.googleapis.com/auth/gmail.modify"]
            }))
      },
      googleProvider: fakeEmailProvider<string>([], { listError: transientProviderError })
    });

    const toolResult = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      emailListVisibleMessagesExecute(
        scopedDb,
        {},
        {
          actorUserId: ids.userA,
          requestId: "r:email-tool",
          chatSessionId: ""
        },
        { sourceContext }
      )
    );

    const message = (toolResult.data.messages as Array<Record<string, unknown>>).find(
      (row) => row.cacheMessageId === emailMessageIds.aPrivate
    );

    expect(message?.connectorAccountId).toBe(connectorAccountIds.aEmail);
    expect(message).toHaveProperty("threadId");
  });

  it("fails loudly when repositories are called without withDataContext", async () => {
    await expect(calendarRepository.listVisible({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(emailRepository.listVisible({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
  });

  describe("serialize.ts — egress allowlist and value-shape narrowing", () => {
    it("drops all unknown metadata keys and projects only the allowlisted derived fields", async () => {
      const row = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        insertCalendarEventForTest(scopedDb, {
          connectorAccountId: connectorAccountIds.aCalendar,
          title: "Egress test event",
          startsAt: "2026-06-15T10:00:00.000Z",
          endsAt: "2026-06-15T11:00:00.000Z",
          externalId: "egress-test-event-1",
          externalMetadata: {
            allDay: true,
            attendeeCount: 3,
            status: "confirmed",
            historyId: "secret-history-id",
            labelIds: ["INBOX"],
            htmlLink: "https://calendar.google.com/secret-link",
            secretJunk: "should-not-leak"
          }
        })
      );

      const dto = serializeCalendarEvent(row);

      expect(dto.allDay).toBe(true);
      expect(dto.attendeeCount).toBe(3);
      expect(dto.status).toBe("confirmed");
      expect(dto.isMossBlock).toBe(false);
      expect("externalMetadata" in dto).toBe(false);
      expect("historyId" in dto).toBe(false);
      expect("labelIds" in dto).toBe(false);
      expect("htmlLink" in dto).toBe(false);
      expect("secretJunk" in dto).toBe(false);
      expect(Object.keys(dto).sort()).toEqual([
        "allDay",
        "attendeeCount",
        "bodyExcerpt",
        "connectorAccountId",
        "createdAt",
        "endsAt",
        "externalId",
        "id",
        "isMossBlock",
        "location",
        "ownerUserId",
        "startsAt",
        "status",
        "summary",
        "title",
        "updatedAt"
      ]);
    });

    it("serializes a row with no metadata to safe defaults", async () => {
      const row = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        insertCalendarEventForTest(scopedDb, {
          connectorAccountId: connectorAccountIds.aCalendar,
          title: "No-metadata event",
          startsAt: "2026-06-15T12:00:00.000Z",
          endsAt: "2026-06-15T13:00:00.000Z",
          externalId: "no-metadata-event-1",
          externalMetadata: {}
        })
      );

      const dto = serializeCalendarEvent(row);

      expect(dto.isMossBlock).toBe(false);
      expect(dto.allDay).toBe(false);
      expect(dto.attendeeCount).toBe(0);
      expect(dto.status).toBeNull();
    });

    it("coerces wrong-typed allowlisted values to safe defaults (value-shape narrowing)", async () => {
      const row = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        insertCalendarEventForTest(scopedDb, {
          connectorAccountId: connectorAccountIds.aCalendar,
          title: "Wrong-typed metadata event",
          startsAt: "2026-06-15T14:00:00.000Z",
          endsAt: "2026-06-15T15:00:00.000Z",
          externalId: "wrong-typed-event-1",
          externalMetadata: {
            status: { nested: "blob" },
            attendeeCount: "12",
            allDay: "yes"
          }
        })
      );

      const dto = serializeCalendarEvent(row);

      expect(dto.status).toBeNull();
      expect(dto.attendeeCount).toBe(0);
      expect(dto.allDay).toBe(false);
    });

    it("isMossBlock=true for exact jfb+32-char id even when metadata has no jarvisCreated flag", async () => {
      const realJfbId = "jfb" + "a".repeat(32);
      const row = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        insertCalendarEventForTest(scopedDb, {
          connectorAccountId: connectorAccountIds.aCalendar,
          title: "Focus block re-synced",
          startsAt: "2026-06-15T08:00:00.000Z",
          endsAt: "2026-06-15T09:00:00.000Z",
          externalId: realJfbId,
          externalMetadata: {}
        })
      );

      const dto = serializeCalendarEvent(row);

      expect(dto.isMossBlock).toBe(true);
    });

    it("isMossBlock=false for a normal Google event id (not jfb shape)", async () => {
      const row = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        insertCalendarEventForTest(scopedDb, {
          connectorAccountId: connectorAccountIds.aCalendar,
          title: "Normal external event",
          startsAt: "2026-06-15T09:00:00.000Z",
          endsAt: "2026-06-15T10:00:00.000Z",
          externalId: "abc123xyz_google_event_id",
          externalMetadata: {}
        })
      );

      const dto = serializeCalendarEvent(row);

      expect(dto.isMossBlock).toBe(false);
    });

    it("false-positive guard: jfbMEETING_2026 is NOT a Jarvis block (wrong shape)", async () => {
      const row = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        insertCalendarEventForTest(scopedDb, {
          connectorAccountId: connectorAccountIds.aCalendar,
          title: "Meeting with jfb prefix",
          startsAt: "2026-06-15T10:30:00.000Z",
          endsAt: "2026-06-15T11:30:00.000Z",
          externalId: "jfbMEETING_2026",
          externalMetadata: {}
        })
      );

      const dto = serializeCalendarEvent(row);

      expect(dto.isMossBlock).toBe(false);
    });
  });
});

async function seedConnectorBackedReadData(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO app.connector_accounts (
          id,
          provider_id,
          owner_user_id,
          scopes,
          status,
          encrypted_secret
        )
        VALUES
          ($1, 'google-calendar', $2, ARRAY['calendar.readonly']::text[], 'active', '{}'::jsonb),
          ($3, 'google-email', $2, ARRAY['gmail.readonly']::text[], 'active', '{}'::jsonb),
          ($4, 'microsoft-calendar', $5, ARRAY['Calendars.Read']::text[], 'active', '{}'::jsonb),
          ($6, 'microsoft-email', $5, ARRAY['Mail.Read']::text[], 'active', '{}'::jsonb)
      `,
      [
        connectorAccountIds.aCalendar,
        ids.userA,
        connectorAccountIds.aEmail,
        connectorAccountIds.bCalendar,
        ids.userB,
        connectorAccountIds.bEmail
      ]
    );
    await client.query(
      `
        INSERT INTO app.calendar_events (
          id,
          connector_account_id,
          owner_user_id,
          title,
          starts_at,
          ends_at,
          location,
          summary,
          body_excerpt,
          external_id,
          external_metadata
        )
        VALUES
          (
            $1,
            $2,
            $3,
            'User A private event',
            '2026-06-08T09:00:00.000Z',
            '2026-06-08T10:00:00.000Z',
            'Desk',
            'A private summary',
            'A private excerpt',
            'event-a-private',
            '{"source":"seed"}'::jsonb
          ),
          (
            $4,
            $5,
            $6,
            'User B private event',
            '2026-06-08T11:00:00.000Z',
            '2026-06-08T12:00:00.000Z',
            'Room B',
            'B private summary',
            'B private excerpt',
            'event-b-private',
            '{"source":"seed"}'::jsonb
          ),
          (
            $7,
            $5,
            $6,
            'Workspace planning event',
            '2026-06-08T13:00:00.000Z',
            '2026-06-08T14:00:00.000Z',
            'Alpha room',
            'Workspace summary',
            'Workspace excerpt',
            'event-b-workspace',
            '{"source":"seed"}'::jsonb
          )
      `,
      [
        calendarEventIds.aPrivate,
        connectorAccountIds.aCalendar,
        ids.userA,
        calendarEventIds.bPrivate,
        connectorAccountIds.bCalendar,
        ids.userB,
        calendarEventIds.bWorkspace
      ]
    );
    await client.query(
      `
        INSERT INTO app.email_messages (
          id,
          connector_account_id,
          owner_user_id,
          sender,
          recipients,
          subject,
          snippet,
          body_excerpt,
          received_at,
          external_id,
          external_metadata
        )
        VALUES
          (
            $1,
            $2,
            $3,
            'sender-a@example.test',
            ARRAY['user-a@example.test']::text[],
            'User A private message',
            'A private snippet',
            'A private excerpt',
            '2026-06-08T09:30:00.000Z',
            'message-a-private',
            '{"source":"seed"}'::jsonb
          ),
          (
            $4,
            $5,
            $6,
            'sender-b@example.test',
            ARRAY['user-b@example.test']::text[],
            'User B private message',
            'B private snippet',
            'B private excerpt',
            '2026-06-08T10:30:00.000Z',
            'message-b-private',
            '{"source":"seed"}'::jsonb
          ),
          (
            $7,
            $5,
            $6,
            'team@example.test',
            ARRAY['alpha@example.test']::text[],
            'Workspace planning message',
            'Workspace snippet',
            'Workspace excerpt',
            '2026-06-08T11:30:00.000Z',
            'message-b-workspace',
            '{"source":"seed"}'::jsonb
          )
      `,
      [
        emailMessageIds.aPrivate,
        connectorAccountIds.aEmail,
        ids.userA,
        emailMessageIds.bPrivate,
        connectorAccountIds.bEmail,
        ids.userB,
        emailMessageIds.bWorkspace
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-calendar-email"
  };
}

function userBContext(): AccessContext {
  return {
    actorUserId: ids.userB,
    requestId: "request:user-b-calendar-email"
  };
}
