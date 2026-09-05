import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import pg from "pg";

import { AiRepository, registerAiRoutes, summarizeAssistantToolInput } from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { ActionAuditInputSummary, ActionAuditLogEntryDto } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("action audit log", () => {
  let appDb: Kysely<MossDatabase>;
  let app: FastifyInstance;
  let dataContext: DataContextRunner;
  let repo: AiRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    repo = new AiRepository();
    app = Fastify({ logger: false });
    registerAiRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: ids.userA, requestId: "req-api" }),
      dataContext,
      resolveActiveModules: async () => [],
      repository: repo
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await appDb.destroy();
  });

  it("inserts an audit row and reads it back", async () => {
    const id = randomUUID();
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req-1" },
      async (scopedDb) => {
        await repo.insertActionAuditLog(scopedDb, {
          id,
          ownerUserId: ids.userA,
          toolModuleId: "tasks",
          toolName: "tasks.create",
          actionFamilyId: "task-changes",
          actionKind: "write",
          approvalMode: "auto",
          outcome: "success",
          durationMs: null,
          errorClass: null,
          requestId: "req-1",
          chatSessionId: null,
          sourceSurface: "chat",
          inputSummary: {
            inputKeys: ["file_path"],
            inputKeyCount: 1,
            truncated: false
          }
        });
      }
    );

    const rows = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req-2" },
      (scopedDb) =>
        repo.listActionAuditLog(scopedDb, {
          since: new Date(Date.now() - 60_000),
          limit: 10
        })
    );

    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.approval_mode).toBe("auto");
    expect(row!.outcome).toBe("success");
    expect(row!.tool_name).toBe("tasks.create");
    expect(row!.action_kind).toBe("write");
    expect(row!.input_summary).toEqual({
      inputKeys: ["file_path"],
      inputKeyCount: 1,
      truncated: false
    });
  });

  it("bounds inputSummary to key names and strips undeclared properties", async () => {
    const id = randomUUID();
    const secret = "never-persist-this-audit-value";
    const input = Object.fromEntries([
      ["x".repeat(80), secret],
      ...Array.from({ length: 40 }, (_, index) => [`key-${String(index).padStart(2, "0")}`, secret])
    ]);
    const boundedSummary = summarizeAssistantToolInput(input);
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req-schema" },
      async (scopedDb) => {
        await repo.insertActionAuditLog(scopedDb, {
          id,
          ownerUserId: ids.userA,
          toolModuleId: "claude-native",
          toolName: "Write",
          actionFamilyId: null,
          actionKind: "write",
          approvalMode: "yolo",
          outcome: "success",
          durationMs: null,
          errorClass: null,
          requestId: "req-schema",
          chatSessionId: null,
          sourceSurface: "chat",
          inputSummary: {
            ...boundedSummary,
            undeclared: "strip-me"
          } as ActionAuditInputSummary & { undeclared: string }
        });
      }
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/action-audit?limit=500"
    });
    expect(response.statusCode, response.body).toBe(200);
    const entry = response
      .json<{ entries: ActionAuditLogEntryDto[] }>()
      .entries.find((candidate) => candidate.id === id);
    // #1085 F5: migration 0164 intentionally permits this column, so this is the privacy tripwire:
    // only bounded key metadata survives; values and unknown summary fields never cross the API.
    expect(entry?.inputSummary?.inputKeys).toHaveLength(32);
    expect(entry?.inputSummary?.inputKeys.every((key) => key.length <= 64)).toBe(true);
    expect(entry?.inputSummary?.inputKeyCount).toBe(41);
    expect(entry?.inputSummary?.truncated).toBe(true);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("undeclared");
    expect(response.body).not.toContain("strip-me");
  });

  it("enforces RLS: user A cannot see user B rows", async () => {
    const idB = randomUUID();
    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req-b" },
      async (scopedDb) => {
        await repo.insertActionAuditLog(scopedDb, {
          id: idB,
          ownerUserId: ids.userB,
          toolModuleId: "tasks",
          toolName: "tasks.create",
          actionFamilyId: null,
          actionKind: "write",
          approvalMode: "confirmed",
          outcome: "success",
          durationMs: null,
          errorClass: null,
          requestId: "req-b",
          chatSessionId: null,
          sourceSurface: "chat",
          inputSummary: null
        });
      }
    );

    const rowsA = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req-check" },
      (scopedDb) =>
        repo.listActionAuditLog(scopedDb, {
          since: new Date(Date.now() - 60_000),
          limit: 100
        })
    );

    expect(rowsA.some((r) => r.id === idB)).toBe(false);
  });

  it("rejects INSERT with mismatched owner_user_id (WITH CHECK violation)", async () => {
    const id = randomUUID();
    await expect(
      dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req-bad" },
        async (scopedDb) => {
          await repo.insertActionAuditLog(scopedDb, {
            id,
            ownerUserId: ids.userB,
            toolModuleId: "tasks",
            toolName: "tasks.create",
            actionFamilyId: null,
            actionKind: "write",
            approvalMode: "auto",
            outcome: "success",
            durationMs: null,
            errorClass: null,
            requestId: null,
            chatSessionId: null,
            sourceSurface: "chat",
            inputSummary: null
          });
        }
      )
    ).rejects.toThrow();
  });

  it("purge function deletes old rows and leaves recent rows", async () => {
    const oldId = randomUUID();
    const recentId = randomUUID();

    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req-purge" },
      async (scopedDb) => {
        await repo.insertActionAuditLog(scopedDb, {
          id: oldId,
          ownerUserId: ids.userA,
          toolModuleId: "tasks",
          toolName: "tasks.deleteList",
          actionFamilyId: null,
          actionKind: "destructive",
          approvalMode: "confirmed",
          outcome: "success",
          durationMs: null,
          errorClass: null,
          requestId: null,
          chatSessionId: null,
          sourceSurface: "chat",
          inputSummary: null
        });
        await repo.insertActionAuditLog(scopedDb, {
          id: recentId,
          ownerUserId: ids.userA,
          toolModuleId: "tasks",
          toolName: "tasks.create",
          actionFamilyId: null,
          actionKind: "write",
          approvalMode: "auto",
          outcome: "success",
          durationMs: null,
          errorClass: null,
          requestId: null,
          chatSessionId: null,
          sourceSurface: "chat",
          inputSummary: null
        });
      }
    );

    // Backdate the old row to 91 days ago — requires migration owner role (no UPDATE on app_runtime)
    const bootstrapClient = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrapClient.connect();
    try {
      await bootstrapClient.query(
        `UPDATE app.moss_action_audit_log
         SET occurred_at = $1
         WHERE id = $2`,
        [new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), oldId]
      );
    } finally {
      await bootstrapClient.end();
    }

    const olderThan = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const count = await repo.purgeActionAuditLog(appDb, olderThan);

    expect(count).toBeGreaterThanOrEqual(1);

    const remaining = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req-check-purge" },
      (scopedDb) =>
        repo.listActionAuditLog(scopedDb, {
          since: new Date(Date.now() - 92 * 24 * 60 * 60 * 1000),
          limit: 500
        })
    );

    const rowIds = remaining.map((r) => r.id);
    expect(rowIds).not.toContain(oldId);
    expect(rowIds).toContain(recentId);
  });

  it("runtime role has no UPDATE grant on audit log", async () => {
    // jarvis_app_runtime has only SELECT + INSERT — UPDATE must be denied
    await expect(
      appDb
        .updateTable("app.moss_action_audit_log")
        .set({ error_class: "test" })
        .where("id", "=", randomUUID())
        .execute()
    ).rejects.toThrow();
  });

  it("cascade: deleting user removes their audit rows", async () => {
    const tempUserId = randomUUID();
    const tempRowId = randomUUID();

    // Insert a user via bootstrap (app_runtime cannot insert users)
    const bootstrapClient = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrapClient.connect();
    try {
      await bootstrapClient.query(
        `INSERT INTO app.users (id, email, name, is_instance_admin, created_at, updated_at)
         VALUES ($1, $2, 'Cascade Test', false, now(), now())`,
        [tempUserId, `cascade-test-${tempUserId}@example.com`]
      );
    } finally {
      await bootstrapClient.end();
    }

    await dataContext.withDataContext(
      { actorUserId: tempUserId, requestId: "req-cascade" },
      async (scopedDb) => {
        await repo.insertActionAuditLog(scopedDb, {
          id: tempRowId,
          ownerUserId: tempUserId,
          toolModuleId: "tasks",
          toolName: "tasks.create",
          actionFamilyId: null,
          actionKind: "write",
          approvalMode: "auto",
          outcome: "success",
          durationMs: null,
          errorClass: null,
          requestId: null,
          chatSessionId: null,
          sourceSurface: "chat",
          inputSummary: null
        });
      }
    );

    // Delete the user via bootstrap
    const deleteClient = new Client({ connectionString: connectionStrings.bootstrap });
    await deleteClient.connect();
    try {
      await deleteClient.query(`DELETE FROM app.users WHERE id = $1`, [tempUserId]);
    } finally {
      await deleteClient.end();
    }

    // The audit row should cascade-delete
    const checkClient = new Client({ connectionString: connectionStrings.bootstrap });
    await checkClient.connect();
    try {
      const result = await checkClient.query<{ id: string }>(
        `SELECT id FROM app.moss_action_audit_log WHERE id = $1`,
        [tempRowId]
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      await checkClient.end();
    }
  });

  it("audit table has input_summary but no raw content columns", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      const result = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'moss_action_audit_log'`
      );
      const colNames = result.rows.map((r) => r.column_name);
      expect(colNames).toContain("input_summary");
      expect(colNames).not.toContain("content");
      expect(colNames).not.toContain("prompt");
    } finally {
      await client.end();
    }
  });
});
