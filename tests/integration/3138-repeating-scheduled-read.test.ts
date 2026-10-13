import { describe, expect, it, vi } from "vitest";
import { runScheduledReadJob } from "../../packages/chat/src/scheduled-reads/runner.js";
import { listScheduledReminders } from "../../packages/chat/src/reminders/settings.js";
import {
  pauseReminderById,
  deleteReminderById
} from "../../packages/chat/src/reminders/controls.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { ids } from "./test-database.js";
import {
  worker,
  boss,
  bootstrap,
  owner,
  save,
  tasks,
  chat,
  gateway,
  generateReport
} from "./scheduled-read-fixture.js";

type Saved = Awaited<ReturnType<typeof save>>;
async function nextRun(saved: Saved, stopAfterSeconds?: number) {
  // Deterministic clock setup is confined to the gate's throwaway DB and restores normal triggers.
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      `UPDATE app.chat_reminders SET due_at = now() - interval '2 seconds'
      ${stopAfterSeconds === undefined ? "" : ", deadline_at = now() + interval '5 seconds'"}
      WHERE id = $1`,
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
  return { actorUserId: ids.userA, resourceId: saved.id, version: row.version };
}
async function history(saved: Saved) {
  return (await owner(listScheduledReminders)).find((t) => t.id === saved.id)!;
}

describe("requested recurring exact Tasks reads", () => {
  it.each([
    { observation_key: "a".repeat(64), failure_streak: 0 },
    { observation_key: null, failure_streak: 3 }
  ])("app runtime cannot forge observation authority at creation", async (forged) => {
    const saved = await save(true);
    // Disposable owner source extension is removed only by gate bootstrap to probe real INSERT RLS.
    await bootstrap.query("DELETE FROM app.chat_scheduled_reads WHERE reminder_id = $1", [
      saved.id
    ]);
    await expect(
      owner((db) =>
        db.db
          .insertInto("app.chat_scheduled_reads")
          .values({
            reminder_id: saved.id,
            owner_user_id: ids.userA,
            operation: "tasks.get",
            item_id: saved.task.id,
            outcome: null,
            ...forged
          })
          .execute()
      )
    ).rejects.toThrow(/row.level security/i);
  });
  it("another owner cannot inspect or execute the recurring source", async () => {
    const saved = await save(true);
    const source = vi.fn(gateway().runBackgroundReadForActor.bind(gateway()));
    expect(
      await runScheduledReadJob(
        { data: { ...saved.data, actorUserId: ids.userB } },
        {
          dataContext: worker,
          boss,
          gateway: { runBackgroundReadForActor: source },
          generateReport
        }
      )
    ).toBe("inactive");
    expect(source).not.toHaveBeenCalled();
    expect((await history(saved)).runs).toHaveLength(0);
  });
  it("a source changed between baseline reads never becomes a quiet success", async () => {
    const saved = await save(true);
    const real = gateway();
    let count = 0;
    const source = async (...args: Parameters<typeof real.runBackgroundReadForActor>) => {
      const response = await real.runBackgroundReadForActor(...args);
      if (++count === 1) await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
      return response;
    };
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          boss,
          gateway: { runBackgroundReadForActor: source },
          generateReport
        }
      )
    ).toBe("failed");
    expect((await history(saved)).runs[0]).toMatchObject({ outcome: "failed", message: null });
    const state = await owner((db) =>
      db.db
        .selectFrom("app.chat_scheduled_reads")
        .select(["observation_key", "failure_streak"])
        .where("reminder_id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(state).toEqual({ observation_key: null, failure_streak: 1 });
  });
  it("title-only novelty reports once without timestamp or model wording identity", async () => {
    const saved = await save(true);
    const model = vi.fn(generateReport);
    const deps = { dataContext: worker, boss, gateway: gateway(), generateReport: model };
    await runScheduledReadJob({ data: saved.data }, deps);
    await owner((db) => tasks.update(db, saved.task.id, { title: "Revised proof title" }));
    expect(await runScheduledReadJob({ data: await nextRun(saved) }, deps)).toBe("success");
    expect(await runScheduledReadJob({ data: await nextRun(saved) }, deps)).toBe("quiet");
    expect(model).toHaveBeenCalledTimes(1);
  });
  it("a failed report preserves the observation baseline and reports the still-pending change later", async () => {
    const saved = await save(true);
    const deps = { dataContext: worker, boss, gateway: gateway(), generateReport };
    await runScheduledReadJob({ data: saved.data }, deps);
    const before = await owner((db) =>
      db.db
        .selectFrom("app.chat_scheduled_reads")
        .select("observation_key")
        .where("reminder_id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
    expect(
      await runScheduledReadJob(
        { data: await nextRun(saved) },
        {
          ...deps,
          generateReport: async () => ({ ok: false as const, reason: "failed" as const })
        }
      )
    ).toBe("failed");
    const failed = await owner((db) =>
      db.db
        .selectFrom("app.chat_scheduled_reads")
        .select("observation_key")
        .where("reminder_id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(failed).toEqual(before);
    expect(await runScheduledReadJob({ data: await nextRun(saved) }, deps)).toBe("success");
    expect((await history(saved)).runs.filter((r) => r.message !== null)).toHaveLength(1);
  });
  it("quiet baseline, one meaningful sourced change, then unchanged quiet success", async () => {
    const saved = await save(true);
    const model = vi.fn(generateReport);
    const deps = { dataContext: worker, boss, gateway: gateway(), generateReport: model };
    expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("quiet");
    expect(model).not.toHaveBeenCalled();
    expect((await history(saved)).runs[0]).toMatchObject({ outcome: "quiet", message: null });
    await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
    const changed = await nextRun(saved);
    expect(await runScheduledReadJob({ data: changed }, deps)).toBe("success");
    expect(await runScheduledReadJob({ data: changed }, deps)).toBe("inactive");
    expect(model).toHaveBeenCalledTimes(1);
    const report = (await history(saved)).runs.find((r) => r.outcome === "delivered")?.message;
    expect(report).toMatchObject({ scheduledReadSource: "tasks" });
    expect(report?.body).toContain("done");
    expect(await runScheduledReadJob({ data: await nextRun(saved) }, deps)).toBe("quiet");
    expect(model).toHaveBeenCalledTimes(1);
    expect((await history(saved)).runs.map((r) => r.outcome).sort()).toEqual([
      "delivered",
      "quiet",
      "quiet"
    ]);
  });
  it("concurrent baseline and duplicate job cannot repeat a run or model call", async () => {
    const saved = await save(true);
    const model = vi.fn(generateReport);
    const deps = { dataContext: worker, boss, gateway: gateway(), generateReport: model };
    expect(
      (
        await Promise.all([
          runScheduledReadJob({ data: saved.data }, deps),
          runScheduledReadJob({ data: saved.data }, deps)
        ])
      ).sort()
    ).toEqual(["inactive", "quiet"]);
    expect((await history(saved)).runs).toHaveLength(1);
    expect(model).not.toHaveBeenCalled();
  });
  it("quiet per-run retries, honest failures, one threshold message and recovery reset", async () => {
    const saved = await save(true);
    const source = vi.fn(async () => ({
      ok: false as const,
      failureKind: "read" as const,
      retryable: true as const,
      error: "private dependency content"
    }));
    const model = vi.fn(generateReport);
    const deps = {
      dataContext: worker,
      boss,
      gateway: { runBackgroundReadForActor: source },
      generateReport: model
    };
    const before = (await owner((db) => chat.listMessages(db, saved.threadId))).length;
    await expect(
      runScheduledReadJob({ data: saved.data, retryCount: 0, retryLimit: 2 }, deps)
    ).rejects.toThrow("temporarily failed");
    expect((await history(saved)).runs).toHaveLength(0);
    for (let i = 0; i < 5; i++) {
      const data = i === 0 ? saved.data : await nextRun(saved);
      expect(await runScheduledReadJob({ data, retryCount: 2, retryLimit: 2 }, deps)).toBe(
        "failed"
      );
    }
    const failed = await history(saved);
    expect(failed.state).toBe("active");
    expect(failed.checkFailure).toContain("saved cadence");
    expect(failed.runs).toHaveLength(5);
    expect(failed.runs.filter((r) => r.message !== null)).toHaveLength(1);
    const message = failed.runs.find((r) => r.message !== null)!.message!;
    const notification = await owner((db) =>
      new ReminderRepository().readNotificationResult(db, saved.id, message.id)
    );
    expect(notification?.messageId).toBe(message.id);
    const pending = await owner((db) =>
      new ReminderRepository().listPendingMain(db, saved.threadId, 100)
    );
    expect(pending.some((r) => r.reservedMessageId === message.id)).toBe(true);

    expect(failed.runs.every((r) => r.outcome === "failed")).toBe(true);
    expect((await owner((db) => chat.listMessages(db, saved.threadId))).length).toBe(before + 1);
    expect(model).not.toHaveBeenCalled();
    const real = { ...deps, gateway: gateway() };
    expect(await runScheduledReadJob({ data: await nextRun(saved) }, real)).toBe("quiet");
    expect((await history(saved)).checkFailure).toBeUndefined();
    const state = await owner((db) =>
      db.db
        .selectFrom("app.chat_scheduled_reads")
        .select("failure_streak")
        .where("reminder_id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(state.failure_streak).toBe(0);
  });
  it("repeated source refusals post once with actionable status and no private source data", async () => {
    const saved = await save(true);
    const deps = {
      dataContext: worker,
      boss,
      generateReport,
      gateway: {
        runBackgroundReadForActor: async () => ({
          ok: false as const,
          denied: true as const,
          reason: "private source details"
        })
      }
    };
    for (let n = 0; n < 4; n++)
      expect(
        await runScheduledReadJob({ data: n === 0 ? saved.data : await nextRun(saved) }, deps)
      ).toBe("refused");
    const task = await history(saved);
    expect(task.state).toBe("active");
    expect(task.checkFailure).toContain("Restore Tasks access");
    expect(task.runs.every((r) => r.outcome === "refused")).toBe(true);
    const messages = task.runs.flatMap((r) => (r.message ? [r.message] : []));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).not.toContain(saved.task.title);
    expect(messages[0]!.body).not.toContain("private source details");
    expect(messages[0]!.scheduledReadSource).toBeUndefined();
    expect(
      (
        await owner((db) =>
          new ReminderRepository().readNotificationResult(db, saved.id, messages[0]!.id)
        )
      )?.messageId
    ).toBe(messages[0]!.id);
  });
  it.each(["pause", "delete"])(
    "%s between reads prevents baseline/history/advancement",
    async (action) => {
      const saved = await save(true);
      const real = gateway();
      let reads = 0;
      const source = async (...args: Parameters<typeof real.runBackgroundReadForActor>) => {
        const response = await real.runBackgroundReadForActor(...args);
        if (++reads === 2)
          await owner((db) =>
            action === "pause" ? pauseReminderById(db, saved.id) : deleteReminderById(db, saved.id)
          );
        return response;
      };
      expect(
        await runScheduledReadJob(
          { data: saved.data },
          {
            dataContext: worker,
            boss,
            gateway: { runBackgroundReadForActor: source },
            generateReport
          }
        )
      ).toBe("inactive");
      if (action === "pause") expect((await history(saved)).runs).toHaveLength(0);
    }
  );
  it("an expired queued check records one expired occurrence and never reads its source", async () => {
    const saved = await save(true);
    await bootstrap.query("BEGIN");
    try {
      await bootstrap.query("SET LOCAL session_replication_role = replica");
      await bootstrap.query(
        "UPDATE app.chat_reminders SET due_at = now() - interval '5 seconds', deadline_at = now() - interval '1 second' WHERE id = $1",
        [saved.id]
      );
      await bootstrap.query("COMMIT");
    } catch (error) {
      await bootstrap.query("ROLLBACK");
      throw error;
    }
    const source = vi.fn();
    const deps = {
      dataContext: worker,
      boss,
      gateway: { runBackgroundReadForActor: source },
      generateReport
    };
    expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("inactive");
    expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("inactive");
    expect(source).not.toHaveBeenCalled();
    const task = await history(saved);
    expect(task.state).toBe("expired");
    expect(task.runs).toHaveLength(1);
    expect(task.runs[0]).toMatchObject({ outcome: "expired", message: null });
  });
  it("third terminal failure posts honest closure guidance rather than a continuing-work promise", async () => {
    const saved = await save(true);
    const deps = {
      dataContext: worker,
      boss,
      generateReport,
      gateway: {
        runBackgroundReadForActor: async () => ({
          ok: false as const,
          failureKind: "read" as const,
          error: "failed"
        })
      }
    };
    await runScheduledReadJob({ data: saved.data }, deps);
    await runScheduledReadJob({ data: await nextRun(saved) }, deps);
    expect(await runScheduledReadJob({ data: await nextRun(saved, 5) }, deps)).toBe("failed");
    const task = await history(saved);
    expect(task.state).toBe("completed");
    expect(task.runs.filter((r) => r.message !== null)).toHaveLength(1);
    const message = task.runs.find((r) => r.message !== null)?.message?.body;
    expect(message).toContain("now complete");
    expect(message).not.toContain("keep checking");
  });
  it.each(["baseline", "unchanged", "failed"])(
    "final %s occurrence completes without a fake message",
    async (kind) => {
      const saved = await save(true);
      const deps = { dataContext: worker, boss, gateway: gateway(), generateReport };
      if (kind === "unchanged") await runScheduledReadJob({ data: saved.data }, deps);
      const data = await nextRun(saved, 5);
      const selected =
        kind === "failed"
          ? {
              ...deps,
              gateway: {
                runBackgroundReadForActor: async () => ({
                  ok: false as const,
                  failureKind: "read" as const,
                  error: "failed"
                })
              }
            }
          : deps;
      expect(await runScheduledReadJob({ data }, selected)).toBe(
        kind === "failed" ? "failed" : "quiet"
      );
      const task = await history(saved);
      expect(task.state).toBe("completed");
      expect(task.runs.every((r) => r.message === null)).toBe(true);
    }
  );
});
