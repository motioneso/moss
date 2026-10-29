import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  seedScheduledReadCutover,
  recoverScheduledReadCutover,
  validateScheduledReadCutover,
  type ScheduledReadSupportDeps
} from "../../packages/chat/src/scheduled-reads/cutover.js";
import {
  executeRecoveryInvocation,
  parseRecoveryInvocation
} from "../../scripts/recover-scheduled-read-occurrences.js";
import { runScheduledReadJob } from "../../packages/chat/src/scheduled-reads/runner.js";
import { runScheduledReadBookkeepingJob } from "../../packages/chat/src/scheduled-reads/bookkeeping.js";
import { resumeReminderById } from "../../packages/chat/src/reminders/controls.js";
import { reminderFeatures } from "../../packages/chat/src/reminders/features.js";
import {
  CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
  type ScheduledReadWatchdogPayload
} from "../../packages/chat/src/scheduled-reads/queue.js";
import { ids, connectionStrings } from "./test-database.js";
import { admitScheduledReadAttempt } from "../../packages/chat/src/scheduled-reads/attempts.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import {
  worker,
  workerBoss,
  bootstrap,
  owner,
  save as saveFixture
} from "./scheduled-read-fixture.js";

type Saved = Awaited<ReturnType<typeof saveFixture>>;
type Legacy = {
  repeat?: boolean;
  state?: string;
  future?: boolean;
  expired?: boolean;
  outcome?: string | null;
};
const owned: string[] = [];
const deps = (): ScheduledReadSupportDeps => ({ dataContext: worker, boss: workerBoss });
afterEach(async () => {
  vi.restoreAllMocks();
  await bootstrap.query("DELETE FROM app.chat_reminders WHERE id=ANY($1::uuid[])", [
    owned.splice(0)
  ]);
});
const target = async (s: Saved) => ({
  actorUserId: ids.userA,
  resourceId: s.id,
  expectedMessageId: (
    await bootstrap.query("SELECT reserved_message_id FROM app.chat_reminders WHERE id=$1", [s.id])
  ).rows[0].reserved_message_id as string
});
async function targetsFor(saved: Saved[]) {
  const targets = [];
  for (const s of saved) targets.push(await target(s));
  return targets;
}
const ledger = async (s: Saved) =>
  (await bootstrap.query("SELECT * FROM app.chat_scheduled_reads WHERE reminder_id=$1", [s.id]))
    .rows[0];
const row = async (s: Saved) =>
  (await bootstrap.query("SELECT * FROM app.chat_reminders WHERE id=$1", [s.id])).rows[0];
const jobs = async (s: Saved, name = CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE) =>
  (
    await bootstrap.query<{ id: string; data: ScheduledReadWatchdogPayload; start_after: Date }>(
      "SELECT id,data,start_after FROM pgboss.job WHERE name=$1 AND data->>'resourceId'=$2 ORDER BY created_on,id",
      [name, s.id]
    )
  ).rows;
const runs = async (s: Saved) =>
  (await bootstrap.query("SELECT * FROM app.chat_reminder_runs WHERE reminder_id=$1", [s.id])).rows;
const messages = async (messageId: string) =>
  owner((db) =>
    db.db.selectFrom("app.chat_messages").selectAll().where("id", "=", messageId).execute()
  );
async function adjust(s: Saved, patch: Legacy) {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role=replica");
    await bootstrap.query(
      `UPDATE app.chat_reminders SET state=$2,due_at=clock_timestamp()+$3::interval,deadline_at=CASE WHEN $4 THEN clock_timestamp()-interval '1 minute' ELSE NULL END, timing=CASE WHEN $4 AND repeat_kind IS NULL THEN 'local_clock' ELSE timing END, delay_seconds=CASE WHEN $4 AND repeat_kind IS NULL THEN NULL ELSE delay_seconds END, local_due=CASE WHEN $4 AND repeat_kind IS NULL THEN to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') ELSE local_due END, time_zone=CASE WHEN $4 AND repeat_kind IS NULL THEN 'UTC' ELSE time_zone END, delivered_at=CASE WHEN $2='delivered' THEN clock_timestamp() ELSE NULL END, late=CASE WHEN $2='delivered' THEN false ELSE NULL END, expired_at=CASE WHEN $2='expired' THEN clock_timestamp() ELSE NULL END WHERE id=$1`,
      [s.id, patch.state ?? "queued", patch.future ? "1 day" : "-2 minutes", patch.expired ?? false]
    );
    await bootstrap.query("COMMIT");
  } catch (e) {
    await bootstrap.query("ROLLBACK");
    throw e;
  }
}

async function applyLegacyMigration() {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL ROLE jarvis_migration_owner");
    await bootstrap.query(
      await readFile(
        new URL("../../packages/chat/sql/0324_chat_scheduled_read_attempts.sql", import.meta.url),
        "utf8"
      )
    );
    await bootstrap.query("COMMIT");
  } catch (e) {
    await bootstrap.query("ROLLBACK");
    throw e;
  }
}

/** Create through the application on the real pre-0324 schema, then apply immutable A DDL. */
async function legacy(specs: Legacy[]) {
  await bootstrap.query("BEGIN");
  try {
    for (const name of [
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
    ])
      await bootstrap.query(`ALTER TABLE app.chat_scheduled_reads DROP COLUMN ${name} CASCADE`);
    await bootstrap.query(
      "CREATE POLICY chat_scheduled_reads_insert ON app.chat_scheduled_reads FOR INSERT TO jarvis_app_runtime WITH CHECK (owner_user_id=app.current_actor_user_id() AND outcome IS NULL AND observation_key IS NULL AND failure_streak=0 AND EXISTS (SELECT 1 FROM app.chat_reminders r WHERE r.id=reminder_id AND r.owner_user_id=app.current_actor_user_id() AND r.state='queued'))"
    );
    await bootstrap.query("GRANT INSERT ON app.chat_scheduled_reads TO jarvis_app_runtime");
    await bootstrap.query("COMMIT");
  } catch (e) {
    await bootstrap.query("ROLLBACK");
    throw e;
  }
  const saved: Saved[] = [];
  const before = [];
  try {
    for (const spec of specs) {
      const s = await saveFixture(spec.repeat);
      owned.push(s.id);
      saved.push(s);
      await adjust(s, spec);
      await bootstrap.query(
        "UPDATE app.chat_scheduled_reads SET observation_key=repeat('a',64),failure_streak=2,outcome=$2 WHERE reminder_id=$1",
        [s.id, spec.outcome ?? null]
      );
    }
    for (const s of saved) before.push({ reminder: await row(s), scheduled: await ledger(s) });
  } finally {
    await applyLegacyMigration();
  }
  return { saved, before };
}

describe("finite owner-scoped cutover on the actual pre-migration schema", () => {
  it("quarantines full legacy matrix without changing saved facts or inventing allowance", async () => {
    const specs: Legacy[] = [
      {},
      { repeat: true, outcome: "success" },
      { future: true },
      { repeat: true, future: true },
      { state: "paused" },
      { repeat: true, state: "paused" },
      { state: "paused", expired: true },
      { repeat: true, state: "paused", expired: true },
      { expired: true },
      { repeat: true, expired: true },
      { state: "cancelled" },
      { repeat: true, state: "cancelled" },
      { state: "delivered" },
      { repeat: true, state: "failed" },
      { state: "expired" },
      { state: "paused", future: true },
      { repeat: true, state: "paused", future: true },
      { state: "failed" },
      { repeat: true, state: "delivered" },
      { repeat: true, state: "expired" }
    ];
    const { saved, before } = await legacy(specs);
    for (const [i, s] of saved.entries()) {
      expect(await row(s)).toEqual(before[i]!.reminder);
      const l = await ledger(s);
      expect(l).toMatchObject(before[i]!.scheduled);
      expect(l).toMatchObject({ attempt_count: 0, recovery_job_id: null, attempt_token: null });
      expect(l.attempt_state).toBe(
        ["queued", "paused"].includes(specs[i]!.state ?? "queued") ? "legacy_unknown" : "ready"
      );
      expect(await runs(s)).toHaveLength(0);
    }
    const targets = await targetsFor(saved);
    await validateScheduledReadCutover(targets, 20, deps());
    const receipts = [];
    for (const t of targets) receipts.push(await seedScheduledReadCutover(t, deps()));
    expect(receipts.map((r) => r.status)).toEqual([
      "seeded",
      "seeded",
      "seeded",
      "seeded",
      "paused",
      "paused",
      "paused",
      "paused",
      "seeded",
      "seeded",
      "terminal",
      "terminal",
      "terminal",
      "terminal",
      "terminal",
      "paused",
      "paused",
      "terminal",
      "terminal",
      "terminal"
    ]);
    for (const i of [0, 1, 2, 3, 8, 9]) {
      const s = saved[i]!;
      const t = targets[i]!;
      const [j] = await jobs(s);
      expect(j!.id).toBe(receipts[i]!.jobId);
      expect(j!.data).toEqual({
        actorUserId: ids.userA,
        resourceId: s.id,
        version: before[i]!.reminder.version,
        idempotencyKey: t.expectedMessageId,
        step: 1
      });
      expect(j!.start_after.getTime()).toBeGreaterThanOrEqual(before[i]!.reminder.due_at.getTime());
      expect(await seedScheduledReadCutover(t, deps())).toMatchObject({
        status: "already_seeded",
        jobId: j!.id
      });
      expect(await jobs(s)).toHaveLength(1);
      if (i === 2 || i === 3) {
        expect(await runScheduledReadBookkeepingJob(j!, deps())).toBe("deferred");
        expect(await row(s)).toEqual(before[i]!.reminder);
        expect(await ledger(s)).toMatchObject({
          attempt_state: "legacy_unknown",
          attempt_count: 0
        });
        expect(await runs(s)).toHaveLength(0);
      } else {
        expect(await recoverScheduledReadCutover(t, deps())).toMatchObject({
          status: i >= 8 ? "expired" : "failed"
        });
        expect(await messages(t.expectedMessageId)).toHaveLength(i >= 8 ? 0 : 1);
        if (i === 1) {
          const next = await row(s);
          expect(next.reserved_message_id).not.toBe(t.expectedMessageId);
          expect(next.due_at.getTime()).toBeGreaterThan(Date.now());
          expect(next.version).toBe(before[i]!.reminder.version + 1);
          expect(await ledger(s)).toMatchObject({
            attempt_state: "ready",
            attempt_message_id: null,
            attempt_count: 0,
            observation_key: "a".repeat(64),
            failure_streak: 3
          });
          expect(await runs(s)).toMatchObject([{ outcome: "failed" }]);
          expect(await jobs(s, "chat.notify-reminder")).toHaveLength(1);
          expect(await jobs(s, "chat.scheduled-read")).toHaveLength(2); // original plus one next, no backlog
        } else {
          expect((await row(s)).reserved_message_id).toBe(t.expectedMessageId);
          expect(await ledger(s)).toMatchObject({
            attempt_count: 0,
            attempt_state: "terminal",
            observation_key: "a".repeat(64),
            failure_streak: 2
          });
          if (i === 9) expect(await runs(s)).toMatchObject([{ outcome: "expired" }]);
        }
      }
    }
    for (const i of [4, 5, 6, 7, 15, 16]) {
      const s = saved[i]!;
      expect(await recoverScheduledReadCutover(targets[i]!, deps())).toMatchObject({
        status: "paused"
      });
      expect(await row(s)).toEqual(before[i]!.reminder);
      expect(await jobs(s)).toHaveLength(0);
      expect(await runs(s)).toHaveLength(0);
      expect(await ledger(s)).toMatchObject({ attempt_state: "legacy_unknown", attempt_count: 0 });
    }
    for (const i of [10, 11, 12, 13, 14, 17, 18, 19]) {
      expect(await recoverScheduledReadCutover(targets[i]!, deps())).toMatchObject({
        status: "inactive"
      });
      expect(await row(saved[i]!)).toEqual(before[i]!.reminder);
      expect(await jobs(saved[i]!)).toHaveLength(0);
    }
  });

  it("commits real seed receipts per entry, rolls back send-before-error, and retries only unfinished seed", async () => {
    const { saved } = await legacy([{}, {}, { future: true }]);
    const targets = await targetsFor(saved);
    const invocation = parseRecoveryInvocation(
      ["seed", "--manifest", "private.json", "--limit", "3"],
      JSON.stringify(targets)
    );
    const send = workerBoss.send.bind(workerBoss);
    let fail = true;
    vi.spyOn(workerBoss, "send").mockImplementation(async (...args) => {
      const id = await send(...args);
      const data = args[1];
      if (
        fail &&
        data &&
        typeof data === "object" &&
        "resourceId" in data &&
        data.resourceId === saved[1]!.id
      )
        throw new Error("private database error after durable send");
      return id;
    });
    const receipt = await executeRecoveryInvocation(invocation, deps());
    expect(receipt.exitCode).toBe(1);
    expect(receipt.counts).toMatchObject({ successful: 2, failed: 1 });
    expect(JSON.stringify(receipt)).not.toContain("private database error");
    expect(await jobs(saved[1]!)).toHaveLength(0);
    expect(await ledger(saved[1]!)).toMatchObject({
      watchdog_job_id: null,
      watchdog_generation: 0
    });
    const first = await ledger(saved[0]!);
    const third = await ledger(saved[2]!);
    fail = false;
    expect((await executeRecoveryInvocation(invocation, deps())).exitCode).toBe(0);
    expect(await ledger(saved[0]!)).toEqual(first);
    expect(await ledger(saved[2]!)).toEqual(third);
    for (const s of saved) expect(await jobs(s)).toHaveLength(1);
  });

  it.each(["cancelled", "completed", "failed"])(
    "rejects terminal retained seed jobs (%s) with partial receipts and no replacement",
    async (state) => {
      const { saved } = await legacy([{}, { future: true }]);
      const targets = await targetsFor(saved);
      for (const t of targets) await seedScheduledReadCutover(t, deps());
      const pending = saved[1]!;
      const before = await ledger(pending);
      const reminder = await row(pending);
      await bootstrap.query("UPDATE pgboss.job SET state=$2 WHERE id=$1", [
        before.watchdog_job_id,
        state
      ]);
      const queueBefore = await bootstrap.query(
        "SELECT * FROM pgboss.job WHERE data->>'resourceId'=$1 ORDER BY id",
        [pending.id]
      );
      const send = vi.spyOn(workerBoss, "send");
      const invocation = parseRecoveryInvocation(
        ["seed", "--manifest", "private.json", "--limit", "2"],
        JSON.stringify(targets)
      );
      const receipt = await executeRecoveryInvocation(invocation, deps());
      expect(receipt.exitCode).toBe(1);
      expect(receipt.counts).toEqual({ successful: 1, failed: 1, deferred: 0, terminal: 0 });
      expect(receipt.entries).toEqual([
        {
          ...targets[0]!,
          status: "already_seeded",
          jobId: (await ledger(saved[0]!)).watchdog_job_id
        },
        { ...targets[1]!, status: "error", error: "operation_failed" }
      ]);
      expect(send).not.toHaveBeenCalled();
      expect(await ledger(pending)).toEqual(before);
      expect(await row(pending)).toEqual(reminder);
      expect(
        (
          await bootstrap.query(
            "SELECT * FROM pgboss.job WHERE data->>'resourceId'=$1 ORDER BY id",
            [pending.id]
          )
        ).rows
      ).toEqual(queueBefore.rows);
    }
  );

  it.each(["created", "retry", "active"])("retains live seed receipts (%s)", async (state) => {
    const { saved } = await legacy([{}]);
    const s = saved[0]!;
    const t = await target(s);
    const receipt = await seedScheduledReadCutover(t, deps());
    await bootstrap.query("UPDATE pgboss.job SET state=$2 WHERE id=$1", [receipt.jobId, state]);
    const before = await ledger(s);
    expect(await seedScheduledReadCutover(t, deps())).toEqual({
      ...t,
      status: "already_seeded",
      jobId: receipt.jobId
    });
    expect(await ledger(s)).toEqual(before);
    expect(await jobs(s)).toHaveLength(1);
  });

  it("preserves completed-occurrence semantics even when its seed job is terminal", async () => {
    const { saved } = await legacy([{}]);
    const s = saved[0]!;
    const t = await target(s);
    const receipt = await seedScheduledReadCutover(t, deps());
    expect((await recoverScheduledReadCutover(t, deps())).status).toBe("failed");
    await bootstrap.query("UPDATE pgboss.job SET state='completed' WHERE id=$1", [receipt.jobId]);
    const before = await ledger(s);
    const reminder = await row(s);
    const send = vi.spyOn(workerBoss, "send");
    expect(await seedScheduledReadCutover(t, deps())).toEqual({ ...t, status: "terminal" });
    expect(await ledger(s)).toEqual(before);
    expect(await row(s)).toEqual(reminder);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects foreign, stale and missing identities in the whole batch before any effects", async () => {
    const { saved } = await legacy([{}, {}]);
    const targets = await targetsFor(saved);
    for (const bad of [
      { ...targets[1]!, actorUserId: ids.userB },
      { ...targets[1]!, expectedMessageId: randomUUID() },
      { ...targets[1]!, resourceId: randomUUID() }
    ]) {
      const invocation = parseRecoveryInvocation(
        ["seed", "--manifest", "private.json", "--limit", "2"],
        JSON.stringify([targets[0], bad])
      );
      await expect(executeRecoveryInvocation(invocation, deps())).rejects.toThrow("mismatch");
      await expect(seedScheduledReadCutover(bad, deps())).rejects.toThrow("mismatch");
    }
    for (const s of saved) {
      expect(await jobs(s)).toHaveLength(0);
      expect((await ledger(s)).watchdog_job_id).toBeNull();
    }
  });

  it("retains paused identity on resume and expires it without inventing failure or replacement", async () => {
    const { saved } = await legacy([
      { state: "paused", expired: true },
      { repeat: true, state: "paused" }
    ]);
    for (const [i, s] of saved.entries()) {
      const t = await target(s);
      await owner((db) => resumeReminderById(db, workerBoss, ids.userA, s.id));
      expect((await row(s)).reserved_message_id).toBe(t.expectedMessageId);
      expect((await ledger(s)).attempt_count).toBe(0);
      const result = await recoverScheduledReadCutover(t, deps());
      expect(result.status).toBe(i === 0 ? "expired" : "failed");
      if (i === 0) {
        expect((await row(s)).state).toBe("expired");
        expect(await messages(t.expectedMessageId)).toHaveLength(0);
      } else expect((await row(s)).reserved_message_id).not.toBe(t.expectedMessageId);
    }
  });

  it("never replaces a missing durable seed receipt or supplies fresh allowance to governed rows", async () => {
    const { saved } = await legacy([{}]);
    const s = saved[0]!;
    const t = await target(s);
    const first = await seedScheduledReadCutover(t, deps());
    await bootstrap.query("DELETE FROM pgboss.job WHERE id=$1", [first.jobId]);
    await expect(seedScheduledReadCutover(t, deps())).rejects.toThrow("receipt unavailable");
    expect(await jobs(s)).toHaveLength(0);
    expect((await ledger(s)).watchdog_job_id).toBe(first.jobId);
    const fresh = await saveFixture();
    owned.push(fresh.id);
    await expect(seedScheduledReadCutover(await target(fresh), deps())).rejects.toThrow(
      "quarantined"
    );
    expect((await ledger(fresh)).attempt_state).toBe("ready");
  });

  it("ordinary delivery of a due legacy occurrence performs only bookkeeping, with zero provider dispatch", async () => {
    const { saved } = await legacy([{}]);
    const s = saved[0]!;
    const gateway = vi.fn();
    const generateReport = vi.fn();
    const result = await runScheduledReadJob(
      { data: s.data, retryCount: 0, retryLimit: 2 },
      {
        ...deps(),
        gateway: { runBackgroundReadForActor: gateway },
        generateReport
      }
    );
    expect(result).toBe("inactive");
    expect(gateway).not.toHaveBeenCalled();
    expect(generateReport).not.toHaveBeenCalled();
    expect(await ledger(s)).toMatchObject({ attempt_state: "terminal", attempt_count: 0 });
  });

  it("serial concurrent seed reruns retain one actual generation and job", async () => {
    const { saved } = await legacy([{}]);
    const s = saved[0]!;
    const t = await target(s);
    const results = await Promise.all([
      seedScheduledReadCutover(t, deps()),
      seedScheduledReadCutover(t, deps())
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_seeded", "seeded"]);
    expect(results[0]!.jobId).toBe(results[1]!.jobId);
    expect(await jobs(s)).toHaveLength(1);
    expect(await ledger(s)).toMatchObject({ watchdog_generation: 1, attempt_count: 0 });
  });

  it("composes recovery with active/final protection and never refills or resends execution", async () => {
    const s = await saveFixture(true);
    owned.push(s.id);
    const t = await target(s);
    const admit = () =>
      worker.withDataContext({ actorUserId: ids.userA }, async (db) => {
        const r = await new ReminderRepository().lockForDelivery(db, s.id);
        return admitScheduledReadAttempt(db, r!, workerBoss);
      });
    expect((await admit())?.ordinal).toBe(1);
    expect((await recoverScheduledReadCutover(t, deps())).status).toBe("in_flight");
    await bootstrap.query(
      "UPDATE app.chat_scheduled_reads SET attempt_lease_until=clock_timestamp()-interval '1 second' WHERE reminder_id=$1",
      [s.id]
    );
    expect((await recoverScheduledReadCutover(t, deps())).status).toBe("recovery_dispatched");
    const receipt = (await ledger(s)).recovery_job_id;
    expect((await recoverScheduledReadCutover(t, deps())).status).toBe("awaiting_recovery");
    expect((await ledger(s)).recovery_job_id).toBe(receipt);
    expect((await admit())?.ordinal).toBe(2);
    const active = await ledger(s);
    expect((await recoverScheduledReadCutover(t, deps())).status).toBe("in_flight");
    expect(await ledger(s)).toEqual(active);
    await bootstrap.query(
      "UPDATE app.chat_scheduled_reads SET attempt_lease_until=clock_timestamp()-interval '1 second' WHERE reminder_id=$1",
      [s.id]
    );
    expect((await recoverScheduledReadCutover(t, deps())).status).toBe("failed");
    expect(await runs(s)).toMatchObject([{ outcome: "failed" }]);
    // Only real advancement gave the next occurrence a new ready ledger.
    expect((await row(s)).reserved_message_id).not.toBe(t.expectedMessageId);
    expect(await ledger(s)).toMatchObject({ attempt_state: "ready", attempt_count: 0 });
    expect(await jobs(s, "chat.scheduled-read")).toHaveLength(3); // original, one recovery, one next
  });

  it("runs the actual bounded CLI with worker credentials and rejects app-role credentials before effects", async () => {
    const { saved } = await legacy([{}]);
    const s = saved[0]!;
    const t = await target(s);
    const dir = await mkdtemp(join(tmpdir(), "r06-support-cli-"));
    const file = join(dir, "manifest.json");
    const args = [
      "--import",
      "tsx",
      "scripts/recover-scheduled-read-occurrences.ts",
      "seed",
      "--manifest",
      file,
      "--limit",
      "1"
    ];
    try {
      await writeFile(file, JSON.stringify([t]), { mode: 0o600 });
      const child = promisify(execFile);
      await expect(
        child(process.execPath, args, {
          env: {
            ...process.env,
            JARVIS_WORKER_DATABASE_URL: connectionStrings.app,
            MOSS_WORKER_DATABASE_URL: connectionStrings.app
          },
          timeout: 15000,
          maxBuffer: 16384
        })
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Scheduled read support failed")
      });
      expect(await jobs(s)).toHaveLength(0);
      const result = await child(process.execPath, args, { timeout: 15000, maxBuffer: 16384 });
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: "seed",
        exitCode: 0,
        entries: [{ ...t, status: "seeded" }],
        counts: { successful: 1, failed: 0 }
      });
      expect(await jobs(s)).toHaveLength(1);
      const second = await child(process.execPath, args, { timeout: 15000, maxBuffer: 16384 });
      expect(JSON.parse(second.stdout).entries[0]).toMatchObject({
        status: "already_seeded",
        jobId: (await ledger(s)).watchdog_job_id
      });
      expect(await jobs(s)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps app-map recovery, interrupted bookkeeping and conservative upgrade guidance truthful", () => {
    const feature = reminderFeatures.find((f) => f.id === "chat.scheduled_owner_read")!;
    expect(feature.description).toContain("one recovery attempt");
    expect(
      feature.errors?.find((e) => e.code === "scheduled_read_legacy_unknown")?.description
    ).toContain("One-time checks receive no automatic replacement");
    expect(
      feature.errors?.find((e) => e.code === "scheduled_read_interrupted")?.description
    ).toContain("without reading the task again");
  });
});
