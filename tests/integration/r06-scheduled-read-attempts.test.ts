import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { migratePgBoss } from "@moss/jobs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { DataContextDb } from "@moss/db";
import type { PgBoss, Request, SendOptions } from "pg-boss";
import { connectionStrings, ids } from "./test-database.js";
import {
  CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE_DEFINITION,
  CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
  CHAT_SCHEDULED_READ_QUEUE,
  type ScheduledReadWatchdogPayload
} from "../../packages/chat/src/scheduled-reads/queue.js";
import { runScheduledReadJob } from "../../packages/chat/src/scheduled-reads/runner.js";
import { readScheduledOperation } from "../../packages/chat/src/scheduled-reads/repository.js";
import * as attempts from "../../packages/chat/src/scheduled-reads/attempts.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import {
  pauseReminderById,
  resumeReminderById
} from "../../packages/chat/src/reminders/controls.js";
import {
  worker,
  boss,
  save as saveFixture,
  generateReport,
  bootstrap,
  owner,
  chat
} from "./scheduled-read-fixture.js";

// A defines the queue contract; B owns production registration/composition.
beforeAll(() =>
  migratePgBoss(connectionStrings.migration, [CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE_DEFINITION])
);

type Saved = Awaited<ReturnType<typeof save>>;
const ownedReminderIds: string[] = [];
async function save(repeating = false) {
  const saved = await saveFixture(repeating);
  ownedReminderIds.push(saved.id);
  return saved;
}
afterEach(async () => {
  await bootstrap.query("DELETE FROM app.chat_reminders WHERE id=ANY($1::uuid[])", [
    ownedReminderIds.splice(0)
  ]);
});
const access = { actorUserId: ids.userA };
const ledger = (saved: Saved) => owner((db) => readScheduledOperation(db, saved.id));
async function locked<T>(
  saved: Saved,
  work: (
    db: DataContextDb,
    reminder: NonNullable<Awaited<ReturnType<ReminderRepository["lockForDelivery"]>>>
  ) => Promise<T>
) {
  return worker.withDataContext(access, async (db) => {
    const reminder = await new ReminderRepository().lockForDelivery(db, saved.id);
    if (!reminder) throw new Error("fixture missing");
    return work(db, reminder);
  });
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function taskResponse(saved: Saved) {
  return {
    ok: true as const,
    data: {},
    structuredData: {
      task: { id: saved.task.id, title: saved.task.title, status: "todo" }
    }
  };
}
function authority(
  row: NonNullable<Awaited<ReturnType<typeof ledger>>>
): attempts.ScheduledReadAttempt {
  if (
    !row.attempt_token ||
    !row.attempt_message_id ||
    !row.attempt_version ||
    (row.attempt_count !== 1 && row.attempt_count !== 2)
  )
    throw new Error("fixture not admitted");
  return {
    messageId: row.attempt_message_id,
    token: row.attempt_token,
    ordinal: row.attempt_count,
    version: row.attempt_version
  };
}
function sendThen(after: (name: string) => void): Pick<PgBoss, "send"> {
  return {
    async send(request: string | Request, data?: object | null, options?: SendOptions) {
      const id =
        typeof request === "string"
          ? await boss.send(request, data, options)
          : await boss.send(request);
      after(typeof request === "string" ? request : request.name);
      return id;
    }
  };
}
async function jobs(saved: Saved, name: string) {
  return (
    await bootstrap.query<{ id: string; data: ScheduledReadWatchdogPayload }>(
      "SELECT id,data FROM pgboss.job WHERE name=$1 AND data->>'resourceId'=$2 ORDER BY created_on,id",
      [name, saved.id]
    )
  ).rows;
}
async function expire(saved: Saved) {
  await bootstrap.query(
    "UPDATE app.chat_scheduled_reads SET attempt_lease_until=clock_timestamp()-interval '1 second' WHERE reminder_id=$1",
    [saved.id]
  );
}

describe("durable scheduled read admission through the ordinary worker", () => {
  it("does not replenish the shared allowance when retry metadata resets", async () => {
    const saved = await save();
    const read = vi.fn(async () => ({
      ok: false as const,
      failureKind: "read" as const,
      retryable: true as const,
      error: "temporary"
    }));
    const deps = {
      dataContext: worker,
      boss,
      generateReport,
      gateway: { runBackgroundReadForActor: read }
    };
    for (let invocation = 0; invocation < 3; invocation++) {
      await runScheduledReadJob({ data: saved.data, retryCount: 0, retryLimit: 1 }, deps).catch(
        () => "retry"
      );
    }
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("null transactional watchdog send permits zero external I/O", async () => {
    const saved = await save();
    const read = vi.fn(async () => ({
      ok: false as const,
      failureKind: "read" as const,
      error: "failure"
    }));
    await expect(
      runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          boss: { send: async () => null },
          generateReport,
          gateway: { runBackgroundReadForActor: read }
        }
      )
    ).rejects.toThrow(/watchdog/i);
    expect(read).not.toHaveBeenCalled();
    expect(await ledger(saved)).toMatchObject({ attempt_count: 0, attempt_state: "ready" });
    expect(await jobs(saved, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE)).toHaveLength(0);
  });

  it("validation-read recovery permits gateway calls three and four but no third generator", async () => {
    const saved = await save();
    const read = vi.fn(async () =>
      read.mock.calls.length === 2
        ? {
            ok: false as const,
            failureKind: "read" as const,
            retryable: true as const,
            error: "temporary validation failure"
          }
        : taskResponse(saved)
    );
    const model = vi.fn(generateReport);
    const deps = {
      dataContext: worker,
      boss,
      generateReport: model,
      gateway: { runBackgroundReadForActor: read }
    };
    const job = { data: saved.data, retryCount: 0, retryLimit: 1 };
    await expect(runScheduledReadJob(job, deps)).rejects.toThrow(/temporarily/);
    expect(await ledger(saved)).toMatchObject({ attempt_count: 1, attempt_state: "retry_pending" });
    expect(await runScheduledReadJob(job, deps)).toBe("success");
    expect(await runScheduledReadJob(job, deps)).toBe("inactive");
    expect(read).toHaveBeenCalledTimes(4);
    expect(model).toHaveBeenCalledTimes(2);
    expect(await ledger(saved)).toMatchObject({ attempt_count: 2, attempt_state: "terminal" });
  });

  it("keeps the actual recovery receipt through active ordinal two and terminal completion", async () => {
    const saved = await save();
    const entered = barrier(),
      release = barrier();
    const read = vi.fn(async () => {
      if (read.mock.calls.length === 2) {
        entered.release();
        await release.wait;
      }
      return {
        ok: false as const,
        failureKind: "read" as const,
        retryable: true as const,
        error: "temporary"
      };
    });
    const model = vi.fn(generateReport);
    const deps = {
      dataContext: worker,
      boss,
      generateReport: model,
      gateway: { runBackgroundReadForActor: read }
    };
    const job = { data: saved.data, retryCount: 0, retryLimit: 1 };
    await expect(runScheduledReadJob(job, deps)).rejects.toThrow(/temporarily/);
    const pending = (await ledger(saved))!;
    expect(pending).toMatchObject({
      attempt_count: 1,
      attempt_state: "retry_pending",
      attempt_token: null,
      attempt_lease_until: null
    });
    const recovery = await jobs(saved, CHAT_SCHEDULED_READ_QUEUE);
    expect(recovery.filter((j) => j.id === pending.recovery_job_id)).toHaveLength(1);
    const oldWake = (await jobs(saved, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE))[0]!;
    for (let i = 0; i < 2; i++)
      expect(
        await locked(saved, (db, reminder) =>
          attempts.advanceScheduledReadWatchdog(db, reminder, boss, oldWake)
        )
      ).toBe("stale");
    expect(await ledger(saved)).toEqual(pending);
    const second = runScheduledReadJob(job, deps);
    await entered.wait;
    try {
      const active = (await ledger(saved))!;
      expect(active).toMatchObject({
        attempt_count: 2,
        attempt_state: "running",
        recovery_job_id: pending.recovery_job_id
      });
      for (let i = 0; i < 2; i++) expect(await runScheduledReadJob(job, deps)).toBe("inactive");
      expect(await ledger(saved)).toEqual(active);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      release.release();
    }
    expect(await second).toBe("failed");
    expect(await ledger(saved)).toMatchObject({
      attempt_count: 2,
      attempt_state: "terminal",
      recovery_job_id: pending.recovery_job_id
    });
    expect(model).not.toHaveBeenCalled();
  });

  it("late ordinal one generation cannot publish or renew; valid execution two may make gateway calls three/four", async () => {
    const saved = await save();
    const entered = barrier(),
      release = barrier();
    const read = vi.fn(async () => taskResponse(saved));
    const model = vi.fn(async () => {
      if (model.mock.calls.length === 1) {
        entered.release();
        await release.wait;
      }
      return { ok: true as const, text: "Current report" };
    });
    const deps = {
      dataContext: worker,
      boss,
      generateReport: model,
      gateway: { runBackgroundReadForActor: read }
    };
    const first = runScheduledReadJob({ data: saved.data }, deps);
    await entered.wait;
    try {
      const old = authority((await ledger(saved))!);
      await expire(saved);
      expect(
        await locked(saved, (db, reminder) => attempts.renewScheduledReadAttempt(db, reminder, old))
      ).toBe(false);
      expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("success");
      expect(read).toHaveBeenCalledTimes(3);
      expect(model).toHaveBeenCalledTimes(2);
    } finally {
      release.release();
    }
    expect(await first).toBe("inactive");
    expect(await ledger(saved)).toMatchObject({ attempt_count: 2, attempt_state: "terminal" });
    expect(
      (await owner((db) => chat.listMessages(db, saved.threadId))).filter(
        (m) => m.body === "Current report"
      )
    ).toHaveLength(1);
  });

  it("an expired validation response cannot persist any final effects", async () => {
    const saved = await save();
    const entered = barrier(),
      release = barrier();
    const read = vi.fn(async () => {
      if (read.mock.calls.length === 2) {
        entered.release();
        await release.wait;
      }
      return taskResponse(saved);
    });
    const model = vi.fn(generateReport);
    const result = runScheduledReadJob(
      { data: saved.data },
      {
        dataContext: worker,
        boss,
        generateReport: model,
        gateway: { runBackgroundReadForActor: read }
      }
    );
    await entered.wait;
    try {
      await expire(saved);
    } finally {
      release.release();
    }
    expect(await result).toBe("inactive");
    expect(await ledger(saved)).toMatchObject({
      attempt_count: 1,
      attempt_state: "running",
      outcome: null,
      observation_key: null,
      failure_streak: 0
    });
    const row = (await ledger(saved))!;
    expect(
      await owner((db) =>
        db.db
          .selectFrom("app.chat_messages")
          .select("id")
          .where("id", "=", row.attempt_message_id!)
          .execute()
      )
    ).toHaveLength(0);
    expect(await jobs(saved, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE)).toHaveLength(1);
  });

  it("admission send success followed by failure rolls back both queue job and ledger", async () => {
    const saved = await save();
    const read = vi.fn(async () => taskResponse(saved));
    await expect(
      runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          generateReport,
          gateway: { runBackgroundReadForActor: read },
          boss: sendThen(() => {
            throw new Error("after watchdog insert");
          })
        }
      )
    ).rejects.toThrow(/after watchdog/);
    expect(await ledger(saved)).toMatchObject({
      attempt_count: 0,
      attempt_state: "ready",
      watchdog_job_id: null
    });
    expect(await jobs(saved, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE)).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("recovery send rollback preserves consumed admission and the original watchdog", async () => {
    const saved = await save();
    const read = vi.fn(async () => ({
      ok: false as const,
      retryable: true as const,
      failureKind: "read" as const,
      error: "temporary"
    }));
    await expect(
      runScheduledReadJob(
        { data: saved.data, retryCount: 0, retryLimit: 1 },
        {
          dataContext: worker,
          generateReport,
          gateway: { runBackgroundReadForActor: read },
          boss: sendThen((name) => {
            if (name === CHAT_SCHEDULED_READ_QUEUE) throw new Error("after recovery insert");
          })
        }
      )
    ).rejects.toThrow(/after recovery/);
    const prior = (await ledger(saved))!;
    expect(prior).toMatchObject({
      attempt_count: 1,
      attempt_state: "running",
      recovery_job_id: null
    });
    expect(
      (await jobs(saved, CHAT_SCHEDULED_READ_QUEUE)).filter((j) => j.data.idempotencyKey)
    ).toHaveLength(0);
    await expire(saved);
    const receipt = await locked(saved, (db, reminder) =>
      attempts.dispatchScheduledReadRecovery(db, reminder, boss)
    );
    expect(receipt).toBeTruthy();
    expect(await ledger(saved)).toMatchObject({
      attempt_count: 1,
      attempt_state: "retry_pending",
      recovery_job_id: receipt,
      watchdog_job_id: prior.watchdog_job_id
    });
    expect(
      await locked(saved, (db, reminder) =>
        attempts.dispatchScheduledReadRecovery(db, reminder, boss)
      )
    ).toBe(receipt);
    expect(
      (await jobs(saved, CHAT_SCHEDULED_READ_QUEUE)).filter((j) => j.data.idempotencyKey)
    ).toHaveLength(1);
  });

  it("finalization rollback keeps the consumed token and watchdog, without partial effects", async () => {
    const saved = await save();
    const read = vi.fn(async () => taskResponse(saved));
    const model = vi.fn(generateReport);
    const deps = {
      dataContext: worker,
      boss,
      generateReport: model,
      gateway: { runBackgroundReadForActor: read },
      enqueueNotification: async () => {
        throw new Error("completion rollback");
      }
    };
    await expect(runScheduledReadJob({ data: saved.data }, deps)).rejects.toThrow(
      /completion rollback/
    );
    await expire(saved);
    await expect(runScheduledReadJob({ data: saved.data }, deps)).rejects.toThrow(
      /completion rollback/
    );
    await expire(saved);
    const active = (await ledger(saved))!;
    expect(active).toMatchObject({ attempt_count: 2, attempt_state: "running", outcome: null });
    expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("inactive");
    expect(read).toHaveBeenCalledTimes(4);
    expect(model).toHaveBeenCalledTimes(2);
    expect(await ledger(saved)).toEqual(active);
    expect(await jobs(saved, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE)).toHaveLength(2);
    expect(
      await owner((db) =>
        db.db
          .selectFrom("app.chat_messages")
          .select("id")
          .where("id", "=", active.attempt_message_id!)
          .execute()
      )
    ).toHaveLength(0);
  });

  it("control version changes reuse the same allowance and do not revive old authority", async () => {
    const saved = await save();
    const entered = barrier(),
      release = barrier();
    const read = vi.fn(async () => {
      entered.release();
      await release.wait;
      return taskResponse(saved);
    });
    const first = runScheduledReadJob(
      { data: saved.data },
      { dataContext: worker, boss, generateReport, gateway: { runBackgroundReadForActor: read } }
    );
    await entered.wait;
    try {
      const old = authority((await ledger(saved))!);
      await owner((db) => pauseReminderById(db, saved.id));
      await owner((db) => resumeReminderById(db, boss, ids.userA, saved.id));
      expect(
        await locked(saved, (db, reminder) => attempts.renewScheduledReadAttempt(db, reminder, old))
      ).toBe(false);
      expect(await ledger(saved)).toMatchObject({
        attempt_count: 1,
        attempt_message_id: old.messageId
      });
    } finally {
      release.release();
    }
    expect(await first).toBe("inactive");
    const current = await owner((db) =>
      db.db
        .selectFrom("app.chat_reminders")
        .select("version")
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(
      await runScheduledReadJob(
        { data: { ...saved.data, version: current.version } },
        {
          dataContext: worker,
          boss,
          generateReport,
          gateway: { runBackgroundReadForActor: async () => taskResponse(saved) }
        }
      )
    ).toBe("success");
    expect(await ledger(saved)).toMatchObject({ attempt_count: 2 });
  });

  it.each(["attempt_count", "attempt_token", "recovery_job_id", "watchdog_job_id"] as const)(
    "app INSERT/UPDATE cannot forge %s",
    async (column) => {
      const saved = await save();
      const value = column === "attempt_count" ? 1 : randomUUID();
      await expect(
        owner((db) =>
          db.db
            .updateTable("app.chat_scheduled_reads")
            .set({ [column]: value })
            .where("reminder_id", "=", saved.id)
            .execute()
        )
      ).rejects.toThrow(/permission denied/);
      await bootstrap.query("DELETE FROM app.chat_scheduled_reads WHERE reminder_id=$1", [
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
              [column]: value
            })
            .execute()
        )
      ).rejects.toThrow(/permission denied/);
    }
  );

  it("app INSERT rejects a shape-valid running ledger with forged authority and receipts", async () => {
    const saved = await save();
    const reminder = await owner((db) =>
      db.db
        .selectFrom("app.chat_reminders")
        .select(["reserved_message_id", "version"])
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    const token = randomUUID();
    await bootstrap.query("DELETE FROM app.chat_scheduled_reads WHERE reminder_id=$1", [saved.id]);
    // This complete running/count2 shape satisfies the independent ledger CHECK constraints.
    // Removing INSERT privileges/policy protections must let this assertion resolve, not
    // merely replace the permission error with a different constraint's rejection.
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
            attempt_message_id: reminder.reserved_message_id,
            attempt_state: "running",
            attempt_count: 2,
            attempt_token: token,
            attempt_version: reminder.version,
            attempt_lease_until: new Date("2099-01-01T00:00:00Z"),
            recovery_job_id: randomUUID(),
            watchdog_token: token,
            watchdog_generation: 1,
            watchdog_job_id: randomUUID()
          })
          .returning(["attempt_state", "attempt_count", "recovery_job_id", "watchdog_job_id"])
          .executeTakeFirstOrThrow()
      )
    ).rejects.toThrow(/permission denied/);
    expect(await ledger(saved)).toBeUndefined();
  });

  it("real owner RLS hides and refuses mutation of another owner's ledger", async () => {
    const saved = await save();
    expect(
      await worker.withDataContext({ actorUserId: ids.userB }, (db) =>
        readScheduledOperation(db, saved.id)
      )
    ).toBeUndefined();
    const result = await worker.withDataContext({ actorUserId: ids.userB }, (db) =>
      db.db
        .updateTable("app.chat_scheduled_reads")
        .set({ attempt_count: 1 })
        .where("reminder_id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(result.numUpdatedRows).toBe(0n);
    expect(await ledger(saved)).toMatchObject({ attempt_count: 0 });
  });

  it("bookkeeping cannot revoke a valid final admission", async () => {
    const saved = await save();
    await locked(saved, (db, reminder) => attempts.admitScheduledReadAttempt(db, reminder, boss));
    await expire(saved);
    const second = await locked(saved, (db, reminder) =>
      attempts.admitScheduledReadAttempt(db, reminder, boss)
    );
    expect(second?.ordinal).toBe(2);
    const before = await ledger(saved);
    await expect(
      locked(saved, (db, reminder) => attempts.finishScheduledReadAttempt(db, reminder))
    ).rejects.toThrow(/active/);
    expect(await ledger(saved)).toEqual(before);
  });

  it.each(["admission", "recovery"] as const)(
    "%s commit failure rolls back the actual queue insert and ledger transition",
    async (phase) => {
      const saved = await save();
      const transient = vi.fn(async () => ({
        ok: false as const,
        retryable: true as const,
        failureKind: "read" as const,
        error: "temporary"
      }));
      const state = phase === "admission" ? "running" : "retry_pending";
      await bootstrap.query(
        `CREATE FUNCTION app.r06_reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reminder_id = '${saved.id}'::uuid AND NEW.attempt_state = '${state}' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$`
      );
      await bootstrap.query(
        "CREATE CONSTRAINT TRIGGER r06_reject_commit AFTER UPDATE ON app.chat_scheduled_reads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.r06_reject_commit()"
      );
      try {
        await expect(
          runScheduledReadJob(
            { data: saved.data, retryCount: 0, retryLimit: 1 },
            {
              dataContext: worker,
              boss,
              generateReport,
              gateway: { runBackgroundReadForActor: transient }
            }
          )
        ).rejects.toThrow(/injected commit/);
        expect(await ledger(saved)).toMatchObject(
          phase === "admission"
            ? { attempt_count: 0, attempt_state: "ready", watchdog_job_id: null }
            : { attempt_count: 1, attempt_state: "running", recovery_job_id: null }
        );
        expect(await jobs(saved, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE)).toHaveLength(
          phase === "admission" ? 0 : 1
        );
        expect(
          (await jobs(saved, CHAT_SCHEDULED_READ_QUEUE)).filter((j) => j.data.idempotencyKey)
        ).toHaveLength(0);
        expect(transient).toHaveBeenCalledTimes(phase === "admission" ? 0 : 1);
      } finally {
        await bootstrap.query("DROP TRIGGER r06_reject_commit ON app.chat_scheduled_reads");
        await bootstrap.query("DROP FUNCTION app.r06_reject_commit()");
      }
    }
  );

  it.each([undefined, -1, Number.NaN])(
    "invalid retry metadata %s remains terminal without explicit recovery",
    async (retryCount) => {
      const saved = await save();
      const read = vi.fn(async () => ({
        ok: false as const,
        retryable: true as const,
        failureKind: "read" as const,
        error: "temporary"
      }));
      expect(
        await runScheduledReadJob(
          { data: saved.data, retryCount, retryLimit: 1 },
          {
            dataContext: worker,
            boss,
            generateReport,
            gateway: { runBackgroundReadForActor: read }
          }
        )
      ).toBe("failed");
      expect(await ledger(saved)).toMatchObject({
        attempt_count: 1,
        attempt_state: "terminal",
        recovery_job_id: null
      });
      expect(read).toHaveBeenCalledTimes(1);
    }
  );

  it("renewal only changes the lease; one current wake generation installs one successor", async () => {
    const saved = await save();
    const attempt = (await locked(saved, (db, reminder) =>
      attempts.admitScheduledReadAttempt(db, reminder, boss)
    ))!;
    const before = (await ledger(saved))!;
    expect(
      await locked(saved, (db, reminder) =>
        attempts.renewScheduledReadAttempt(db, reminder, attempt)
      )
    ).toBe(true);
    expect(await ledger(saved)).toMatchObject({
      watchdog_job_id: before.watchdog_job_id,
      watchdog_generation: 1,
      attempt_token: attempt.token
    });
    const currentJob = (await jobs(saved, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE)).find(
      (j) => j.id === before.watchdog_job_id
    )!;
    expect(
      await locked(saved, (db, reminder) =>
        attempts.advanceScheduledReadWatchdog(db, reminder, boss, currentJob)
      )
    ).toBe("waiting");
    const successor = (await ledger(saved))!;
    expect(successor.watchdog_generation).toBe(2);
    expect(successor.watchdog_job_id).not.toBe(before.watchdog_job_id);
    expect(
      await locked(saved, (db, reminder) =>
        attempts.advanceScheduledReadWatchdog(db, reminder, boss, currentJob)
      )
    ).toBe("stale");
    expect(await ledger(saved)).toEqual(successor);
    expect(await jobs(saved, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE)).toHaveLength(2);
    const nextJob = (await jobs(saved, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE)).find(
      (j) => j.id === successor.watchdog_job_id
    )!;
    await expect(
      locked(saved, (db, reminder) =>
        attempts.advanceScheduledReadWatchdog(db, reminder, { send: async () => null }, nextJob)
      )
    ).rejects.toThrow(/watchdog/);
    expect(await ledger(saved)).toEqual(successor);
    await expire(saved);
    expect(
      await locked(saved, (db, reminder) =>
        attempts.advanceScheduledReadWatchdog(db, reminder, boss, nextJob)
      )
    ).toBe("expired");
    await locked(saved, (db, reminder) => attempts.admitScheduledReadAttempt(db, reminder, boss));
    const second = (await ledger(saved))!;
    expect(second.attempt_count).toBe(2);
    expect(
      await locked(saved, (db, reminder) =>
        attempts.advanceScheduledReadWatchdog(db, reminder, boss, nextJob)
      )
    ).toBe("stale");
    expect(await ledger(saved)).toEqual(second);
  });

  it("legacy unknown and a wrong occurrence identity cannot initialize allowance", async () => {
    const saved = await save();
    const read = vi.fn(async () => taskResponse(saved));
    const deps = {
      dataContext: worker,
      boss,
      generateReport,
      gateway: { runBackgroundReadForActor: read }
    };
    const wrong = { ...saved.data, idempotencyKey: randomUUID() };
    expect(await runScheduledReadJob({ data: wrong }, deps)).toBe("inactive");
    expect(await ledger(saved)).toMatchObject({ attempt_state: "ready", attempt_count: 0 });
    await locked(saved, async (db, reminder) => {
      await db.db
        .updateTable("app.chat_scheduled_reads")
        .set({ attempt_state: "legacy_unknown", attempt_message_id: reminder.reservedMessageId })
        .where("reminder_id", "=", saved.id)
        .execute();
    });
    expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("inactive");
    expect(await ledger(saved)).toMatchObject({
      attempt_state: "legacy_unknown",
      attempt_count: 0
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("only real recurring advancement starts a fresh governed identity", async () => {
    const saved = await save(true);
    const model = vi.fn(generateReport);
    let status = "todo";
    const read = vi.fn(async () => ({
      ...taskResponse(saved),
      structuredData: { task: { id: saved.task.id, title: saved.task.title, status } }
    }));
    const deps = {
      dataContext: worker,
      boss,
      generateReport: model,
      gateway: { runBackgroundReadForActor: read }
    };
    const identities: string[] = [];
    for (const outcome of ["quiet", "success", "quiet"]) {
      const reminder = await owner((db) =>
        db.db
          .selectFrom("app.chat_reminders")
          .select(["version", "reserved_message_id"])
          .where("id", "=", saved.id)
          .executeTakeFirstOrThrow()
      );
      identities.push(reminder.reserved_message_id);
      expect(
        await runScheduledReadJob({ data: { ...saved.data, version: reminder.version } }, deps)
      ).toBe(outcome);
      expect(await ledger(saved)).toMatchObject({
        attempt_state: "ready",
        attempt_count: 0,
        attempt_message_id: null,
        recovery_job_id: null
      });
      status = "done";
      await bootstrap.query("BEGIN");
      try {
        await bootstrap.query("SET LOCAL session_replication_role=replica");
        await bootstrap.query(
          "UPDATE app.chat_reminders SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [saved.id]
        );
        await bootstrap.query("COMMIT");
      } catch (error) {
        await bootstrap.query("ROLLBACK");
        throw error;
      }
    }
    expect(new Set(identities).size).toBe(3);
    expect(read).toHaveBeenCalledTimes(6);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("migration-owner backfill quarantines saved queued/paused identities and preserves their facts", async () => {
    const fixtures: Saved[] = [];
    for (let i = 0; i < 5; i++) fixtures.push(await save(i === 1 || i === 3));
    const states = ["queued", "paused", "queued", "queued", "cancelled"];
    const sql = await readFile(
      new URL("../../packages/chat/sql/0324_chat_scheduled_read_attempts.sql", import.meta.url),
      "utf8"
    );
    await bootstrap.query("BEGIN");
    try {
      await bootstrap.query("SET LOCAL session_replication_role=replica");
      for (const [index, saved] of fixtures.entries())
        await bootstrap.query(
          "UPDATE app.chat_reminders SET state=$2, due_at=clock_timestamp()+$3::interval WHERE id=$1",
          [saved.id, states[index], index === 2 ? "1 day" : "-1 minute"]
        );
      await bootstrap.query(
        "UPDATE app.chat_reminders SET due_at=clock_timestamp()-interval '2 minutes',deadline_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
        [fixtures[3]!.id]
      );
      await bootstrap.query(
        "UPDATE app.chat_scheduled_reads SET observation_key=repeat('a',64),failure_streak=2 WHERE reminder_id=ANY($1::uuid[])",
        [fixtures.map((s) => s.id)]
      );
      const before = (
        await bootstrap.query(
          "SELECT r.id,r.state,r.version,r.reserved_message_id,r.due_at,s.observation_key,s.failure_streak FROM app.chat_reminders r JOIN app.chat_scheduled_reads s ON s.reminder_id=r.id WHERE r.id=ANY($1::uuid[]) ORDER BY r.id",
          [fixtures.map((s) => s.id)]
        )
      ).rows;
      await bootstrap.query("SET LOCAL session_replication_role=origin");
      const columns = [
        "attempt_message_id",
        "attempt_count",
        "attempt_state",
        "attempt_token",
        "attempt_version",
        "attempt_lease_until",
        "recovery_job_id",
        "watchdog_token",
        "watchdog_generation",
        "watchdog_job_id"
      ];
      for (const column of columns)
        await bootstrap.query(`ALTER TABLE app.chat_scheduled_reads DROP COLUMN ${column} CASCADE`);
      await bootstrap.query(
        "CREATE POLICY chat_scheduled_reads_insert ON app.chat_scheduled_reads FOR INSERT TO jarvis_app_runtime WITH CHECK (owner_user_id=app.current_actor_user_id())"
      );
      await bootstrap.query("GRANT INSERT ON app.chat_scheduled_reads TO jarvis_app_runtime");
      await bootstrap.query("SET LOCAL ROLE jarvis_migration_owner");
      await bootstrap.query(sql);
      await bootstrap.query("RESET ROLE");
      const after = (
        await bootstrap.query(
          "SELECT r.id,r.state,r.version,r.reserved_message_id,r.due_at,s.observation_key,s.failure_streak FROM app.chat_reminders r JOIN app.chat_scheduled_reads s ON s.reminder_id=r.id WHERE r.id=ANY($1::uuid[]) ORDER BY r.id",
          [fixtures.map((s) => s.id)]
        )
      ).rows;
      expect(after).toEqual(before);
      const rows = (
        await bootstrap.query(
          "SELECT s.attempt_state,s.attempt_message_id,s.attempt_count,r.state,r.reserved_message_id FROM app.chat_scheduled_reads s JOIN app.chat_reminders r ON r.id=s.reminder_id WHERE r.id=ANY($1::uuid[])",
          [fixtures.map((s) => s.id)]
        )
      ).rows;
      for (const row of rows)
        expect(row).toMatchObject(
          row.state === "cancelled"
            ? { attempt_state: "ready", attempt_message_id: null, attempt_count: 0 }
            : {
                attempt_state: "legacy_unknown",
                attempt_message_id: row.reserved_message_id,
                attempt_count: 0
              }
        );
      expect(
        (
          await bootstrap.query(
            "SELECT relforcerowsecurity FROM pg_class WHERE oid IN ('app.chat_scheduled_reads'::regclass,'app.chat_reminders'::regclass)"
          )
        ).rows
      ).toEqual([{ relforcerowsecurity: true }, { relforcerowsecurity: true }]);
    } finally {
      await bootstrap.query("ROLLBACK");
    }
  });
});
