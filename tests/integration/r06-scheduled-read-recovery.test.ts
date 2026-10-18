import { enqueueReminderNotification } from "../../packages/chat/src/reminders/notifications.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataContextDb, DataContextRunner, AccessContext } from "@moss/db";
import type { PgBoss, Request, SendOptions } from "pg-boss";
import { runScheduledReadJob } from "../../packages/chat/src/scheduled-reads/runner.js";
import {
  runScheduledReadBookkeepingJob,
  registerScheduledReadBookkeepingWorker,
  recoverScheduledReadOccurrence,
  scheduleScheduledReadBookkeeping
} from "../../packages/chat/src/scheduled-reads/bookkeeping.js";
import * as attempts from "../../packages/chat/src/scheduled-reads/attempts.js";
import { readScheduledOperation } from "../../packages/chat/src/scheduled-reads/repository.js";
import {
  CHAT_SCHEDULED_READ_QUEUE,
  CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
  type ScheduledReadWatchdogPayload
} from "../../packages/chat/src/scheduled-reads/queue.js";
import {
  ReminderRepository,
  type DueReminder
} from "../../packages/chat/src/reminders/repository.js";
import {
  pauseReminderById,
  resumeReminderById,
  deleteReminderById
} from "../../packages/chat/src/reminders/controls.js";
import { ids } from "./test-database.js";
import {
  worker,
  workerBoss,
  boss,
  bootstrap,
  owner,
  save as saveFixture,
  generateReport
} from "./scheduled-read-fixture.js";

type Saved = Awaited<ReturnType<typeof saveFixture>>;
const owned: string[] = [];
async function save(repeat = false) {
  const saved = await saveFixture(repeat);
  owned.push(saved.id);
  return saved;
}
afterEach(async () => {
  await bootstrap.query("DELETE FROM app.chat_reminders WHERE id=ANY($1::uuid[])", [
    owned.splice(0)
  ]);
});
const bookkeeping = {
  get dataContext() {
    return worker;
  },
  get boss() {
    return boss;
  }
};
const ledger = (s: Saved) => owner((db) => readScheduledOperation(db, s.id));
const reminder = (s: Saved) => owner((db) => new ReminderRepository().lockForDelivery(db, s.id));
async function locked<T>(
  s: Saved,
  work: (db: DataContextDb, r: NonNullable<Awaited<ReturnType<typeof reminder>>>) => Promise<T>
) {
  return worker.withDataContext({ actorUserId: ids.userA }, async (db) => {
    const r = await new ReminderRepository().lockForDelivery(db, s.id);
    if (!r) throw new Error("missing fixture");
    return work(db, r);
  });
}
const target = async (s: Saved) => ({
  actorUserId: ids.userA,
  resourceId: s.id,
  expectedMessageId: (await reminder(s))!.reservedMessageId
});
async function jobs(s: Saved, name: string) {
  return (
    await bootstrap.query<{ id: string; data: ScheduledReadWatchdogPayload; state: string }>(
      "SELECT id,data,state FROM pgboss.job WHERE name=$1 AND data->>'resourceId'=$2 ORDER BY created_on,id",
      [name, s.id]
    )
  ).rows;
}
const wakes = (s: Saved) => jobs(s, CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE);
const recoveries = async (s: Saved) =>
  (await jobs(s, CHAT_SCHEDULED_READ_QUEUE)).filter((j) => j.data.idempotencyKey);
const wake = (j: Awaited<ReturnType<typeof wakes>>[number]) =>
  runScheduledReadBookkeepingJob(j, bookkeeping);
async function expire(s: Saved) {
  await bootstrap.query(
    "UPDATE app.chat_scheduled_reads SET attempt_lease_until=clock_timestamp()-interval '1 second' WHERE reminder_id=$1",
    [s.id]
  );
}
async function effects(s: Saved, messageId: string) {
  const r = (await reminder(s))!;
  return {
    r,
    ledger: await ledger(s),
    runs: (
      await bootstrap.query("SELECT * FROM app.chat_reminder_runs WHERE reminder_id=$1", [s.id])
    ).rows,
    messages: await owner((db) =>
      db.db.selectFrom("app.chat_messages").selectAll().where("id", "=", messageId).execute()
    ),
    notificationJobs: await jobs(s, "chat.notify-reminder"),
    jobs: await jobs(s, CHAT_SCHEDULED_READ_QUEUE)
  };
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, release };
}
const temporary = () => ({
  ok: false as const,
  failureKind: "read" as const,
  retryable: true as const,
  error: "temporary"
});
const failure = () => ({ ok: false as const, failureKind: "read" as const, error: "terminal" });
const response = (s: Saved) => ({
  ok: true as const,
  data: {},
  structuredData: { task: { id: s.task.id, title: s.task.title, status: "todo" } }
});
function deps(read = vi.fn(async () => failure())) {
  return {
    dataContext: worker,
    boss,
    generateReport: vi.fn(generateReport),
    gateway: { runBackgroundReadForActor: read }
  };
}
async function finalAdmission(s: Saved) {
  await locked(s, (db, r) => attempts.admitScheduledReadAttempt(db, r, boss));
  await expire(s);
  const second = await locked(s, (db, r) => attempts.admitScheduledReadAttempt(db, r, boss));
  if (!second) throw new Error("second admission missing");
  return second;
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
async function clock(s: Saved, assignment: string) {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role=replica");
    await bootstrap.query(`UPDATE app.chat_reminders SET ${assignment} WHERE id=$1`, [s.id]);
    await bootstrap.query("COMMIT");
  } catch (e) {
    await bootstrap.query("ROLLBACK");
    throw e;
  }
}
async function rejectCommit(s: Saved, state: string) {
  await bootstrap.query(
    `CREATE FUNCTION app.r06_b_reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reminder_id='${s.id}'::uuid AND NEW.attempt_state='${state}' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$`
  );
  await bootstrap.query(
    "CREATE CONSTRAINT TRIGGER r06_b_reject_commit AFTER UPDATE ON app.chat_scheduled_reads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.r06_b_reject_commit()"
  );
  return async () => {
    await bootstrap.query("DROP TRIGGER r06_b_reject_commit ON app.chat_scheduled_reads");
    await bootstrap.query("DROP FUNCTION app.r06_b_reject_commit()");
  };
}

describe("composed scheduled read recovery with real owner transactions and queue receipts", () => {
  it("explicit recovery alone completes once and old wakes cannot displace active ordinal two", async () => {
    const s = await save(true);
    await bootstrap.query(
      "UPDATE app.chat_scheduled_reads SET failure_streak=2,observation_key=$2 WHERE reminder_id=$1",
      [s.id, "a".repeat(64)]
    );
    const original = await target(s);
    const entered = barrier(),
      release = barrier();
    const read = vi.fn(async () => {
      if (read.mock.calls.length === 1) return temporary();
      entered.release();
      await release.wait;
      return failure();
    });
    const d = {
      ...deps(),
      gateway: { runBackgroundReadForActor: read },
      enqueueNotification: vi.fn((db: DataContextDb, r: DueReminder) =>
        enqueueReminderNotification(boss, db, r)
      )
    };
    let invocations = 0;
    const execute = (job: Parameters<typeof runScheduledReadJob>[0]) => {
      invocations++;
      return runScheduledReadJob(job, d);
    };
    await expect(execute({ data: s.data, retryCount: 0, retryLimit: 1 })).rejects.toThrow(
      /temporarily/
    );
    const pending = (await ledger(s))!;
    const old = (await wakes(s))[0]!;
    const explicit = (await recoveries(s))[0]!;
    expect(pending).toMatchObject({
      attempt_count: 1,
      attempt_state: "retry_pending",
      attempt_token: null,
      recovery_job_id: explicit.id
    });
    expect(await wake(old)).toBe("stale");
    expect(await wake(old)).toBe("stale");
    expect(await ledger(s)).toEqual(pending);
    // Automatic retry is deliberately never delivered. Deliver the persisted explicit job.
    const running = execute({ data: explicit.data, retryCount: 0, retryLimit: 1 });
    await entered.wait;
    try {
      const active = (await ledger(s))!;
      expect(active).toMatchObject({
        attempt_count: 2,
        attempt_state: "running",
        recovery_job_id: explicit.id
      });
      expect(await execute({ data: explicit.data })).toBe("inactive");
      expect(await execute({ data: s.data, retryCount: 1, retryLimit: 1 })).toBe("inactive");
      expect(await wake(old)).toBe("stale");
      expect(await wake(old)).toBe("stale");
      expect(await recoverScheduledReadOccurrence(original, bookkeeping)).toBe("in_flight");
      expect(await ledger(s)).toEqual(active);
      expect(
        await locked(s, (db, r) =>
          attempts.validScheduledReadAttempt(db, r, {
            messageId: original.expectedMessageId,
            token: active.attempt_token!,
            ordinal: 2,
            version: active.attempt_version!
          })
        )
      ).toBe(true);
    } finally {
      release.release();
    }
    expect(await running).toBe("failed");
    const finished = await effects(s, original.expectedMessageId);
    expect(finished.ledger).toMatchObject({
      attempt_count: 0,
      attempt_state: "ready",
      failure_streak: 3,
      observation_key: "a".repeat(64)
    });
    expect(finished.runs).toHaveLength(1);
    expect(finished.runs[0]).toMatchObject({ outcome: "failed" });
    expect(finished.messages).toHaveLength(1);
    expect(finished.notificationJobs).toHaveLength(1);
    expect(finished.r.version).toBe(2);
    expect(finished.r.reservedMessageId).not.toBe(original.expectedMessageId);
    expect(finished.jobs).toHaveLength(3); // initial + explicit recovery + genuine next occurrence
    expect(await recoveries(s)).toHaveLength(1);
    expect(await wakes(s)).toHaveLength(2);
    expect(d.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(d.generateReport).not.toHaveBeenCalled();
    expect(invocations).toBe(4); // physical calls differ from two admissions / two gateway calls
    expect(await execute({ data: explicit.data })).toBe("inactive");
    expect(await wake(old)).toBe("inactive");
    expect(await recoverScheduledReadOccurrence(original, bookkeeping)).toBe("inactive");
    expect(await effects(s, original.expectedMessageId)).toEqual(finished);
  });

  it("two admissions permit four validation gateway calls and two generators, never execution three", async () => {
    const s = await save();
    const read = vi.fn(async () => (read.mock.calls.length === 2 ? temporary() : response(s)));
    const model = vi.fn(generateReport);
    const d = {
      dataContext: worker,
      boss,
      generateReport: model,
      gateway: { runBackgroundReadForActor: read }
    };
    await expect(
      runScheduledReadJob({ data: s.data, retryCount: 0, retryLimit: 1 }, d)
    ).rejects.toThrow(/temporarily/);
    const explicit = (await recoveries(s))[0]!;
    expect(
      await runScheduledReadJob({ data: explicit.data, retryCount: 0, retryLimit: 1 }, d)
    ).toBe("success");
    expect(
      await runScheduledReadJob({ data: explicit.data, retryCount: 0, retryLimit: 1 }, d)
    ).toBe("inactive");
    expect(await ledger(s)).toMatchObject({ attempt_count: 2, attempt_state: "terminal" });
    expect(read).toHaveBeenCalledTimes(4);
    expect(model).toHaveBeenCalledTimes(2);
    expect(await recoveries(s)).toHaveLength(1);
    expect(await wakes(s)).toHaveLength(2);
  });

  it("dispatch commit survives lost acknowledgment without another recovery enqueue", async () => {
    const s = await save();
    const t = await target(s);
    const d = { ...deps(), gateway: { runBackgroundReadForActor: vi.fn(async () => temporary()) } };
    await expect(
      runScheduledReadJob({ data: s.data, retryCount: 0, retryLimit: 1 }, d)
    ).rejects.toThrow(/temporarily/);
    const before = await ledger(s);
    expect(await recoverScheduledReadOccurrence(t, bookkeeping)).toBe("awaiting_recovery");
    expect(await ledger(s)).toEqual(before);
    expect(await recoveries(s)).toHaveLength(1);
    const explicit = (await recoveries(s))[0]!;
    expect(await runScheduledReadJob({ data: explicit.data }, deps())).toBe("failed");
    expect((await effects(s, t.expectedMessageId)).messages).toHaveLength(1);
  });

  it.each(["admission", "recovery"] as const)(
    "%s transactional send and commit failure leave no orphan queue row",
    async (phase) => {
      const s = await save();
      const remove = await rejectCommit(s, phase === "admission" ? "running" : "retry_pending");
      const read = vi.fn(async () => temporary());
      try {
        await expect(
          runScheduledReadJob(
            { data: s.data, retryCount: 0, retryLimit: 1 },
            { ...deps(), gateway: { runBackgroundReadForActor: read } }
          )
        ).rejects.toThrow(/injected commit/);
        expect(await ledger(s)).toMatchObject(
          phase === "admission"
            ? { attempt_count: 0, attempt_state: "ready", watchdog_job_id: null }
            : { attempt_count: 1, attempt_state: "running", recovery_job_id: null }
        );
        expect(await wakes(s)).toHaveLength(phase === "admission" ? 0 : 1);
        expect(await recoveries(s)).toHaveLength(0);
        expect(read).toHaveBeenCalledTimes(phase === "admission" ? 0 : 1);
      } finally {
        await remove();
      }
      if (phase === "recovery") {
        await expire(s);
        const old = (await wakes(s))[0]!;
        expect(await wake(old)).toBe("recovery_dispatched");
        expect(await wake(old)).toBe("stale");
        expect(await recoveries(s)).toHaveLength(1);
      }
    }
  );

  it("send succeeds then throws before recovery receipt commit and original watchdog dispatches once", async () => {
    const s = await save();
    const d = {
      ...deps(),
      gateway: { runBackgroundReadForActor: vi.fn(async () => temporary()) },
      boss: sendThen((name) => {
        if (name === CHAT_SCHEDULED_READ_QUEUE) throw new Error("after recovery insert");
      })
    };
    await expect(
      runScheduledReadJob({ data: s.data, retryCount: 0, retryLimit: 1 }, d)
    ).rejects.toThrow(/after recovery/);
    expect(await recoveries(s)).toHaveLength(0);
    expect(await ledger(s)).toMatchObject({
      attempt_count: 1,
      attempt_state: "running",
      recovery_job_id: null
    });
    await expire(s);
    const old = (await wakes(s))[0]!;
    expect(await wake(old)).toBe("recovery_dispatched");
    expect(await wake(old)).toBe("stale");
    expect(await recoveries(s)).toHaveLength(1);
  });

  it("admission watchdog rollback permits zero I/O and no orphan watchdog", async () => {
    const s = await save();
    const d = {
      ...deps(),
      boss: sendThen(() => {
        throw new Error("after watchdog insert");
      })
    };
    await expect(runScheduledReadJob({ data: s.data }, d)).rejects.toThrow(/after watchdog/);
    expect(await ledger(s)).toMatchObject({ attempt_count: 0, attempt_state: "ready" });
    expect(await wakes(s)).toHaveLength(0);
    expect(d.gateway.runBackgroundReadForActor).not.toHaveBeenCalled();
  });

  it("renewal and duplicate early generation produce exactly one successor", async () => {
    const s = await save();
    const admitted = await locked(s, (db, r) => attempts.admitScheduledReadAttempt(db, r, boss));
    const old = (await wakes(s))[0]!;
    expect(await locked(s, (db, r) => attempts.renewScheduledReadAttempt(db, r, admitted!))).toBe(
      true
    );
    const renewed = (await ledger(s))!;
    expect(await wake(old)).toBe("waiting");
    const current = (await ledger(s))!;
    expect(current.watchdog_generation).toBe(renewed.watchdog_generation + 1);
    expect(await wake(old)).toBe("stale");
    expect(await ledger(s)).toEqual(current);
    expect(await wakes(s)).toHaveLength(2);
    expect(await recoveries(s)).toHaveLength(0);
    expect(current.attempt_token).toBe(renewed.attempt_token);
    expect(current.attempt_lease_until).toEqual(renewed.attempt_lease_until);
  });

  it("active final admission is immune to bookkeeping cleanup", async () => {
    const s = await save();
    await finalAdmission(s);
    const before = await ledger(s);
    expect(await recoverScheduledReadOccurrence(await target(s), bookkeeping)).toBe("in_flight");
    await expect(locked(s, (db, r) => attempts.finishScheduledReadAttempt(db, r))).rejects.toThrow(
      /active/
    );
    expect(await ledger(s)).toEqual(before);
  });

  it("final admission crash and whole finalization rollback eventually complete exactly once", async () => {
    const s = await save(true);
    const t = await target(s);
    await bootstrap.query(
      "UPDATE app.chat_scheduled_reads SET failure_streak=2,observation_key=$2 WHERE reminder_id=$1",
      [s.id, "b".repeat(64)]
    );
    await finalAdmission(s);
    await expire(s);
    const prior = (await ledger(s))!;
    const old = (await wakes(s)).find((j) => j.id !== prior.watchdog_job_id)!;
    const latest = (await wakes(s)).find((j) => j.id !== old.id)!;
    const before = await effects(s, t.expectedMessageId);
    const remove = await rejectCommit(s, "ready");
    const notify = vi.fn((db: DataContextDb, r: DueReminder) =>
      enqueueReminderNotification(boss, db, r)
    );
    try {
      await expect(
        runScheduledReadBookkeepingJob(latest, { ...bookkeeping, enqueueNotification: notify })
      ).rejects.toThrow(/injected commit/);
      expect(await effects(s, t.expectedMessageId)).toEqual(before);
    } finally {
      await remove();
    }
    expect(
      await runScheduledReadBookkeepingJob(latest, { ...bookkeeping, enqueueNotification: notify })
    ).toBe("failed");
    const after = await effects(s, t.expectedMessageId);
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({ outcome: "failed" });
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]?.body).toContain("interrupted");
    expect(after.ledger).toMatchObject({
      attempt_count: 0,
      attempt_state: "ready",
      failure_streak: 3,
      observation_key: "b".repeat(64)
    });
    expect(after.r.version).toBe(2);
    expect(after.jobs).toHaveLength(2);
    expect(after.notificationJobs).toHaveLength(1);
    expect(await wake(latest)).toBe("inactive");
    expect(await effects(s, t.expectedMessageId)).toEqual(after);
  });

  it("finalization failure retains two consumed admissions and later bookkeeping creates one result", async () => {
    const s = await save();
    const t = await target(s);
    await expect(
      runScheduledReadJob(
        { data: s.data, retryCount: 0, retryLimit: 1 },
        {
          ...deps(),
          gateway: { runBackgroundReadForActor: vi.fn(async () => temporary()) }
        }
      )
    ).rejects.toThrow(/temporarily/);
    const d = {
      ...deps(),
      enqueueNotification: async () => {
        throw new Error("final result rollback");
      }
    };
    await expect(runScheduledReadJob({ data: s.data }, d)).rejects.toThrow(/final result rollback/);
    const before = (await ledger(s))!;
    expect(before).toMatchObject({ attempt_count: 2, attempt_state: "running", outcome: null });
    expect((await effects(s, t.expectedMessageId)).messages).toHaveLength(0);
    expect(await runScheduledReadJob({ data: s.data }, deps())).toBe("inactive");
    expect(await ledger(s)).toEqual(before);
    await expire(s);
    expect(await recoverScheduledReadOccurrence(t, bookkeeping)).toBe("failed");
    const after = await effects(s, t.expectedMessageId);
    expect(after.ledger).toMatchObject({
      attempt_count: 2,
      attempt_state: "terminal",
      outcome: "failed"
    });
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]?.body).toContain("outcome is unknown");
    expect(await recoverScheduledReadOccurrence(t, bookkeeping)).toBe("inactive");
  });

  it("consumed final allowance cannot admit a third execution after expiry", async () => {
    const s = await save();
    await finalAdmission(s);
    await expire(s);
    const d = deps();
    expect(await runScheduledReadJob({ data: s.data, retryCount: 0, retryLimit: 1 }, d)).toBe(
      "inactive"
    );
    expect(d.gateway.runBackgroundReadForActor).not.toHaveBeenCalled();
    expect(d.generateReport).not.toHaveBeenCalled();
    expect(await ledger(s)).toMatchObject({ attempt_count: 2, attempt_state: "terminal" });
  });

  it("late expired validation response cannot persist before bookkeeping recovery", async () => {
    const s = await save();
    const entered = barrier(),
      release = barrier();
    const read = vi.fn(async () => {
      if (read.mock.calls.length === 2) {
        entered.release();
        await release.wait;
      }
      return response(s);
    });
    const running = runScheduledReadJob(
      { data: s.data },
      { ...deps(), gateway: { runBackgroundReadForActor: read } }
    );
    await entered.wait;
    try {
      await expire(s);
    } finally {
      release.release();
    }
    expect(await running).toBe("inactive");
    expect(await ledger(s)).toMatchObject({
      attempt_count: 1,
      outcome: null,
      observation_key: null
    });
    expect((await effects(s, (await target(s)).expectedMessageId)).messages).toHaveLength(0);
  });

  it("paused then resumed final occurrence keeps allowance and retires under current version", async () => {
    const s = await save();
    const t = await target(s);
    await finalAdmission(s);
    await owner((db) => pauseReminderById(db, s.id));
    const before = await effects(s, t.expectedMessageId);
    expect(await recoverScheduledReadOccurrence(t, bookkeeping)).toBe("paused");
    expect(await effects(s, t.expectedMessageId)).toEqual(before);
    await owner((db) => resumeReminderById(db, boss, ids.userA, s.id));
    expect(await recoverScheduledReadOccurrence(t, bookkeeping)).toBe("failed");
    expect(await ledger(s)).toMatchObject({ attempt_count: 2, attempt_state: "terminal" });
  });

  it("future final occurrence defers once per current receipt and never advances early", async () => {
    const s = await save(true);
    await finalAdmission(s);
    await clock(s, "due_at=clock_timestamp()+interval '1 hour'");
    const current = (await ledger(s))!;
    const old = (await wakes(s)).find((j) => j.id === current.watchdog_job_id)!;
    expect(await wake(old)).toBe("deferred");
    expect(await wake(old)).toBe("stale");
    expect(await wakes(s)).toHaveLength(3);
    expect(await ledger(s)).toMatchObject({ attempt_count: 2, outcome: null, failure_streak: 0 });
    expect((await effects(s, (await target(s)).expectedMessageId)).runs).toHaveLength(0);
    await clock(s, "due_at=clock_timestamp()-interval '2 seconds'");
    await expire(s);
    expect(await recoverScheduledReadOccurrence(await target(s), bookkeeping)).toBe("failed");
  });

  it("deadline and deleted boundaries cannot invent failure or resurrect a schedule", async () => {
    const s = await save(true);
    const t = await target(s);
    await finalAdmission(s);
    await clock(
      s,
      "due_at=clock_timestamp()-interval '1 hour',deadline_at=clock_timestamp()-interval '1 second'"
    );
    expect(await recoverScheduledReadOccurrence(t, bookkeeping)).toBe("expired");
    const after = await effects(s, t.expectedMessageId);
    expect(after.runs[0]).toMatchObject({ outcome: "expired" });
    expect(after.messages).toHaveLength(0);
    expect(after.ledger?.failure_streak).toBe(0);
    const other = await save();
    const ot = await target(other);
    await finalAdmission(other);
    await owner((db) => deleteReminderById(db, other.id));
    expect(await recoverScheduledReadOccurrence(ot, bookkeeping)).toBe("inactive");
    expect(await ledger(other)).toBeUndefined();
  });

  it("legacy current identity retires truthfully without changing its baseline", async () => {
    const s = await save();
    const t = await target(s);
    await bootstrap.query(
      "UPDATE app.chat_scheduled_reads SET attempt_state='legacy_unknown',attempt_message_id=$2,observation_key=$3 WHERE reminder_id=$1",
      [s.id, t.expectedMessageId, "c".repeat(64)]
    );
    await locked(s, (db, r) => scheduleScheduledReadBookkeeping(db, r, boss, r.dueAt));
    const old = (await wakes(s))[0]!;
    expect(await wake(old)).toBe("failed");
    const after = await effects(s, t.expectedMessageId);
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]?.body).toContain("outcome");
    expect(after.messages[0]?.body).toContain("unknown");
    expect(after.ledger).toMatchObject({
      attempt_count: 0,
      attempt_state: "terminal",
      observation_key: "c".repeat(64)
    });
    expect(await recoveries(s)).toHaveLength(0);
    expect(await wake(old)).toBe("inactive");
  });

  it.each(["future", "paused", "expired", "terminal"] as const)(
    "legacy %s boundary preserves consumed uncertainty and performs no execution",
    async (disposition) => {
      const s = await save(true);
      const t = await target(s);
      await bootstrap.query(
        "UPDATE app.chat_scheduled_reads SET attempt_state='legacy_unknown',attempt_message_id=$2,observation_key=$3,failure_streak=2 WHERE reminder_id=$1",
        [s.id, t.expectedMessageId, "d".repeat(64)]
      );
      if (disposition === "future") await clock(s, "due_at=clock_timestamp()+interval '1 hour'");
      if (disposition === "expired")
        await clock(
          s,
          "due_at=clock_timestamp()-interval '1 hour',deadline_at=clock_timestamp()-interval '1 second'"
        );
      if (disposition === "paused") await owner((db) => pauseReminderById(db, s.id));
      if (disposition === "terminal") await owner((db) => deleteReminderById(db, s.id));
      const result = await recoverScheduledReadOccurrence(t, bookkeeping);
      expect(result).toBe(
        disposition === "future"
          ? "deferred"
          : disposition === "terminal"
            ? "inactive"
            : disposition
      );
      const row = await ledger(s);
      if (row)
        expect(row).toMatchObject({
          attempt_count: 0,
          observation_key: "d".repeat(64),
          failure_streak: 2
        });
      if (disposition !== "terminal") {
        const actual = await effects(s, t.expectedMessageId);
        expect(actual.messages).toHaveLength(0);
        expect(actual.runs).toHaveLength(disposition === "expired" ? 1 : 0);
        expect(actual.r.version).toBe(disposition === "paused" ? 2 : 1);
      }
      expect(await recoveries(s)).toHaveLength(0);
    }
  );

  it("bookkeeping successor enqueue failure rolls back its actual receipt", async () => {
    const s = await save();
    await locked(s, (db, r) => attempts.admitScheduledReadAttempt(db, r, boss));
    const old = (await wakes(s))[0]!;
    const before = await ledger(s);
    await expect(
      runScheduledReadBookkeepingJob(old, {
        ...bookkeeping,
        boss: sendThen(() => {
          throw new Error("after successor insert");
        })
      })
    ).rejects.toThrow(/after successor/);
    expect(await ledger(s)).toEqual(before);
    expect(await wakes(s)).toHaveLength(1);
    expect(await wake(old)).toBe("waiting");
    expect(await wake(old)).toBe("stale");
    expect(await wakes(s)).toHaveLength(2);
  });

  it("support recovery requires positive exhaustion, not a missing queue receipt", async () => {
    const s = await save();
    const t = await target(s);
    await expect(
      runScheduledReadJob(
        { data: s.data, retryCount: 0, retryLimit: 1 },
        { ...deps(), gateway: { runBackgroundReadForActor: vi.fn(async () => temporary()) } }
      )
    ).rejects.toThrow(/temporarily/);
    const explicit = (await recoveries(s))[0]!;
    expect(await recoverScheduledReadOccurrence(t, bookkeeping)).toBe("awaiting_recovery");
    await bootstrap.query(
      "UPDATE pgboss.job SET state='failed',retry_count=retry_limit WHERE id=$1",
      [explicit.id]
    );
    expect(await recoverScheduledReadOccurrence(t, bookkeeping)).toBe("failed");
    expect(await ledger(s)).toMatchObject({
      attempt_count: 1,
      attempt_state: "terminal",
      recovery_job_id: explicit.id
    });
    expect(await recoveries(s)).toHaveLength(1);
  });

  it("registered bookkeeping worker commits a real result and notification without execution providers", async () => {
    const s = await save();
    const t = await target(s);
    await bootstrap.query(
      "UPDATE app.chat_scheduled_reads SET attempt_state='legacy_unknown',attempt_message_id=$2 WHERE reminder_id=$1",
      [s.id, t.expectedMessageId]
    );
    const completed = barrier();
    // Observe completion after the real DataContextRunner transaction commits.
    const observed = {
      async withDataContext<T>(access: AccessContext, work: (db: DataContextDb) => Promise<T>) {
        const result = await worker.withDataContext(access, work);
        if (access.requestId === `scheduled-read:bookkeeping:${s.id}`) completed.release();
        return result;
      }
    } as DataContextRunner;
    await locked(s, (db, r) => scheduleScheduledReadBookkeeping(db, r, boss, r.dueAt));
    const id = await registerScheduledReadBookkeepingWorker(
      workerBoss,
      { dataContext: observed },
      { pollingIntervalSeconds: 0.5 }
    );
    try {
      await completed.wait;
      const after = await effects(s, t.expectedMessageId);
      expect(after.ledger).toMatchObject({
        attempt_count: 0,
        attempt_state: "terminal",
        outcome: "failed"
      });
      expect(after.messages).toHaveLength(1);
      expect(after.messages[0]?.body).toContain("unknown");
      expect(await jobs(s, "chat.notify-reminder")).toHaveLength(1);
      expect(await recoveries(s)).toHaveLength(0);
    } finally {
      await workerBoss.offWork(CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE, { id, wait: true });
    }
  });

  it("a paused ordinary reminder cannot be classified as a scheduled read", async () => {
    const s = await save();
    const t = await target(s);
    await bootstrap.query("DELETE FROM app.chat_scheduled_reads WHERE reminder_id=$1", [s.id]);
    await owner((db) => pauseReminderById(db, s.id));
    expect(await recoverScheduledReadOccurrence(t, bookkeeping)).toBe("inactive");
  });

  it("owner and exact identity gates deny foreign or obsolete cleanup", async () => {
    const s = await save();
    const t = await target(s);
    await finalAdmission(s);
    await expire(s);
    const before = await ledger(s);
    expect(
      await recoverScheduledReadOccurrence({ ...t, actorUserId: ids.userB }, bookkeeping)
    ).toBe("inactive");
    expect(
      await recoverScheduledReadOccurrence({ ...t, expectedMessageId: s.task.id }, bookkeeping)
    ).toBe("inactive");
    expect(await ledger(s)).toEqual(before);
  });
});
