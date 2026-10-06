import { WORKER_BOSS_OPTIONS } from "../../apps/worker/src/worker.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { Job } from "pg-boss";
import {
  MeetingCaptureRepository,
  captureState,
  captureView
} from "../../packages/meetings/src/capture-repository.js";
import {
  captureMaintenanceJobId,
  maintainMeetingCapture,
  registerMeetingCaptureMaintenanceWorker,
  MEETING_CAPTURE_MAINTENANCE_QUEUE,
  type CaptureMaintenancePayload
} from "../../packages/meetings/src/capture-maintenance.js";
import {
  bootstrap,
  context,
  runtime,
  producer,
  linkFixture,
  setupLinkDatabase,
  closeLinkDatabase
} from "./meeting-link-fixture.js";
import { connectionStrings } from "./test-database.js";

beforeAll(setupLinkDatabase);
afterAll(closeLinkDatabase);
const fixtures: Awaited<ReturnType<typeof linkFixture>>[] = [],
  consumers: PgBoss[] = [];
async function fixture() {
  const f = await linkFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const consumer of consumers.splice(0)) {
    await consumer.offWork(MEETING_CAPTURE_MAINTENANCE_QUEUE, { wait: true });
    await consumer.stop({ graceful: true });
  }
  const finished = fixtures.splice(0);
  await Promise.all(finished.map((f) => f.server.close()));
  await bootstrap.query(
    "DELETE FROM pgboss.job WHERE name=$1 AND data->>'actorUserId'=ANY($2::text[])",
    [MEETING_CAPTURE_MAINTENANCE_QUEUE, finished.map((f) => f.browser.actorUserId)]
  );
});
function payload(actorUserId: string, grantId: string, version = 0): CaptureMaintenancePayload {
  return {
    actorUserId,
    resourceId: grantId,
    version,
    idempotencyKey: captureMaintenanceJobId(grantId, version)
  };
}
async function worker(f: Awaited<ReturnType<typeof fixture>>) {
  const consumer = createPgBossClient(connectionStrings.worker);
  consumers.push(consumer);
  await consumer.start();
  await registerMeetingCaptureMaintenanceWorker(consumer, f.maintenance);
  return consumer;
}
describe("durable capture revocation maintenance (isolated gate only)", () => {
  it.each(["unlink", "permission", "session"] as const)(
    "R3 persists %s revocation within one lease without any further browser/native capture request",
    async (cause) => {
      const f = await fixture(),
        active = await f.begin();
      await worker(f);
      if (cause === "unlink")
        await runtime.companionDevices.logoutCredential({ headers: f.native });
      else if (cause === "permission")
        await runtime.recordingCapabilities.revoke(f.browser, f.deviceId);
      else {
        const other = await f.signin();
        await runtime.meSessions.revokeOne({
          actorUserId: f.browser.actorUserId,
          sessionId: f.browser.sessionId,
          headers: other
        });
      }
      const committedAt = Date.now();
      // Only direct fixture reads observe persistence; no request triggers lazy settlement.
      await expect
        .poll(async () => (await active.stored())?.status, { timeout: 29000, interval: 100 })
        .toBe("revoked");
      expect(Date.now() - committedAt).toBeLessThan(30000);
      expect(captureState((await active.stored())!).revocationReason).toBe(
        cause === "unlink"
          ? "device-unavailable"
          : cause === "permission"
            ? "recording-permission-revoked"
            : "session-ended"
      );
      expect(f.deps.transcribe).not.toHaveBeenCalled();
    }
  );
  it("R3 Start queue failure rolls back both live grant and partially inserted maintenance", async () => {
    const f = await fixture();
    const schedule = f.deps.scheduleMaintenance;
    vi.spyOn(f.deps, "scheduleMaintenance").mockImplementation(async (...args) => {
      await schedule(...args);
      throw new Error("Synthetic failure before app commit");
    });
    await expect(f.start()).rejects.toThrow("Synthetic failure before app commit");
    expect(
      (
        await bootstrap.query("SELECT 1 FROM app.meeting_capture_grants WHERE owner_user_id=$1", [
          f.browser.actorUserId
        ])
      ).rows
    ).toEqual([]);
    expect(
      (
        await bootstrap.query(
          "SELECT 1 FROM pgboss.job WHERE name=$1 AND data->>'actorUserId'=$2",
          [MEETING_CAPTURE_MAINTENANCE_QUEUE, f.browser.actorUserId]
        )
      ).rows
    ).toEqual([]);
  });
  it("R3 rollback keeps the current checkpoint retryable; post-commit replay cannot fork a successor", async () => {
    const f = await fixture(),
      active = await f.begin();
    const job = payload(f.browser.actorUserId, active.grantId),
      schedule = f.maintenance.scheduleMaintenance;
    const original = (await active.stored())!;
    const beforeRevision = captureView(original, captureState(original), f.now()).revision;
    const fail = vi
      .spyOn(f.maintenance, "scheduleMaintenance")
      .mockImplementationOnce(async (...args) => {
        await schedule(...args);
        throw new Error("Synthetic successor commit failure");
      });
    await expect(maintainMeetingCapture(job, f.maintenance)).rejects.toThrow(
      "Synthetic successor commit failure"
    );
    expect(captureState((await active.stored())!).maintenanceSequence).toBe(0);
    expect(
      await producer.getJobById(
        MEETING_CAPTURE_MAINTENANCE_QUEUE,
        captureMaintenanceJobId(active.grantId, 1)
      )
    ).toBeNull();
    fail.mockRestore();
    await maintainMeetingCapture(job, f.maintenance);
    await maintainMeetingCapture(job, f.maintenance); // same delivery after a simulated lost completion acknowledgement
    const stored = (await active.stored())!;
    expect(captureState(stored).maintenanceSequence).toBe(1);
    expect(captureView(stored, captureState(stored), f.now()).revision).toBe(beforeRevision);
    const jobs = await bootstrap.query(
      "SELECT data FROM pgboss.job WHERE name=$1 AND data->>'resourceId'=$2 ORDER BY (data->>'version')::int",
      [MEETING_CAPTURE_MAINTENANCE_QUEUE, active.grantId]
    );
    expect(jobs.rows.map((row) => row.data.version)).toEqual([0, 1]);
    for (const row of jobs.rows)
      expect(Object.keys(row.data).sort()).toEqual([
        "actorUserId",
        "idempotencyKey",
        "resourceId",
        "version"
      ]);
    // A fresh worker instance consumes durable jobs after a process restart.
    await runtime.companionDevices.logoutCredential({ headers: f.native });
    await worker(f);
    await expect
      .poll(async () => (await active.stored())?.status, { timeout: 29000, interval: 100 })
      .toBe("revoked");
  });
  it.each(["stop", "cancel", "expiry"] as const)(
    "R3 %s terminates the chain without a successor",
    async (cause) => {
      const f = await fixture(),
        started = await f.start(),
        grantId = started.capture.grantId;
      if (cause === "stop")
        await f.service.browserControl(f.browser, f.meeting.id, {
          grantId,
          requestKey: randomUUID(),
          expectedGeneration: 1,
          command: "stop"
        });
      else if (cause === "cancel") await f.service.cancelStart(f.browser, f.meeting.id, f.input);
      else
        await bootstrap.query(
          "UPDATE app.meeting_capture_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [grantId]
        );
      await maintainMeetingCapture(payload(f.browser.actorUserId, grantId), f.maintenance);
      expect(
        await producer.getJobById(
          MEETING_CAPTURE_MAINTENANCE_QUEUE,
          captureMaintenanceJobId(grantId, 1)
        )
      ).toBeNull();
      if (cause === "expiry")
        expect(
          (
            await context.withDataContext(f.browser, (db) =>
              new MeetingCaptureRepository().grant(db, grantId)
            )
          )?.status
        ).toBe("revoked");
    }
  );
  it("R3 recovers an actually active crashed job within one lease measured from unlink after the prior check", async () => {
    const f = await fixture(),
      active = await f.begin();
    const crashed = createPgBossClient(connectionStrings.worker);
    consumers.push(crashed);
    await crashed.start();
    const firstId = captureMaintenanceJobId(active.grantId, 0);
    // Isolate this fixture's jobs by priority, without changing their real scheduled times.
    await bootstrap.query("UPDATE pgboss.job SET priority=100 WHERE id=$1", [firstId]);
    let first: Job<CaptureMaintenancePayload> | undefined;
    await expect
      .poll(
        async () => {
          first = (
            await crashed.fetch<CaptureMaintenancePayload>(MEETING_CAPTURE_MAINTENANCE_QUEUE, {
              minPriority: 100
            })
          )[0];
          return first?.id;
        },
        { timeout: 10000, interval: 100 }
      )
      .toBe(firstId);
    await maintainMeetingCapture(first!.data, f.maintenance);
    await crashed.complete(MEETING_CAPTURE_MAINTENANCE_QUEUE, firstId);
    const nextId = captureMaintenanceJobId(active.grantId, 1);
    await bootstrap.query("UPDATE pgboss.job SET priority=100 WHERE id=$1", [nextId]);
    await runtime.companionDevices.logoutCredential({ headers: f.native });
    const unlinkedAt = Date.now();
    // The successor must wait for its ordinary 5-second cadence before it becomes active.
    await expect
      .poll(
        async () =>
          (
            await crashed.fetch<CaptureMaintenancePayload>(MEETING_CAPTURE_MAINTENANCE_QUEUE, {
              minPriority: 100
            })
          )[0]?.id,
        { timeout: 10000, interval: 100 }
      )
      .toBe(nextId);
    expect((await producer.getJobById(MEETING_CAPTURE_MAINTENANCE_QUEUE, nextId))?.state).toBe(
      "active"
    );
    await crashed.stop({ graceful: false }); // no completion acknowledgement; the durable row stays active
    expect((await producer.getJobById(MEETING_CAPTURE_MAINTENANCE_QUEUE, nextId))?.state).toBe(
      "active"
    );
    const supervisor = createPgBossClient(connectionStrings.worker, {
      ...WORKER_BOSS_OPTIONS,
      schedule: false
    });
    consumers.push(supervisor);
    await supervisor.start();
    await worker(f);
    await expect
      .poll(async () => (await active.stored())?.status, { timeout: 29000, interval: 100 })
      .toBe("revoked");
    expect(Date.now() - unlinkedAt).toBeLessThan(30000);
  }, 45000);
  it("R3 aborting a held real auth query drains both owned connections without false revocation", async () => {
    const f = await fixture(),
      active = await f.begin(),
      blocker = await bootstrap.connect();
    const controller = new AbortController();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE app.companion_recording_capabilities IN ACCESS EXCLUSIVE MODE"
      );
      const pending = maintainMeetingCapture(
        payload(f.browser.actorUserId, active.grantId),
        f.maintenance,
        controller.signal
      );
      const failure = pending.catch((error: unknown) => error);
      await expect
        .poll(
          async () =>
            Number(
              (
                await bootstrap.query(
                  "SELECT count(*) AS count FROM pg_stat_activity WHERE application_name='moss-capture-auth-maintenance' AND wait_event_type='Lock'"
                )
              ).rows[0].count
            ),
          { timeout: 1500, interval: 20 }
        )
        .toBeGreaterThan(0);
      controller.abort(new Error("synthetic job cancellation"));
      await failure;
      expect((await active.stored())?.status).toBe("active");
      expect(captureState((await active.stored())!).maintenanceSequence).toBe(0);
      expect(
        Number(
          (
            await bootstrap.query(
              "SELECT count(*) AS count FROM pg_stat_activity WHERE application_name IN ('moss-capture-auth-maintenance','moss-abortable-data-context')"
            )
          ).rows[0].count
        )
      ).toBe(0);
    } finally {
      controller.abort();
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    await maintainMeetingCapture(payload(f.browser.actorUserId, active.grantId), f.maintenance);
    expect(captureState((await active.stored())!).maintenanceSequence).toBe(1);
  });
  it("R3 a held auth query times out, drains on shutdown and retries its checkpoint after recovery", async () => {
    const f = await fixture(),
      active = await f.begin(),
      blocker = await bootstrap.connect();
    const consumer = await worker(f);
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE app.companion_recording_capabilities IN ACCESS EXCLUSIVE MODE"
      );
      await expect
        .poll(
          async () =>
            Number(
              (
                await bootstrap.query(
                  "SELECT count(*) AS count FROM pg_stat_activity WHERE application_name='moss-capture-auth-maintenance' AND wait_event_type='Lock'"
                )
              ).rows[0].count
            ),
          { timeout: 10000, interval: 20 }
        )
        .toBeGreaterThan(0);
      const started = Date.now();
      await consumer.offWork(MEETING_CAPTURE_MAINTENANCE_QUEUE, { wait: true });
      expect(Date.now() - started).toBeLessThan(5000);
      expect((await active.stored())?.status).toBe("active");
      expect(captureState((await active.stored())!).maintenanceSequence).toBe(0);
      expect(
        (
          await producer.getJobById(
            MEETING_CAPTURE_MAINTENANCE_QUEUE,
            captureMaintenanceJobId(active.grantId, 0)
          )
        )?.state
      ).toBe("retry");
      expect(
        Number(
          (
            await bootstrap.query(
              "SELECT count(*) AS count FROM pg_stat_activity WHERE application_name IN ('moss-capture-auth-maintenance','moss-abortable-data-context')"
            )
          ).rows[0].count
        )
      ).toBe(0);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    await registerMeetingCaptureMaintenanceWorker(consumer, f.maintenance);
    await expect
      .poll(async () => captureState((await active.stored())!).maintenanceSequence, {
        timeout: 10000,
        interval: 100
      })
      .toBeGreaterThan(0);
  });
});
