import { randomUUID } from "node:crypto";
import { sql, type Insertable, type Kysely, type Updateable } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, SharesRepository, type MossDatabase } from "@moss/db";
import type { TerminalActionRecord } from "../../packages/chat/src/action-record-history.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

type MessageInsert = Insertable<MossDatabase["app.chat_messages"]>;
type MessageUpdate = Updateable<MossDatabase["app.chat_messages"]>;
const owner = { actorUserId: ids.userA };
const now = new Date("2026-10-07T10:00:00.000Z");
const terminal: TerminalActionRecord = {
  kind: "action_result",
  actionRequestId: "permission-fixture-action",
  text: "Executed",
  outcome: "executed"
};
const pending = {
  kind: "action_request",
  actionRequestId: terminal.actionRequestId,
  text: "Create a task"
};
const repository = new ChatRepository();
let app: Kysely<MossDatabase>;
let worker: Kysely<MossDatabase>;
let runner: DataContextRunner;
let workerRunner: DataContextRunner;

beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  worker = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  runner = new DataContextRunner(app);
  workerRunner = new DataContextRunner(worker);
});

afterAll(async () => {
  await Promise.all([app?.destroy(), worker?.destroy()]);
});

function metadata(record: unknown = terminal): Record<string, unknown> {
  return {
    selectedTools: [],
    actionOutcomeOnly: true,
    activity: [record],
    actionResults: [record]
  };
}

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function thread(incognito = false, actorUserId: string = ids.userA) {
  return runner.withDataContext({ actorUserId }, (db) =>
    repository.openNewThread(db, { title: "Action history permissions", incognito })
  );
}

function insert(
  threadId: string,
  values: Partial<MessageInsert> = {},
  actorUserId: string = ids.userA
) {
  return runner.withDataContext({ actorUserId }, (db) =>
    db.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: threadId,
        owner_user_id: actorUserId,
        role: "assistant",
        status: "stored",
        body: "",
        model_metadata: {},
        tool_metadata: metadata(),
        created_at: now,
        updated_at: now,
        ...values
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  );
}

function read(threadId: string, actorUserId: string = ids.userA) {
  return runner.withDataContext({ actorUserId }, (db) => repository.listMessages(db, threadId));
}

function readById(messageId: string) {
  return runner.withDataContext(owner, (db) => repository.getMessageById(db, messageId));
}

function readRaw(threadId: string) {
  return runner.withDataContext(owner, (db) =>
    db.db.selectFrom("app.chat_messages").selectAll().where("thread_id", "=", threadId).execute()
  );
}

function update(
  messageId: string,
  values: MessageUpdate,
  actorUserId: string = ids.userA,
  context = runner
) {
  return context.withDataContext({ actorUserId }, (db) =>
    db.db
      .updateTable("app.chat_messages")
      .set(values)
      .where("id", "=", messageId)
      .executeTakeFirstOrThrow()
  );
}

function remove(messageId: string, actorUserId: string = ids.userA, context = runner) {
  return context.withDataContext({ actorUserId }, (db) =>
    db.db.deleteFrom("app.chat_messages").where("id", "=", messageId).executeTakeFirstOrThrow()
  );
}

describe("chat action-history runtime permissions (0297)", () => {
  it("uses real app and worker roles without superuser or RLS bypass privileges", async () => {
    for (const [context, role] of [
      [runner, "jarvis_app_runtime"],
      [workerRunner, "jarvis_worker_runtime"]
    ] as const) {
      const result = await context.withDataContext(owner, (db) =>
        sql<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>`
          SELECT current_user AS role, rolsuper, rolbypassrls
          FROM pg_roles WHERE rolname = current_user
        `.execute(db.db)
      );
      expect(result.rows).toEqual([{ role, rolsuper: false, rolbypassrls: false }]);
    }
  });

  it("lets the repository append terminal metadata to the owner's stored assistant reply", async () => {
    const origin = await thread();
    const recorded = await runner.withDataContext(owner, (db) =>
      repository.recordCompletedTurn(
        db,
        origin.id,
        "Create a task",
        "Awaiting approval",
        {
          provider: "fixture",
          model: "offline"
        },
        { activityRecords: [pending] }
      )
    );
    expect(recorded).toBeDefined();
    const before = recorded!.assistantMessage;
    await runner.withDataContext(owner, (db) =>
      repository.persistActionRecord(db, ids.userA, origin.id, terminal)
    );
    const after = (await read(origin.id)).find((message) => message.id === before.id)!;
    expect(after).toEqual({
      ...before,
      updated_at: expect.any(Date),
      tool_metadata: {
        selectedTools: [],
        activity: [pending, terminal],
        actionResults: [terminal]
      }
    });
    expect((await read(origin.id))[0]).toEqual(recorded!.userMessage);
  });

  it("absorbs a synthetic outcome into one visible reply while retaining the original row", async () => {
    const origin = await thread();
    await runner.withDataContext(owner, (db) =>
      repository.persistActionRecord(db, ids.userA, origin.id, terminal)
    );
    const synthetic = await read(origin.id);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({
      role: "assistant",
      status: "stored",
      body: "",
      model_metadata: {},
      tool_metadata: metadata()
    });
    const syntheticId = synthetic[0]!.id;
    expect(await readById(syntheticId)).toEqual(synthetic[0]);
    await runner.withDataContext(owner, (db) =>
      repository.recordCompletedTurn(
        db,
        origin.id,
        "Create a task",
        "Task created",
        {
          provider: "fixture",
          model: "offline"
        },
        { activityRecords: [pending] }
      )
    );
    const completed = await read(origin.id);
    expect(completed.map((message) => message.body)).toEqual(["Create a task", "Task created"]);
    expect(completed.some((message) => message.id === synthetic[0]!.id)).toBe(false);
    expect(completed[1]?.tool_metadata).toEqual({
      selectedTools: [],
      activity: [pending, terminal],
      actionResults: [terminal]
    });
    expect(await readById(syntheticId)).toBeUndefined();
    expect(await readById(completed[1]!.id)).toEqual(completed[1]);
    const raw = await readRaw(origin.id);
    expect(raw).toHaveLength(3);
    expect(raw).toEqual(
      expect.arrayContaining([
        ...completed,
        {
          ...synthetic[0],
          updated_at: expect.any(Date),
          tool_metadata: { ...metadata(), actionOutcomeHidden: true }
        }
      ])
    );
    await expect(remove(syntheticId)).rejects.toMatchObject({ code: "42501" });
    expect(await readRaw(origin.id)).toEqual(raw);
  });

  it.each(["executed", "denied", "error", "allowed"] as const)(
    "accepts a valid %s synthetic row and hides it through UPDATE without permitting deletion",
    async (outcome) => {
      const origin = await thread();
      const message = await insert(origin.id, {
        tool_metadata: metadata({ ...terminal, outcome })
      });
      expect(await read(origin.id)).toEqual([message]);
      expect(await readById(message.id)).toEqual(message);
      await expect(remove(message.id)).rejects.toMatchObject({ code: "42501" });
      const hidden = { ...metadata({ ...terminal, outcome }), actionOutcomeHidden: true };
      expect((await update(message.id, { tool_metadata: hidden })).numUpdatedRows).toBe(1n);
      expect(await read(origin.id)).toEqual([]);
      expect(await readById(message.id)).toBeUndefined();
      expect(await readRaw(origin.id)).toEqual([{ ...message, tool_metadata: hidden }]);
      await expect(remove(message.id)).rejects.toMatchObject({ code: "42501" });
    }
  );

  it("permits bounded typed optional terminal metadata and an empty terminal text", async () => {
    const origin = await thread();
    const record = {
      ...terminal,
      text: "",
      toolName: "t".repeat(120),
      summary: "s".repeat(200),
      reason: "r".repeat(500),
      decidedBy: "timeout",
      sequence: 1,
      durationMs: 30_000
    };
    const message = await insert(origin.id, { tool_metadata: metadata(record) });
    expect(message.tool_metadata).toEqual(metadata(record));
    const replacement = metadata({ ...record, text: "t".repeat(200), outcome: "denied" });
    expect(
      (await update(message.id, { tool_metadata: replacement, updated_at: now })).numUpdatedRows
    ).toBe(1n);
    expect((await read(origin.id))[0]?.tool_metadata).toEqual(replacement);
  });

  it.each(["person", "policy", "timeout", "cancelled"] as const)(
    "accepts the supported %s decision source",
    async (decidedBy) => {
      const origin = await thread();
      const message = await insert(origin.id, {
        tool_metadata: metadata({ ...terminal, decidedBy })
      });
      expect(message.tool_metadata).toEqual(metadata({ ...terminal, decidedBy }));
    }
  );

  it.each([
    ["body", { body: "Rewritten reply" }],
    ["model_metadata", { model_metadata: { executed: { provider: "fake", model: "fake" } } }],
    ["role", { role: "user" }],
    ["status", { status: "error" }],
    ["id", { id: "70000000-0000-4000-8000-000000000097" }],
    ["thread_id", { thread_id: "70000000-0000-4000-8000-000000000098" }],
    ["owner_user_id", { owner_user_id: ids.userB }],
    ["created_at", { created_at: new Date("2026-10-06T10:00:00.000Z") }]
  ] satisfies Array<[string, MessageUpdate]>)(
    "denies app UPDATE of %s at the column grant",
    async (_column, values) => {
      const origin = await thread();
      const message = await insert(origin.id, { body: "Original reply", tool_metadata: {} });
      await expect(update(message.id, values)).rejects.toMatchObject({ code: "42501" });
      expect(await read(origin.id)).toEqual([message]);
    }
  );

  it.each([true, "true", false])(
    "cannot delete a real reply after flagging its metadata with %s",
    async (marker) => {
      const origin = await thread();
      const message = await insert(origin.id, { body: "Keep this real reply", tool_metadata: {} });
      const marked = { ...metadata(), actionOutcomeOnly: marker };
      expect((await update(message.id, { tool_metadata: marked })).numUpdatedRows).toBe(1n);
      await expect(remove(message.id)).rejects.toMatchObject({ code: "42501" });
      expect(await read(origin.id)).toEqual([{ ...message, tool_metadata: marked }]);
      expect(await readById(message.id)).toEqual({ ...message, tool_metadata: marked });
    }
  );

  it.each([true, "true", false, null])(
    "cannot hide a real reply by setting actionOutcomeHidden to %s",
    async (actionOutcomeHidden) => {
      const origin = await thread();
      const message = await insert(origin.id, { body: "Keep this real reply", tool_metadata: {} });
      await expect(
        update(message.id, { tool_metadata: { ...metadata(), actionOutcomeHidden } })
      ).rejects.toMatchObject({ code: "23514" });
      expect(await read(origin.id)).toEqual([message]);
      expect(await readById(message.id)).toEqual(message);
      expect(await readRaw(origin.id)).toEqual([message]);
    }
  );

  it.each([
    ["user", "stored"],
    ["assistant", "pending"],
    ["assistant", "working"],
    ["assistant", "blocked"],
    ["assistant", "no_model"],
    ["assistant", "error"]
  ] as const)("cannot update or delete a %s/%s row", async (role, status) => {
    const origin = await thread();
    const message = await insert(origin.id, {
      role,
      status,
      body: "Retained message",
      tool_metadata: {}
    });
    expect(
      (await update(message.id, { tool_metadata: metadata(), updated_at: now })).numUpdatedRows
    ).toBe(0n);
    await expect(remove(message.id)).rejects.toMatchObject({ code: "42501" });
    expect(await read(origin.id)).toEqual([message]);
  });

  it.each([ids.userB, ids.adminUser])(
    "actor %s cannot mutate or forge another owner's synthetic row",
    async (actorUserId) => {
      const origin = await thread();
      const message = await insert(origin.id);
      expect(await read(origin.id, actorUserId)).toEqual([]);
      expect(
        (
          await update(
            message.id,
            { tool_metadata: metadata({ ...terminal, outcome: "denied" }) },
            actorUserId
          )
        ).numUpdatedRows
      ).toBe(0n);
      await expect(remove(message.id, actorUserId)).rejects.toMatchObject({ code: "42501" });
      // Make the parent visible so the forged insert reaches RLS instead of failing its context trigger.
      await runner.withDataContext(owner, (db) =>
        new SharesRepository().grant(db, {
          resourceType: "chat_thread",
          resourceId: origin.id,
          ownerUserId: ids.userA,
          granteeUserId: actorUserId,
          level: "manage"
        })
      );
      await expect(
        insert(origin.id, { owner_user_id: ids.userA }, actorUserId)
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await update(
            message.id,
            { tool_metadata: metadata({ ...terminal, outcome: "denied" }) },
            actorUserId
          )
        ).numUpdatedRows
      ).toBe(0n);
      await expect(remove(message.id, actorUserId)).rejects.toMatchObject({ code: "42501" });
      expect(await read(origin.id)).toEqual([message]);
    }
  );

  it("requires ownership of the parent, even for a manager's own message in a shared thread", async () => {
    const origin = await thread();
    await runner.withDataContext(owner, (db) =>
      new SharesRepository().grant(db, {
        resourceType: "chat_thread",
        resourceId: origin.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "manage"
      })
    );
    const message = await insert(origin.id, {}, ids.userB);
    expect(
      (
        await update(
          message.id,
          { tool_metadata: metadata({ ...terminal, outcome: "denied" }) },
          ids.userB
        )
      ).numUpdatedRows
    ).toBe(0n);
    await expect(remove(message.id, ids.userB)).rejects.toMatchObject({ code: "42501" });
    expect(await read(origin.id, ids.userB)).toEqual([message]);
  });

  it("denies metadata updates and cleanup beneath an incognito parent", async () => {
    const origin = await thread(true);
    // Existing INSERT permission can represent legacy rows; the repository itself skips private history.
    const synthetic = await insert(origin.id);
    const ordinary = await insert(origin.id, { body: "Legacy private reply", tool_metadata: {} });
    for (const message of [synthetic, ordinary]) {
      expect(
        (await update(message.id, { tool_metadata: metadata({ ...terminal, outcome: "denied" }) }))
          .numUpdatedRows
      ).toBe(0n);
      await expect(remove(message.id)).rejects.toMatchObject({ code: "42501" });
    }
    expect(await read(origin.id)).toEqual(expect.arrayContaining([synthetic, ordinary]));
  });

  it("preserves the worker's owner-scoped body/status updates without granting deletion", async () => {
    const origin = await thread();
    const message = await insert(origin.id, {
      body: "Pending reply",
      status: "pending",
      tool_metadata: {}
    });
    const values: MessageUpdate = {
      body: "Worker completed reply",
      status: "stored",
      model_metadata: { worker: true },
      tool_metadata: { activity: [terminal] },
      updated_at: now
    };
    expect((await update(message.id, values, ids.userA, workerRunner)).numUpdatedRows).toBe(1n);
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      expect(
        (await update(message.id, { body: "Foreign overwrite" }, actorUserId, workerRunner))
          .numUpdatedRows
      ).toBe(0n);
    }
    await expect(remove(message.id, ids.userA, workerRunner)).rejects.toMatchObject({
      code: "42501"
    });
    expect(await read(origin.id)).toEqual([{ ...message, ...values }]);
  });
});

const malformedMetadata: Array<[string, Record<string, unknown>]> = [
  ["missing marker", without(metadata(), "actionOutcomeOnly")],
  ["string marker", { ...metadata(), actionOutcomeOnly: "true" }],
  ["false marker", { ...metadata(), actionOutcomeOnly: false }],
  ["null marker", { ...metadata(), actionOutcomeOnly: null }],
  ["missing selectedTools", without(metadata(), "selectedTools")],
  ["nonempty selectedTools", { ...metadata(), selectedTools: ["tasks.create"] }],
  ["nonarray selectedTools", { ...metadata(), selectedTools: {} }],
  ["missing activity", without(metadata(), "activity")],
  ["null activity", { ...metadata(), activity: null, actionResults: null }],
  ["nonarray activity", { ...metadata(), activity: terminal, actionResults: terminal }],
  ["empty activity", { ...metadata(), activity: [], actionResults: [] }],
  [
    "multiple activity entries",
    { ...metadata(), activity: [terminal, terminal], actionResults: [terminal, terminal] }
  ],
  ["missing actionResults", without(metadata(), "actionResults")],
  ["null actionResults", { ...metadata(), actionResults: null }],
  ["nonarray actionResults", { ...metadata(), actionResults: terminal }],
  ["empty actionResults", { ...metadata(), actionResults: [] }],
  [
    "different actionResults",
    { ...metadata(), actionResults: [{ ...terminal, outcome: "denied" }] }
  ],
  ["unknown top-level key", { ...metadata(), extra: true }],
  ["top-level raw result", { ...metadata(), result: { private: "payload" } }],
  ["top-level preview", { ...metadata(), preview: "private preview" }],
  ["string hidden marker", { ...metadata(), actionOutcomeHidden: "true" }],
  ["false hidden marker", { ...metadata(), actionOutcomeHidden: false }],
  ["null hidden marker", { ...metadata(), actionOutcomeHidden: null }],
  ["numeric hidden marker", { ...metadata(), actionOutcomeHidden: 1 }],
  ["object hidden marker", { ...metadata(), actionOutcomeHidden: {} }],
  ["array hidden marker", { ...metadata(), actionOutcomeHidden: [] }]
];

const malformedRecords: Array<[string, unknown]> = [
  ["null event", null],
  ["string event", "action_result"],
  ["array event", []],
  ["empty event", {}],
  ["missing kind", without({ ...terminal }, "kind")],
  ["wrong kind", { ...terminal, kind: "action_request" }],
  ["missing id", without({ ...terminal }, "actionRequestId")],
  ["empty id", { ...terminal, actionRequestId: "" }],
  ["whitespace id", { ...terminal, actionRequestId: "   " }],
  ["numeric id", { ...terminal, actionRequestId: 1 }],
  ["null id", { ...terminal, actionRequestId: null }],
  ["missing text", without({ ...terminal }, "text")],
  ["numeric text", { ...terminal, text: 1 }],
  ["null text", { ...terminal, text: null }],
  ["long text", { ...terminal, text: "x".repeat(201) }],
  ["missing outcome", without({ ...terminal }, "outcome")],
  ["invalid outcome", { ...terminal, outcome: "pending" }],
  ["null outcome", { ...terminal, outcome: null }],
  ["numeric outcome", { ...terminal, outcome: 1 }],
  ["raw result", { ...terminal, result: { private: "payload" } }],
  ["preview", { ...terminal, preview: "private preview" }],
  ["unknown key", { ...terminal, extra: true }],
  ["numeric toolName", { ...terminal, toolName: 1 }],
  ["null toolName", { ...terminal, toolName: null }],
  ["long toolName", { ...terminal, toolName: "t".repeat(121) }],
  ["numeric summary", { ...terminal, summary: 1 }],
  ["null summary", { ...terminal, summary: null }],
  ["long summary", { ...terminal, summary: "s".repeat(201) }],
  ["numeric reason", { ...terminal, reason: 1 }],
  ["null reason", { ...terminal, reason: null }],
  ["long reason", { ...terminal, reason: "r".repeat(501) }],
  ["invalid decidedBy", { ...terminal, decidedBy: "admin" }],
  ["numeric decidedBy", { ...terminal, decidedBy: 1 }],
  ["null decidedBy", { ...terminal, decidedBy: null }],
  ["string sequence", { ...terminal, sequence: "1" }],
  ["null sequence", { ...terminal, sequence: null }],
  ["string durationMs", { ...terminal, durationMs: "1" }],
  ["null durationMs", { ...terminal, durationMs: null }]
];

describe("chat action-only empty-body CHECK (0297)", () => {
  it.each([
    ...malformedMetadata,
    ...malformedRecords.map(([name, record]): [string, Record<string, unknown>] => [
      name,
      metadata(record)
    ])
  ])("rejects malformed empty-body metadata: %s", async (_name, tool_metadata) => {
    const origin = await thread();
    await expect(insert(origin.id, { tool_metadata })).rejects.toMatchObject({ code: "23514" });
    expect(await read(origin.id)).toEqual([]);
  });

  it.each([
    ["empty user message", { role: "user" }],
    ["pending assistant", { status: "pending" }],
    ["working assistant", { status: "working" }],
    ["blocked assistant", { status: "blocked" }],
    ["no-model assistant", { status: "no_model" }],
    ["error assistant", { status: "error" }],
    ["whitespace body", { body: "   " }],
    [
      "fabricated model metadata",
      { model_metadata: { executed: { provider: "fake", model: "fake" } } }
    ]
  ] satisfies Array<[string, Partial<MessageInsert>]>)(
    "rejects %s even with otherwise valid synthetic metadata",
    async (_name, values) => {
      const origin = await thread();
      await expect(insert(origin.id, values)).rejects.toMatchObject({ code: "23514" });
      expect(await read(origin.id)).toEqual([]);
    }
  );

  it.each([
    ["ordinary assistant", { body: "Real assistant reply" }],
    ["ordinary user", { role: "user", body: "Real user message" }],
    ["empty user", { role: "user" }],
    ["pending assistant", { status: "pending" }],
    ["working assistant", { status: "working" }],
    ["blocked assistant", { status: "blocked" }],
    ["no-model assistant", { status: "no_model" }],
    ["error assistant", { status: "error" }],
    ["whitespace body", { body: "   " }],
    ["nonempty model metadata", { model_metadata: { existing: true } }],
    [
      "missing synthetic marker",
      { tool_metadata: { ...without(metadata(), "actionOutcomeOnly"), actionOutcomeHidden: true } }
    ],
    [
      "non-synthetic marker",
      { tool_metadata: { ...metadata(), actionOutcomeOnly: false, actionOutcomeHidden: true } }
    ],
    ["missing terminal metadata", { tool_metadata: { actionOutcomeHidden: true } }]
  ] satisfies Array<[string, Partial<MessageInsert>]>)(
    "rejects a hidden marker on %s",
    async (_name, values) => {
      const origin = await thread();
      await expect(
        insert(origin.id, {
          tool_metadata: { ...metadata(), actionOutcomeHidden: true },
          ...values
        })
      ).rejects.toMatchObject({ code: "23514" });
      expect(await readRaw(origin.id)).toEqual([]);
    }
  );

  it.each([
    ["string", "true"],
    ["false", false],
    ["null", null],
    ["number", 1],
    ["object", {}],
    ["array", []]
  ])(
    "rejects a %s hidden marker on UPDATE without hiding or changing history",
    async (_name, actionOutcomeHidden) => {
      const origin = await thread();
      const message = await insert(origin.id);
      await expect(
        update(message.id, { tool_metadata: { ...metadata(), actionOutcomeHidden } })
      ).rejects.toMatchObject({ code: "23514" });
      expect(await read(origin.id)).toEqual([message]);
      expect(await readById(message.id)).toEqual(message);
      expect(await readRaw(origin.id)).toEqual([message]);
    }
  );

  it("also rejects invalid metadata on UPDATE without damaging the valid synthetic row", async () => {
    const origin = await thread();
    const message = await insert(origin.id);
    await expect(
      update(message.id, { tool_metadata: metadata({ ...terminal, result: "raw payload" }) })
    ).rejects.toMatchObject({ code: "23514" });
    expect(await read(origin.id)).toEqual([message]);
  });

  it("retains ordinary nonempty user and assistant rows without imposing synthetic metadata", async () => {
    const origin = await thread();
    for (const role of ["user", "assistant"] as const) {
      const message = await insert(origin.id, {
        role,
        body: "Ordinary stored text",
        model_metadata: { existing: true },
        tool_metadata: { selectedTools: [], activity: [pending] }
      });
      expect(message.body).toBe("Ordinary stored text");
    }
    expect(await read(origin.id)).toHaveLength(2);
  });
});
