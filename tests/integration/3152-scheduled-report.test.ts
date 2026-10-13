import { describe, expect, it, vi } from "vitest";
import { runScheduledReadJob } from "../../packages/chat/src/scheduled-reads/runner.js";
import {
  pauseReminderById,
  deleteReminderById
} from "../../packages/chat/src/reminders/controls.js";
import { listScheduledReminders } from "../../packages/chat/src/reminders/settings.js";
import { editReminderById } from "../../packages/chat/src/reminders/edit.js";
import { ids } from "./test-database.js";
import {
  worker,
  boss,
  chat,
  tasks,
  owner,
  save,
  gateway,
  setTasksDisabled,
  generateReport
} from "./scheduled-read-fixture.js";

describe("configured scheduled reports through the worker", () => {
  it("a version edit during generation discards the old report", async () => {
    const saved = await save();
    const before = (await owner((db) => chat.listMessages(db, saved.threadId))).length;
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          gateway: gateway(),
          generateReport: async (...args) => {
            expect(
              (
                await owner((db) =>
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
                      localDeadline: null
                    },
                    "UTC"
                  )
                )
              ).kind
            ).toBe("changed");
            return generateReport(args[0], args[1]);
          }
        }
      )
    ).toBe("inactive");
    expect((await owner((db) => chat.listMessages(db, saved.threadId))).length).toBe(before);
  });
  it("concurrent jobs and replay persist one result with each run's reserved identity", async () => {
    const first = await save();
    const deps = { dataContext: worker, gateway: gateway(), generateReport };
    const outcomes = await Promise.all([
      runScheduledReadJob({ data: first.data }, deps),
      runScheduledReadJob({ data: first.data }, deps)
    ]);
    expect(outcomes.sort()).toEqual(["inactive", "success"]);
    const second = await save();
    expect(await runScheduledReadJob({ data: second.data }, deps)).toBe("success");
    expect(await runScheduledReadJob({ data: first.data }, deps)).toBe("inactive");
    const records = await owner(listScheduledReminders);
    const one = records.find((r) => r.id === first.id)?.runs[0]?.message;
    const two = records.find((r) => r.id === second.id)?.runs[0]?.message;
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(one?.id).not.toBe(two?.id);
    expect(
      (await owner((db) => chat.listMessages(db, first.threadId))).filter((m) => m.id === one?.id)
    ).toHaveLength(1);
  });
  it.each(["pause", "delete"])("%s during generation discards the report", async (action) => {
    const saved = await save();
    const before = (await owner((db) => chat.listMessages(db, saved.threadId))).length;
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          gateway: gateway(),
          generateReport: async (...args) => {
            await owner((db) =>
              action === "pause"
                ? pauseReminderById(db, saved.id)
                : deleteReminderById(db, saved.id)
            );
            return generateReport(args[0], args[1]);
          }
        }
      )
    ).toBe("inactive");
    expect((await owner((db) => chat.listMessages(db, saved.threadId))).length).toBe(before);
  });
  it("revocation during generation posts refusal without source content", async () => {
    const saved = await save();
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          gateway: gateway(),
          generateReport: async (...args) => {
            await setTasksDisabled(true);
            return generateReport(args[0], args[1]);
          }
        }
      )
    ).toBe("refused");
    const result = (await owner(listScheduledReminders)).find((r) => r.id === saved.id)?.runs[0]
      ?.message;
    expect(result?.body).toContain("access is no longer available");
    expect(result?.body).not.toContain(saved.task.title);
    expect(result?.body).not.toContain("Source: Tasks");
    await setTasksDisabled(false);
  });
  it("discards a source changed during generation", async () => {
    const saved = await save();
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          gateway: gateway(),
          generateReport: async (...args) => {
            await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
            return generateReport(args[0], args[1]);
          }
        }
      )
    ).toBe("failed");
    expect(
      (await owner(listScheduledReminders)).find((r) => r.id === saved.id)?.runs[0]?.message?.body
    ).toContain("discarded the outdated result");
  });
  it("a temporary read retries quietly then succeeds with one model call", async () => {
    const saved = await save();
    const real = gateway();
    const source = vi.fn(real.runBackgroundReadForActor.bind(real));
    source.mockResolvedValueOnce({
      ok: false,
      error: "private failure",
      failureKind: "read",
      retryable: true
    });
    const model = vi.fn(generateReport);
    const deps = {
      dataContext: worker,
      gateway: { runBackgroundReadForActor: source },
      generateReport: model
    };
    const before = (await owner((db) => chat.listMessages(db, saved.threadId))).length;
    await expect(
      runScheduledReadJob({ data: saved.data, retryCount: 0, retryLimit: 99 }, deps)
    ).rejects.toThrow("temporarily failed");
    expect(model).not.toHaveBeenCalled();
    expect((await owner((db) => chat.listMessages(db, saved.threadId))).length).toBe(before);
    expect(
      await runScheduledReadJob({ data: saved.data, retryCount: 1, retryLimit: 99 }, deps)
    ).toBe("success");
    expect(model).toHaveBeenCalledTimes(1);
    expect(
      await runScheduledReadJob({ data: saved.data, retryCount: 1, retryLimit: 99 }, deps)
    ).toBe("inactive");
    expect(model).toHaveBeenCalledTimes(1);
  });
  it("exhausts at two retries even when queue metadata allows more", async () => {
    const saved = await save();
    const model = vi.fn(generateReport);
    const deps = {
      dataContext: worker,
      generateReport: model,
      gateway: {
        runBackgroundReadForActor: async () => ({
          ok: false as const,
          error: "failed",
          failureKind: "read" as const,
          retryable: true as const
        })
      }
    };
    for (const retryCount of [0, 1])
      await expect(
        runScheduledReadJob({ data: saved.data, retryCount, retryLimit: 99 }, deps)
      ).rejects.toThrow("temporarily failed");
    expect(
      await runScheduledReadJob({ data: saved.data, retryCount: 2, retryLimit: 99 }, deps)
    ).toBe("failed");
    expect(model).not.toHaveBeenCalled();
    const result = (await owner(listScheduledReminders)).find((r) => r.id === saved.id)?.runs[0]
      ?.message;
    expect(result?.body).toContain("after retrying");
    expect(
      await runScheduledReadJob({ data: saved.data, retryCount: 3, retryLimit: 99 }, deps)
    ).toBe("inactive");
  });
  it.each(["unavailable", "failed", "timeout"] as const)(
    "model %s posts honestly without retrying",
    async (reason) => {
      const saved = await save();
      expect(
        await runScheduledReadJob(
          { data: saved.data, retryCount: 0, retryLimit: 2 },
          {
            dataContext: worker,
            gateway: gateway(),
            generateReport: async () => ({ ok: false, reason })
          }
        )
      ).toBe("failed");
      expect(
        (await owner(listScheduledReminders)).find((r) => r.id === saved.id)?.runs[0]?.message?.body
      ).toContain(
        reason === "unavailable"
          ? "configured JSON model is unavailable"
          : reason === "timeout"
            ? "took too long"
            : "couldn't produce a reliable report"
      );
    }
  );
});
