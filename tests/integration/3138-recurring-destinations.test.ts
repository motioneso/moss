import { describe, expect, it } from "vitest";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { editReminderById } from "../../packages/chat/src/reminders/edit.js";
import { readReminderRuns } from "../../packages/chat/src/reminders/runs.js";
import { runScheduledReadJob } from "../../packages/chat/src/scheduled-reads/runner.js";
import { ids } from "./test-database.js";
import {
  app,
  worker,
  boss,
  bootstrap,
  owner,
  save,
  chat,
  gateway,
  generateReport,
  tasks
} from "./scheduled-read-fixture.js";

const reminders = new ReminderRepository();
type Saved = Awaited<ReturnType<typeof save>>;
async function due(saved: Saved) {
  // Clock setup is confined to the gate database; restore triggers before running the worker.
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      "UPDATE app.chat_reminders SET due_at = now() - interval '2 seconds' WHERE id = $1",
      [saved.id]
    );
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
  const row = await owner((db) =>
    db.db
      .selectFrom("app.chat_reminders")
      .select("version")
      .where("id", "=", saved.id)
      .executeTakeFirstOrThrow()
  );
  return { ...saved.data, version: row.version };
}
async function move(saved: Saved, title: string) {
  const row = await owner((db) =>
    db.db
      .selectFrom("app.chat_reminders")
      .select("version")
      .where("id", "=", saved.id)
      .executeTakeFirstOrThrow()
  );
  expect(
    await owner((db) =>
      editReminderById(
        db,
        boss,
        ids.userA,
        saved.id,
        row.version,
        {
          text: null,
          delaySeconds: null,
          localDue: null,
          deadline: "keep",
          localDeadline: null,
          destination: title
        },
        "UTC",
        saved.threadId
      )
    )
  ).toMatchObject({ kind: "changed" });
}

describe("composed recurring read destinations", () => {
  it.each(["delivered", "failed", "refused"] as const)(
    "keeps %s history, notification and pending context in the original conversation after moving",
    async (outcome) => {
      const saved = await save(true);
      const target = await owner((db) => chat.openNewThread(db, { title: `Recurring ${outcome}` }));
      const deps = { dataContext: worker, boss, gateway: gateway(), generateReport };
      if (outcome === "delivered") {
        expect(await runScheduledReadJob({ data: await due(saved) }, deps)).toBe("quiet");
        await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
        expect(await runScheduledReadJob({ data: await due(saved) }, deps)).toBe("success");
      } else {
        const failing = {
          ...deps,
          gateway: {
            runBackgroundReadForActor: async () => ({
              ok: false as const,
              error: "Unavailable",
              ...(outcome === "failed" ? { failureKind: "read" as const } : {})
            })
          }
        };
        for (let i = 0; i < 3; i++)
          expect(await runScheduledReadJob({ data: await due(saved) }, failing)).toBe(outcome);
      }
      const runs = await owner((db) => readReminderRuns(db, saved.id));
      const message = runs.find((run) => run.outcome === outcome && run.message)?.message;
      expect(message).toBeTruthy();
      expect(message!.threadId).toBe(saved.threadId);
      await move(saved, target.title!);
      expect(
        (await owner((db) => readReminderRuns(db, saved.id))).find(
          (run) => run.message?.id === message!.id
        )?.message
      ).toEqual(message);
      expect(
        await owner((db) => reminders.readNotificationResult(db, saved.id, message!.id))
      ).toMatchObject({ messageId: message!.id, body: message!.body });
      expect(
        (await owner((db) => reminders.listPendingMain(db, saved.threadId, 20))).map(
          (row) => row.reservedMessageId
        )
      ).toContain(message!.id);
      expect(
        (await owner((db) => reminders.listPendingMain(db, target.id, 20))).map(
          (row) => row.reservedMessageId
        )
      ).not.toContain(message!.id);
      await app.withDataContext({ actorUserId: ids.userB }, (db) =>
        reminders.acknowledgeMain(db, saved.threadId, [message!.id])
      );
      await owner((db) => reminders.acknowledgeMain(db, target.id, [message!.id]));
      expect(
        (await owner((db) => reminders.listPendingMain(db, saved.threadId, 20))).map(
          (row) => row.reservedMessageId
        )
      ).toContain(message!.id);
      await owner((db) => reminders.acknowledgeMain(db, saved.threadId, [message!.id]));
      expect(
        (await owner((db) => reminders.listPendingMain(db, saved.threadId, 20))).map(
          (row) => row.reservedMessageId
        )
      ).not.toContain(message!.id);
      await owner((db) => tasks.update(db, saved.task.id, { title: "Changed after moving" }));
      // A failed check has no baseline yet, so its first healthy run is quiet.
      if (outcome !== "delivered") {
        expect(await runScheduledReadJob({ data: await due(saved) }, deps)).toBe("quiet");
        await owner((db) => tasks.update(db, saved.task.id, { title: "Second healthy change" }));
      }
      expect(await runScheduledReadJob({ data: await due(saved) }, deps)).toBe("success");
      expect(
        (await owner((db) => readReminderRuns(db, saved.id))).find(
          (run) => run.message && run.message.id !== message!.id
        )?.message?.threadId
      ).toBe(target.id);
      await owner((db) =>
        db.db.deleteFrom("app.chat_reminders").where("id", "=", saved.id).execute()
      );
    }
  );

  it("discards a recurring report when its destination disappears during the final source read", async () => {
    const saved = await save(true);
    const target = await owner((db) => chat.openNewThread(db, { title: "Lost recurring target" }));
    await move(saved, target.title!);
    const real = gateway();
    const deps = { dataContext: worker, boss, gateway: real, generateReport };
    expect(await runScheduledReadJob({ data: await due(saved) }, deps)).toBe("quiet");
    await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
    let reads = 0;
    const source = async (...args: Parameters<typeof real.runBackgroundReadForActor>) => {
      const result = await real.runBackgroundReadForActor(...args);
      if (++reads === 2)
        await bootstrap.query("DELETE FROM app.chat_threads WHERE id = $1", [target.id]);
      return result;
    };
    expect(
      await runScheduledReadJob(
        { data: await due(saved) },
        { ...deps, gateway: { runBackgroundReadForActor: source } }
      )
    ).toBe("inactive");
    expect(reads).toBe(2);
    expect((await owner((db) => reminders.readState(db, saved.id)))?.state).toBe("failed");
    expect(
      (await owner((db) => readReminderRuns(db, saved.id))).every((run) => run.message === null)
    ).toBe(true);
  });
});
