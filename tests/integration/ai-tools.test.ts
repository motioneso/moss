import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import Fastify from "fastify";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { AiRepository, registerAiRoutes } from "@moss/ai";
import { CalendarRepository } from "@moss/calendar";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { EmailRepository } from "@moss/email";
import type { MossModuleManifest } from "@moss/module-sdk";
import { getAllQueueDefinitions } from "@moss/module-registry";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { NotificationsRepository } from "@moss/notifications";
import { TasksRepository } from "@moss/tasks";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const taskIds = {
  aPrivate: "71000000-0000-4000-8000-000000000001",
  bPrivate: "71000000-0000-4000-8000-000000000002",
  bGrantedToA: "71000000-0000-4000-8000-000000000003",
  bWorkspace: "71000000-0000-4000-8000-000000000004"
} as const;

const notificationIds = {
  aPrivate: "73000000-0000-4000-8000-000000000001",
  bPrivate: "73000000-0000-4000-8000-000000000002",
  forUserB: "73000000-0000-4000-8000-000000000003"
} as const;

const connectorAccountIds = {
  aCalendar: "74000000-0000-4000-8000-000000000001",
  aEmail: "74000000-0000-4000-8000-000000000002",
  bCalendar: "74000000-0000-4000-8000-000000000003",
  bEmail: "74000000-0000-4000-8000-000000000004"
} as const;

const calendarEventIds = {
  aPrivate: "75000000-0000-4000-8000-000000000001",
  bPrivate: "75000000-0000-4000-8000-000000000002",
  workspace: "75000000-0000-4000-8000-000000000003"
} as const;

const emailMessageIds = {
  aPrivate: "76000000-0000-4000-8000-000000000001",
  bPrivate: "76000000-0000-4000-8000-000000000002",
  workspace: "76000000-0000-4000-8000-000000000003"
} as const;

interface InvocationResponse {
  readonly invocation: {
    readonly moduleId: string;
    readonly moduleName: string;
    readonly name: string;
    readonly permissionId: string;
    readonly risk: "read" | "write" | "destructive";
    readonly status: "succeeded" | "blocked";
    readonly blockedReason: string | null;
    readonly actionRequestId: string | null;
    readonly result: Record<string, unknown> | null;
  };
}

interface AssistantActionResponse {
  readonly action: {
    readonly id: string;
    readonly toolName: string;
    readonly permissionId: string;
    readonly risk: "write" | "destructive";
    readonly status: "pending" | "confirmed" | "rejected" | "cancelled";
    readonly inputSummary: {
      readonly inputKeys?: readonly string[];
      readonly inputKeyCount?: number;
    };
    readonly requestedAt: string;
    readonly resolvedAt: string | null;
  };
}

interface AssistantActionsResponse {
  readonly actions: readonly AssistantActionResponse["action"][];
}

describe("AI read-only assistant tool execution foundation", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let tasksRepository: TasksRepository;
  let aiRepository: AiRepository;
  let notificationsRepository: NotificationsRepository;
  let calendarRepository: CalendarRepository;
  let emailRepository: EmailRepository;
  let server: ReturnType<typeof createApiServer>;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-ai-tools-secret-key";

    await resetFoundationDatabase();
    await seedAssistantToolData();

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
    aiRepository = new AiRepository();
    tasksRepository = new TasksRepository();
    notificationsRepository = new NotificationsRepository();
    calendarRepository = new CalendarRepository();
    emailRepository = new EmailRepository();
    server = createApiServer({
      appDb,
      logger: false
    });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  it("lists assistant tools from module manifests without execution data", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/ai/assistant-tools",
      headers: userAHeaders()
    });
    const tools = response.json<{
      tools: Array<{
        moduleId: string;
        moduleName: string;
        name: string;
        permissionId: string;
        risk: string;
      }>;
    }>().tools;
    const manifestTools = getBuiltInModuleManifests().flatMap((module) =>
      (module.assistantTools ?? []).map((tool) => `${module.id}:${tool.name}`)
    );

    expect(response.statusCode).toBe(200);
    expect(tools.map((tool) => `${tool.moduleId}:${tool.name}`)).toEqual(manifestTools);
    expect(tools).toContainEqual(
      expect.objectContaining({
        moduleId: "tasks",
        moduleName: "Tasks",
        name: "tasks.updateStatus",
        permissionId: "tasks.update",
        risk: "write"
      })
    );
    expect(response.body).not.toContain('status":"succeeded');
    expect(response.body).not.toContain("encrypted_credential");
    expect(response.body).not.toContain("ciphertext");
  });

  it("executes declared read tools through RLS-scoped module repositories", async () => {
    const tasks = await invokeTool("tasks.list");
    const notifications = await invokeTool("notifications.listVisible");
    const calendar = await invokeTool("calendar.listVisibleEvents");
    const email = await invokeTool("email.listVisibleMessages");
    const workspaceTasks = await invokeTool("tasks.list", userAWorkspaceHeaders());
    const workspaceCalendar = await invokeTool(
      "calendar.listVisibleEvents",
      userAWorkspaceHeaders()
    );
    const workspaceEmail = await invokeTool("email.listVisibleMessages", userAWorkspaceHeaders());

    expect(readIds(tasks.result, "items")).toEqual([taskIds.aPrivate, taskIds.bGrantedToA]);
    expect(readIds(notifications.result, "notifications")).toEqual([notificationIds.aPrivate]);
    // notificationIds.forUserB is seeded with recipient=userB, so userA must NOT see it
    expect(readIds(notifications.result, "notifications")).not.toContain(notificationIds.forUserB);
    // Live-first source context (#729): the seeded accounts use the legacy split
    // google-calendar/google-email providers, which the live readers don't support, so
    // the read fails closed as an unsupported_provider gap for the actor's OWN account —
    // never a silent cache fallback, never another user's rows.
    expect(readIds(calendar.result, "events")).toEqual([]);
    expect(readGaps(calendar.result)).toEqual([
      { connectorAccountId: connectorAccountIds.aCalendar, reason: "unsupported_provider" }
    ]);
    expect(readIds(email.result, "messages")).toEqual([]);
    expect(readGaps(email.result)).toEqual([
      { connectorAccountId: connectorAccountIds.aEmail, reason: "unsupported_provider" }
    ]);
    // Tasks are owner-or-share only now (not workspace-scoped): the workspace context
    // returns the same set as the personal context, and the workspace-only task stays hidden.
    expect(readIds(workspaceTasks.result, "items")).toEqual([
      taskIds.aPrivate,
      taskIds.bGrantedToA
    ]);
    expect(readIds(workspaceTasks.result, "items")).not.toContain(taskIds.bWorkspace);
    // Calendar and email are now owner-or-share (not workspace-scoped): userA does
    // not own the workspace row and has no share, so it stays hidden.
    expect(readIds(workspaceCalendar.result, "events")).not.toContain(calendarEventIds.workspace);
    expect(readIds(workspaceEmail.result, "messages")).not.toContain(emailMessageIds.workspace);
    expect(JSON.stringify(tasks.result)).not.toContain("User B private task");
    expect(JSON.stringify(notifications.result)).not.toContain("User B private notification");
    expect(JSON.stringify(calendar.result)).not.toContain("User B private event");
    expect(JSON.stringify(email.result)).not.toContain("User B private message");
  });

  it("does not give instance admins a private-data bypass through assistant tools", async () => {
    const tasks = await invokeTool("tasks.list", adminHeaders());
    const notifications = await invokeTool("notifications.listVisible", adminHeaders());
    const calendar = await invokeTool("calendar.listVisibleEvents", adminHeaders());
    const email = await invokeTool("email.listVisibleMessages", adminHeaders());
    const combined = JSON.stringify([
      tasks.result,
      notifications.result,
      calendar.result,
      email.result
    ]);

    expect(readIds(tasks.result, "items")).toEqual([]);
    expect(readIds(notifications.result, "notifications")).toEqual([]);
    expect(readIds(calendar.result, "events")).toEqual([]);
    expect(readIds(email.result, "messages")).toEqual([]);
    expect(combined).not.toContain("User B private");
    expect(combined).not.toContain("Private for User B");
  });

  it("creates pending confirmation records for non-read tools without mutating tasks or enqueueing jobs", async () => {
    const jobsBefore = await countPgBossJobs();
    const unknownResponse = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/tasks.deleteEverything/invoke",
      headers: userAHeaders(),
      payload: {
        input: {}
      }
    });
    const writeResponse = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/tasks.updateStatus/invoke",
      headers: userAHeaders(),
      payload: {
        input: {
          taskId: taskIds.aPrivate,
          status: "done"
        }
      }
    });
    const jobsAfter = await countPgBossJobs();
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      tasksRepository.getById(scopedDb, taskIds.aPrivate)
    );
    const blocked = writeResponse.json<InvocationResponse>().invocation;
    const actionsResponse = await server.inject({
      method: "GET",
      url: "/api/ai/assistant-actions",
      headers: userAHeaders()
    });
    expect(actionsResponse.statusCode).toBe(200);

    const action = actionsResponse
      .json<AssistantActionsResponse>()
      .actions.find((item) => item.id === blocked.actionRequestId);

    expect(unknownResponse.statusCode).toBe(404);
    expect(unknownResponse.json()).toEqual({ error: "Assistant tool is not declared" });
    expect(writeResponse.statusCode).toBe(403);
    expect(blocked).toMatchObject({
      moduleId: "tasks",
      name: "tasks.updateStatus",
      permissionId: "tasks.update",
      risk: "write",
      status: "blocked",
      blockedReason: "confirmation_required",
      result: null
    });
    expect(blocked.actionRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(action).toMatchObject({
      toolName: "tasks.updateStatus",
      permissionId: "tasks.update",
      risk: "write",
      status: "pending",
      inputSummary: {
        inputKeys: ["status", "taskId"],
        inputKeyCount: 2
      },
      resolvedAt: null
    });
    expect(JSON.stringify(action)).not.toContain(taskIds.aPrivate);
    expect(JSON.stringify(action)).not.toContain("done");
    expect(JSON.stringify(action)).not.toContain("User A assistant task");
    expect(task?.status).toBe("todo");
    expect(jobsAfter).toBe(jobsBefore);
  });

  it("rejects confirming an assistant-tools/invoke action with no live waiter (#1256)", async () => {
    // #1256: assistant-tools/invoke never creates a live confirmation waiter for the pending row it
    // audits — it always blocks writes and returns immediately. Confirming that row must now fail
    // closed (409) through the same live-waiter gate chat's resolve route uses, the same as any other
    // stale/waiterless pending row. It can still be rejected or cancelled (terminal, no waiter needed).
    const jobsBefore = await countPgBossJobs();
    const writeResponse = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/tasks.updateStatus/invoke",
      headers: userAWorkspaceHeaders(),
      payload: {
        input: {
          taskId: taskIds.bWorkspace,
          status: "done"
        }
      }
    });
    const actionRequestId = writeResponse.json<InvocationResponse>().invocation.actionRequestId;

    expect(actionRequestId).toBeTruthy();

    const resolveResponse = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${actionRequestId}/resolve`,
      headers: userAWorkspaceHeaders(),
      payload: {
        status: "confirmed"
      }
    });
    const task = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      tasksRepository.getById(scopedDb, taskIds.bWorkspace)
    );
    const jobsAfter = await countPgBossJobs();

    expect(writeResponse.statusCode).toBe(403);
    expect(resolveResponse.statusCode).toBe(409);
    expect(task?.status).toBe("todo");
    expect(jobsAfter).toBe(jobsBefore);
  });

  it("does not give other users or admins a private assistant action bypass", async () => {
    const writeResponse = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/tasks.updateStatus/invoke",
      headers: userAHeaders(),
      payload: {
        input: {
          taskId: taskIds.aPrivate,
          status: "done"
        }
      }
    });
    const actionRequestId = writeResponse.json<InvocationResponse>().invocation.actionRequestId;
    const userBResponse = await server.inject({
      method: "GET",
      url: "/api/ai/assistant-actions",
      headers: userBHeaders()
    });
    const adminResponse = await server.inject({
      method: "GET",
      url: "/api/ai/assistant-actions",
      headers: adminHeaders()
    });

    expect(userBResponse.statusCode).toBe(200);
    expect(adminResponse.statusCode).toBe(200);
    expect(userBResponse.json<AssistantActionsResponse>().actions).not.toContainEqual(
      expect.objectContaining({ id: actionRequestId })
    );
    expect(adminResponse.json<AssistantActionsResponse>().actions).not.toContainEqual(
      expect.objectContaining({ id: actionRequestId })
    );
    expect(userBResponse.body).not.toContain(taskIds.aPrivate);
    expect(adminResponse.body).not.toContain(taskIds.aPrivate);
  });

  it("does not create assistant action records for read-only tool invocations", async () => {
    const beforeResponse = await server.inject({
      method: "GET",
      url: "/api/ai/assistant-actions",
      headers: userAHeaders()
    });
    const readInvocation = await invokeTool("tasks.list");
    const afterResponse = await server.inject({
      method: "GET",
      url: "/api/ai/assistant-actions",
      headers: userAHeaders()
    });

    expect(beforeResponse.statusCode).toBe(200);
    expect(afterResponse.statusCode).toBe(200);
    expect(readInvocation.actionRequestId).toBeNull();
    expect(afterResponse.json<AssistantActionsResponse>().actions.length).toBe(
      beforeResponse.json<AssistantActionsResponse>().actions.length
    );
  });

  it("returns HTTP 400 (not 500/200) when REST tool input violates the tool's inputSchema", async () => {
    // The Fastify route schema and parseInvokeAssistantToolBody reject a NON-OBJECT input with 400
    // BEFORE the handler runs — so a non-object payload can never reach validateToolInput.
    // To exercise the NEW guard we must send a valid JSON OBJECT that still violates the TOOL's
    // inputSchema. tasks.list declares listId: { type: "string" } (packages/tasks/src/manifest.ts).
    // Passing listId: 123 (a number) fails the type check in validateToolInput.
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/tasks.list/invoke",
      headers: userAHeaders(),
      payload: {
        input: { listId: 123 }
      }
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string }>();
    expect(body.error).toMatch(/Field listId must be a string/);
  });

  it("does not return AI credentials, connector secrets, ciphertext, or pg-boss payload data", async () => {
    const providerResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: adminHeaders(),
      payload: {
        providerKind: "custom",
        displayName: "Tool Secret Provider",
        credentialPayload: {
          apiKey: "assistant-tool-secret-api-key"
        }
      }
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/email.listVisibleMessages/invoke",
      headers: userAWorkspaceHeaders(),
      payload: {
        input: {}
      }
    });

    expect(providerResponse.statusCode).toBe(201);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("assistant-tool-secret-api-key");
    expect(response.body).not.toContain("hidden-connector-ciphertext");
    expect(response.body).not.toContain("encrypted_credential");
    expect(response.body).not.toContain("encrypted_secret");
    expect(response.body).not.toContain("ciphertext");
    expect(response.body).not.toContain("pgboss");
  });

  it("keeps assistant tools queue-free and repository access DataContext-only", async () => {
    expect(getAllQueueDefinitions().map((queue) => queue.name)).toEqual([
      "rls-probe",
      "system.upgrade-check",
      "system.upgrade-notify",
      "platform.module-control",
      "module-build",
      "export.build",
      "export.cleanup",
      "connectors.google-sync",
      "connectors.google-sync-continuation",
      "connectors.google-sync-sweep",
      "connectors.imap-sync",
      "connectors.email-monitor",
      "connectors.calendar-monitor",
      "tasks-deferred-status",
      "tasks-recurrence-materialize",
      "goals-memory-sync",
      "goals-memory-sync-reconcile",
      "notifications.digest.compose",
      "calendar.cache-evict-event",
      "ai-purge-audit-log",
      "chat.embed-turn",
      "chat.extract-facts",
      "chat.archive-day",
      "briefings-run",
      "memory.vault-ingest-sweep",
      "memory.vault-ingest-nudge",
      "memory.vault-ingest-tick",
      "wellness-export",
      "news.refresh",
      "news.revalidate",
      "notes.sync",
      "proactive-scan-source",
      "commitment-extraction",
      "person-index",
      "sync-person-memory"
    ]);
    await expect(tasksRepository.listVisible({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(notificationsRepository.listVisible({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(calendarRepository.listVisible({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(emailRepository.listVisible({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(aiRepository.listAssistantActions({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
  });

  it("fails closed: a throwing resolveActiveModules does not list or invoke tools", async () => {
    // A resolver/DB failure must surface as a 5xx on BOTH REST tool surfaces — never a
    // 200 with a degraded (empty/all) tool set that silently re-enables a disabled module.
    const app = Fastify({ logger: false });
    app.after(() =>
      registerAiRoutes(app, {
        resolveAccessContext: async () => userAContext(),
        dataContext,
        resolveActiveModules: async () => {
          throw new Error("resolver/DB unavailable");
        }
      })
    );
    await app.ready();
    const list = await app.inject({ method: "GET", url: "/api/ai/assistant-tools" });
    expect(list.statusCode).toBeGreaterThanOrEqual(500);
    const invoke = await app.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/example.read/invoke",
      headers: { "content-type": "application/json" },
      payload: { input: {} }
    });
    expect(invoke.statusCode).toBeGreaterThanOrEqual(500);
    await app.close();
  });

  it("sanitizes REST assistant tool output before returning it to the frontend", async () => {
    const module: MossModuleManifest = {
      id: "security-probe",
      name: "Security Probe",
      version: "1.0.0",
      publisher: "Jarv1s",
      lifecycle: "optional",
      compatibility: { jarv1s: "*" },
      assistantTools: [
        {
          name: "security.nested",
          description: "Nested output probe.",
          permissionId: "security.view",
          risk: "read",
          outputSchema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    owner: {
                      type: "object",
                      properties: { displayName: { type: "string" } },
                      required: ["displayName"]
                    }
                  },
                  required: ["id", "owner"]
                }
              }
            },
            required: ["items"]
          },
          execute: async () => ({
            data: {
              items: [
                {
                  id: "safe-id",
                  owner: {
                    displayName: "Visible Owner",
                    token: "REST_NESTED_SECRET"
                  },
                  privateNote: "REST_PRIVATE_NOTE"
                }
              ],
              topSecret: "REST_TOP_SECRET"
            }
          })
        },
        {
          name: "security.scalar",
          description: "Scalar output probe.",
          permissionId: "security.view",
          risk: "read",
          outputSchema: {
            type: "object",
            properties: { visible: { type: "string" } },
            required: ["visible"]
          },
          execute: async () => ({
            data: { visible: { secret: "REST_SCALAR_SECRET" } }
          })
        }
      ]
    };
    const app = Fastify({ logger: false });
    app.after(() =>
      registerAiRoutes(app, {
        resolveAccessContext: async () => userAContext(),
        dataContext,
        resolveActiveModules: async () => [module]
      })
    );
    await app.ready();

    try {
      const nestedResponse = await app.inject({
        method: "POST",
        url: "/api/ai/assistant-tools/security.nested/invoke",
        headers: { "content-type": "application/json" },
        payload: { input: {} }
      });
      const scalarResponse = await app.inject({
        method: "POST",
        url: "/api/ai/assistant-tools/security.scalar/invoke",
        headers: { "content-type": "application/json" },
        payload: { input: {} }
      });

      expect(nestedResponse.statusCode).toBe(200);
      expect(nestedResponse.body).toContain("safe-id");
      expect(nestedResponse.body).toContain("Visible Owner");
      expect(nestedResponse.body).not.toContain("REST_NESTED_SECRET");
      expect(nestedResponse.body).not.toContain("REST_PRIVATE_NOTE");
      expect(nestedResponse.body).not.toContain("REST_TOP_SECRET");
      expect(nestedResponse.body).not.toContain("privateNote");
      expect(nestedResponse.body).not.toContain("topSecret");
      expect(scalarResponse.statusCode).toBeGreaterThanOrEqual(500);
      expect(scalarResponse.body).not.toContain("REST_SCALAR_SECRET");
    } finally {
      await app.close();
    }
  });

  it("caps oversized REST assistant tool output after sanitizing it", async () => {
    const module: MossModuleManifest = {
      id: "security-cap-probe",
      name: "Security Cap Probe",
      version: "1.0.0",
      publisher: "Jarv1s",
      lifecycle: "optional",
      compatibility: { jarv1s: "*" },
      assistantTools: [
        {
          name: "security.largeOutput",
          description: "Large output probe.",
          permissionId: "security.view",
          risk: "read",
          outputSchema: {
            type: "object",
            properties: { visible: { type: "string" } },
            required: ["visible"]
          },
          execute: async () => ({
            data: { visible: `${"x".repeat(20_000)}REST_OVERSIZED_TAIL` }
          })
        }
      ]
    };
    const app = Fastify({ logger: false });
    app.after(() =>
      registerAiRoutes(app, {
        resolveAccessContext: async () => userAContext(),
        dataContext,
        resolveActiveModules: async () => [module]
      })
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai/assistant-tools/security.largeOutput/invoke",
        headers: { "content-type": "application/json" },
        payload: { input: {} }
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.length).toBeLessThan(18_000);
      expect(response.body).toContain("[truncated tool result]");
      expect(response.body).not.toContain("REST_OVERSIZED_TAIL");

      const result = response.json<InvocationResponse>().invocation.result;
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(16_500);
    } finally {
      await app.close();
    }
  });

  async function invokeTool(
    toolName: string,
    headers: Record<string, string> = userAHeaders(),
    input: Record<string, unknown> = {}
  ): Promise<InvocationResponse["invocation"]> {
    const response = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-tools/${toolName}/invoke`,
      headers,
      payload: {
        input
      }
    });

    expect(response.statusCode).toBe(200);

    const invocation = response.json<InvocationResponse>().invocation;

    expect(invocation).toMatchObject({
      name: toolName,
      risk: "read",
      status: "succeeded",
      blockedReason: null
    });

    return invocation;
  }
});

async function seedAssistantToolData(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query("BEGIN");
    await seedTasks(client);
    await seedNotifications(client);
    await seedConnectorBackedRows(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function seedTasks(client: pg.Client): Promise<void> {
  await client.query(
    `
      INSERT INTO app.task_lists (owner_user_id, name)
      VALUES ($1, 'Personal'), ($2, 'Personal')
      ON CONFLICT DO NOTHING
    `,
    [ids.userA, ids.userB]
  );
  await client.query(
    `
      INSERT INTO app.tasks (id, owner_user_id, title, description, status, list_id)
      VALUES
        ($1, $2, 'User A assistant task', 'A assistant description', 'todo',
          (SELECT id FROM app.task_lists WHERE owner_user_id = $2 AND name = 'Personal' LIMIT 1)),
        ($3, $4, 'User B private task', 'B private description', 'todo',
          (SELECT id FROM app.task_lists WHERE owner_user_id = $4 AND name = 'Personal' LIMIT 1)),
        ($5, $4, 'User B granted assistant task', 'B granted description', 'todo',
          (SELECT id FROM app.task_lists WHERE owner_user_id = $4 AND name = 'Personal' LIMIT 1)),
        ($6, $4, 'User B workspace assistant task', 'B workspace description', 'todo',
          (SELECT id FROM app.task_lists WHERE owner_user_id = $4 AND name = 'Personal' LIMIT 1))
    `,
    [
      taskIds.aPrivate,
      ids.userA,
      taskIds.bPrivate,
      ids.userB,
      taskIds.bGrantedToA,
      taskIds.bWorkspace
    ]
  );
  await client.query(
    `
      INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
      VALUES ('task', $1, $2, $3, 'view')
    `,
    [taskIds.bGrantedToA, ids.userB, ids.userA]
  );
}

async function seedNotifications(client: pg.Client): Promise<void> {
  await client.query(
    `
      INSERT INTO app.notifications (
        id,
        actor_user_id,
        recipient_user_id,
        title,
        body,
        metadata
      )
      VALUES
        ($1, $4, $2, 'User A assistant notification', 'Private for User A', $3::jsonb),
        ($5, $2, $4, 'User B private notification', 'Private for User B', $6::jsonb),
        ($7, $4, $4, 'User B actor-scoped notification', 'Recipient-only summary for User B', $8::jsonb)
    `,
    [
      notificationIds.aPrivate,
      ids.userA,
      JSON.stringify({ source: "assistant-tools-test" }),
      ids.userB,
      notificationIds.bPrivate,
      JSON.stringify({ source: "assistant-tools-test" }),
      notificationIds.forUserB,
      JSON.stringify({ source: "assistant-tools-test" })
    ]
  );
}

async function seedConnectorBackedRows(client: pg.Client): Promise<void> {
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
        ($1, 'google-calendar', $2, ARRAY['calendar.readonly']::text[], 'active', '{"ciphertext":"hidden-connector-ciphertext"}'::jsonb),
        ($3, 'google-email', $2, ARRAY['gmail.readonly']::text[], 'active', '{"ciphertext":"hidden-connector-ciphertext"}'::jsonb),
        ($4, 'microsoft-calendar', $5, ARRAY['Calendars.Read']::text[], 'active', '{"ciphertext":"hidden-connector-ciphertext"}'::jsonb),
        ($6, 'microsoft-email', $5, ARRAY['Mail.Read']::text[], 'active', '{"ciphertext":"hidden-connector-ciphertext"}'::jsonb)
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
        ($1, $2, $3, 'User A assistant event', '2026-06-09T09:00:00.000Z', '2026-06-09T10:00:00.000Z', 'Desk', 'A summary', 'A excerpt', 'event-a-assistant', '{"source":"assistant-tools-test"}'::jsonb),
        ($4, $5, $6, 'User B private event', '2026-06-09T11:00:00.000Z', '2026-06-09T12:00:00.000Z', 'Room B', 'B summary', 'B excerpt', 'event-b-private', '{"source":"assistant-tools-test"}'::jsonb),
        ($7, $5, $6, 'Workspace assistant event', '2026-06-09T13:00:00.000Z', '2026-06-09T14:00:00.000Z', 'Alpha room', 'Workspace summary', 'Workspace excerpt', 'event-workspace-assistant', '{"source":"assistant-tools-test"}'::jsonb)
    `,
    [
      calendarEventIds.aPrivate,
      connectorAccountIds.aCalendar,
      ids.userA,
      calendarEventIds.bPrivate,
      connectorAccountIds.bCalendar,
      ids.userB,
      calendarEventIds.workspace
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
        ($1, $2, $3, 'sender-a@example.test', ARRAY['user-a@example.test']::text[], 'User A assistant message', 'A snippet', 'A excerpt', '2026-06-09T09:30:00.000Z', 'message-a-assistant', '{"source":"assistant-tools-test"}'::jsonb),
        ($4, $5, $6, 'sender-b@example.test', ARRAY['user-b@example.test']::text[], 'User B private message', 'B snippet', 'B excerpt', '2026-06-09T10:30:00.000Z', 'message-b-private', '{"source":"assistant-tools-test"}'::jsonb),
        ($7, $5, $6, 'team@example.test', ARRAY['alpha@example.test']::text[], 'Workspace assistant message', 'Workspace snippet', 'Workspace excerpt', '2026-06-09T11:30:00.000Z', 'message-workspace-assistant', '{"source":"assistant-tools-test"}'::jsonb)
    `,
    [
      emailMessageIds.aPrivate,
      connectorAccountIds.aEmail,
      ids.userA,
      emailMessageIds.bPrivate,
      connectorAccountIds.bEmail,
      ids.userB,
      emailMessageIds.workspace
    ]
  );
}

async function countPgBossJobs(): Promise<number> {
  const client = new Client({ connectionString: connectionStrings.migration });

  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pgboss.job"
    );

    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

function userAHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ids.sessionA}`
  };
}

function userAWorkspaceHeaders(): Record<string, string> {
  return {
    ...userAHeaders(),
    "x-jarvis-workspace-id": "00000000-0000-4000-8000-000000000099"
  };
}

function userBHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ids.sessionB}`
  };
}

function adminHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ids.sessionAdmin}`
  };
}

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-ai-tools"
  };
}

function userBContext(): AccessContext {
  return {
    actorUserId: ids.userB,
    requestId: "request:user-b-ai-tools"
  };
}

/** Source-context gaps (#729), reduced to the account id + reason the tests assert on. */
function readGaps(
  result: Record<string, unknown> | null
): Array<{ connectorAccountId: string | null; reason: string }> {
  const gaps = result?.["gaps"];

  if (!Array.isArray(gaps)) {
    throw new Error("Expected gaps array in assistant tool result");
  }

  return gaps.map((gap) => {
    const entry = gap as {
      account?: { connectorAccountId?: unknown } | null;
      reason?: unknown;
    };
    return {
      connectorAccountId:
        typeof entry.account?.connectorAccountId === "string"
          ? entry.account.connectorAccountId
          : null,
      reason: String(entry.reason)
    };
  });
}

function readIds(result: Record<string, unknown> | null, key: string): string[] {
  const items = result?.[key];

  if (!Array.isArray(items)) {
    throw new Error(`Expected ${key} array in assistant tool result`);
  }

  return items.map((item) => {
    if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") {
      throw new Error(`Expected ${key} item with id`);
    }

    return (item as { id: string }).id;
  });
}
