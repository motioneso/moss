import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SharesRepository } from "@moss/db";
import { serializeMessage } from "../../packages/chat/src/route-serializers.js";
import {
  registerScheduledReadWorker,
  runScheduledReadJob
} from "../../packages/chat/src/scheduled-reads/runner.js";
import { CHAT_SCHEDULED_READ_QUEUE } from "../../packages/chat/src/scheduled-reads/queue.js";
import {
  pauseReminderById,
  resumeReminderById,
  deleteReminderById
} from "../../packages/chat/src/reminders/controls.js";
import { listScheduledReminders } from "../../packages/chat/src/reminders/settings.js";
import { editReminderById } from "../../packages/chat/src/reminders/edit.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { saveScheduledOperation } from "../../packages/chat/src/scheduled-reads/repository.js";
import { readScheduledOperation } from "../../packages/chat/src/scheduled-reads/repository.js";
import { ids } from "./test-database.js";
import {
  app,
  worker,
  boss,
  workerBoss,
  bootstrap,
  chat,
  tasks,
  owner,
  save,
  message,
  gateway,
  setTasksDisabled,
  generateReport
} from "./scheduled-read-fixture.js";
describe("scheduled reads through the actor worker and real gateway", () => {
  it("posts model prose once after rechecking access", async () => {
    const saved = await save();
    let calls = 0;
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          boss,
          gateway: gateway(),
          generateReport: async () => {
            calls++;
            return { ok: true, text: "Model-written task report.\n\n[Source: Tasks](/tasks)" };
          }
        }
      )
    ).toBe("success");
    expect(calls).toBe(1);
    expect(
      (await owner((db) => chat.listMessages(db, saved.threadId))).filter((m) =>
        m.body.startsWith("Model-written")
      )
    ).toHaveLength(1);
  });
  it("requeues time edits on the source-read queue and refuses text edits", async () => {
    const saved = await save();
    const keep = {
      text: null,
      delaySeconds: null,
      localDue: null,
      deadline: "keep",
      localDeadline: null
    } as const;
    const moved = await owner((db) =>
      editReminderById(db, boss, ids.userA, saved.id, 1, { ...keep, delaySeconds: 60 }, "UTC")
    );
    expect(moved.kind).toBe("changed");
    const jobs = await bootstrap.query(
      "SELECT name, data FROM pgboss.job WHERE data->>'resourceId' = $1 AND data->>'version' = '2'",
      [saved.id]
    );
    expect(jobs.rows).toEqual([
      { name: CHAT_SCHEDULED_READ_QUEUE, data: { ...saved.data, version: 2 } }
    ]);
    expect(await owner((db) => readScheduledOperation(db, saved.id))).toMatchObject({
      operation: "tasks.get",
      item_id: saved.task.id
    });
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        { dataContext: worker, boss, generateReport, gateway: gateway() }
      )
    ).toBe("inactive");
    const textEdit = await owner((db) =>
      editReminderById(
        db,
        boss,
        ids.userA,
        saved.id,
        2,
        { ...keep, text: "check a different task" },
        "UTC"
      )
    );
    expect(textEdit).toEqual({
      kind: "invalid",
      reply:
        "A task check's source is fixed. You can change its time, but not its text. Nothing changed."
    });
    const row = await owner((db) =>
      db.db
        .selectFrom("app.chat_reminders")
        .select(["version", "reminder_text"])
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(row).toEqual({ version: 2, reminder_text: `Check task status: ${saved.task.title}` });
  });
  it("supports bounded repeat edits on task checks and invalidates old jobs", async () => {
    const saved = await save();
    const result = await owner((db) =>
      editReminderById(
        db,
        boss,
        ids.userA,
        saved.id,
        1,
        {
          text: null,
          delaySeconds: 60,
          localDue: null,
          deadline: "keep",
          localDeadline: null,
          repeat: { kind: "interval", seconds: 60 }
        },
        "UTC"
      )
    );
    expect(result).toMatchObject({ kind: "changed" });
    expect(
      await owner((db) =>
        db.db
          .selectFrom("app.chat_reminders")
          .select(["version", "repeat_kind"])
          .where("id", "=", saved.id)
          .executeTakeFirstOrThrow()
      )
    ).toEqual({ version: 2, repeat_kind: "interval" });
  });
  it("database permits a validated recurrence edit on an existing exact check", async () => {
    const saved = await save();
    await expect(
      owner((db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ repeat_kind: "interval", repeat_seconds: 60, version: 2 })
          .where("id", "=", saved.id)
          .execute()
      )
    ).resolves.toBeDefined();
  });
  it("database permits an exact source extension on a valid repeating reminder", async () => {
    const saved = await save();
    const repeating = await owner(async (db) => {
      const source = await db.db
        .insertInto("app.chat_messages")
        .values({
          id: randomUUID(),
          thread_id: saved.threadId,
          owner_user_id: ids.userA,
          role: "user",
          status: "stored",
          body: "remind me every minute to stretch",
          model_metadata: {},
          tool_metadata: {}
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return new ReminderRepository().create(db, {
        threadId: saved.threadId,
        sourceMessageId: source.id,
        text: "fixed reminder",
        when: { timing: "relative", delaySeconds: 60, repeat: { kind: "interval", seconds: 60 } }
      });
    });
    await expect(
      owner((db) => saveScheduledOperation(db, repeating.id, saved.task.id))
    ).resolves.toBeUndefined();
  });
  it("keeps frozen storage immutable and hides another owner's responsibility", async () => {
    const saved = await save();
    const row = await owner((db) =>
      db.db
        .selectFrom("app.chat_scheduled_reads")
        .selectAll()
        .where("reminder_id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(row).toMatchObject({
      operation: "tasks.get",
      item_id: saved.task.id,
      owner_user_id: ids.userA
    });
    expect(
      await app.withDataContext({ actorUserId: ids.userB }, (db) =>
        db.db
          .selectFrom("app.chat_scheduled_reads")
          .selectAll()
          .where("reminder_id", "=", saved.id)
          .execute()
      )
    ).toEqual([]);
    await expect(
      worker.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .updateTable("app.chat_scheduled_reads")
          .set({ item_id: randomUUID() })
          .where("reminder_id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      owner((db) =>
        db.db
          .updateTable("app.chat_scheduled_reads")
          .set({ outcome: "success" })
          .where("reminder_id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/permission denied/);
    expect(
      await runScheduledReadJob(
        { data: { ...saved.data, actorUserId: ids.userB } },
        { dataContext: worker, boss, generateReport, gateway: gateway() }
      )
    ).toBe("inactive");
  });
  it("queues metadata, reports actual current status once and supports Settings", async () => {
    const saved = await save();
    const jobs = await bootstrap.query(
      "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'resourceId' = $2",
      [CHAT_SCHEDULED_READ_QUEUE, saved.id]
    );
    expect(jobs.rows.map((row) => row.data)).toEqual([saved.data]);
    await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
    const deps = { dataContext: worker, boss, generateReport, gateway: gateway() };
    expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("success");
    expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("inactive");
    const messages = await message(saved);
    expect(
      messages.filter((m) => serializeMessage(m).scheduledReadSource === "tasks")
    ).toHaveLength(1);
    expect(
      messages.filter(
        (m) => m.body.includes("Its status is done") && m.body.includes("[Source: Tasks]")
      )
    ).toHaveLength(1);
    expect(
      (await owner(listScheduledReminders)).find((r) => r.id === saved.id)?.runs[0]?.message
    ).toMatchObject({
      body: expect.stringContaining("Its status is done"),
      scheduledReadSource: "tasks"
    });
  });
  it("reports disabled capability as refusal without disclosing source data", async () => {
    const saved = await save();
    await setTasksDisabled(true);
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        { dataContext: worker, boss, generateReport, gateway: gateway() }
      )
    ).toBe("refused");
    expect((await owner(listScheduledReminders)).find((r) => r.id === saved.id)).toMatchObject({
      state: "failed"
    });
    expect(
      (await owner((db) => chat.listMessages(db, saved.threadId))).filter((m) =>
        m.body.includes("access is no longer available")
      )
    ).toHaveLength(1);
    await setTasksDisabled(false);
  });
  it("denies foreign shared items at the real source guard", async () => {
    const task = await app.withDataContext({ actorUserId: ids.userB }, async (db) => {
      const item = await tasks.create(db, { title: "Foreign private title" });
      await new SharesRepository().grant(db, {
        resourceType: "task",
        resourceId: item.id,
        ownerUserId: ids.userB,
        granteeUserId: ids.userA,
        level: "view"
      });
      return item;
    });
    expect(await owner((db) => tasks.getById(db, task.id))).toBeDefined();
    expect(
      await gateway().runBackgroundReadForActor(ids.userA, {
        operation: "tasks.get",
        input: { taskId: task.id },
        runId: "foreign"
      })
    ).toMatchObject({ ok: false });
  });
  it("resume keeps read queue routing and invalidates the old version", async () => {
    const saved = await save();
    await owner((db) => pauseReminderById(db, saved.id));
    await owner((db) => resumeReminderById(db, boss, ids.userA, saved.id));
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        { dataContext: worker, boss, generateReport, gateway: gateway() }
      )
    ).toBe("inactive");
    const jobs = await bootstrap.query(
      "SELECT name FROM pgboss.job WHERE data->>'resourceId' = $1",
      [saved.id]
    );
    expect(jobs.rows.every((row) => row.name === CHAT_SCHEDULED_READ_QUEUE)).toBe(true);
  });
  it("deletion during a read prevents persistence", async () => {
    const saved = await save();
    const real = gateway();
    const before = (await owner((db) => chat.listMessages(db, saved.threadId))).length;
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          boss,
          generateReport,
          gateway: {
            async runBackgroundReadForActor(actor, read) {
              const result = await real.runBackgroundReadForActor(actor, read);
              await owner((db) => deleteReminderById(db, saved.id));
              return result;
            }
          }
        }
      )
    ).toBe("inactive");
    expect((await owner((db) => chat.listMessages(db, saved.threadId))).length).toBe(before);
  });
  it("retries quietly then records exhausted failure as a normal result", async () => {
    const saved = await save();
    const deps = {
      dataContext: worker,
      boss,
      generateReport,
      gateway: {
        async runBackgroundReadForActor() {
          return {
            ok: false as const,
            error: "Tool tasks.get failed",
            failureKind: "read" as const,
            retryable: true as const
          };
        }
      }
    };
    const before = (await owner((db) => chat.listMessages(db, saved.threadId))).length;
    await expect(
      runScheduledReadJob({ data: saved.data, retryCount: 0, retryLimit: 2 }, deps)
    ).rejects.toThrow("temporarily failed");
    expect((await owner((db) => chat.listMessages(db, saved.threadId))).length).toBe(before);
    expect(
      await runScheduledReadJob({ data: saved.data, retryCount: 2, retryLimit: 2 }, deps)
    ).toBe("failed");
    expect((await owner(listScheduledReminders)).find((r) => r.id === saved.id)).toMatchObject({
      state: "failed"
    });
  });
  it("delivers through the registered queue worker and notification enqueue", async () => {
    const saved = await save();
    await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
    await registerScheduledReadWorker(workerBoss, {
      dataContext: worker,
      boss,
      generateReport,
      gateway: gateway(true)
    });
    const states: unknown[] = [];
    await expect
      .poll(
        async () => {
          const jobs = await bootstrap.query(
            "SELECT state, output FROM pgboss.job WHERE name = $1 AND data->>'resourceId' = $2",
            [CHAT_SCHEDULED_READ_QUEUE, saved.id]
          );
          states.splice(0, states.length, ...jobs.rows);
          return {
            jobs: jobs.rows,
            delivered: (await message(saved)).some((m) => m.body.includes("Its status is done"))
          };
        },
        { timeout: 20_000 }
      )
      .toMatchObject({ delivered: true })
      .catch((error: unknown) => {
        throw new Error(`Queue did not deliver: ${JSON.stringify(states)}`, { cause: error });
      });
  });
});
