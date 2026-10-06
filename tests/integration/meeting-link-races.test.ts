import { MeetingCaptureRepository } from "../../packages/meetings/src/capture-repository.js";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MeetingTranscriptRepository } from "../../packages/meetings/src/transcript-repository.js";
import { captureAuthorizationError } from "../../packages/meetings/src/capture-authorization.js";
import { connectionStrings } from "./test-database.js";
import {
  bootstrap,
  runtime,
  linkFixture,
  setupLinkDatabase,
  closeLinkDatabase
} from "./meeting-link-fixture.js";

beforeAll(setupLinkDatabase);
afterAll(closeLinkDatabase);
const fixtures: Awaited<ReturnType<typeof linkFixture>>[] = [];
async function fixture() {
  const f = await linkFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((f) => f.server.close()));
});
function barrier() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
class ProtectedProjectionFailure extends Error {}
function assertOwnerProjection(rows: readonly { owner_user_id: string }[], owner: string) {
  if (rows.some((row) => row.owner_user_id !== owner))
    throw new ProtectedProjectionFailure("Owner grant projection was exposed");
}
async function assertSecretProjectionDenied(client: pg.PoolClient) {
  try {
    const result = await client.query(
      "SELECT credential_hash,verifier_hash FROM app.meeting_capture_grants"
    );
    if (!result.rows[0]?.credential_hash || !result.rows[0]?.verifier_hash)
      throw new Error("Expected an owned synthetic credential projection");
  } catch (error) {
    if ((error as { code?: string }).code === "42501") return;
    throw error;
  }
  throw new ProtectedProjectionFailure("Worker credential projection was exposed");
}
describe("real auth fence races (isolated gate only)", () => {
  it("auth-runtime has only the required actual-role row-lock privileges for all four bindings", async () => {
    const f = await fixture();
    const client = new pg.Client({ connectionString: connectionStrings.auth });
    await client.connect();
    try {
      expect((await client.query("SELECT current_user AS role")).rows[0].role).toBe(
        "jarvis_auth_runtime"
      );
      for (const table of [
        "users",
        "better_auth_sessions",
        "companion_devices",
        "companion_recording_capabilities"
      ]) {
        const permissions = await client.query(
          "SELECT has_table_privilege(current_user,$1,'SELECT') AS can_read,has_any_column_privilege(current_user,$1,'UPDATE') AS can_lock",
          [`app.${table}`]
        );
        expect(permissions.rows[0]).toEqual({ can_read: true, can_lock: true });
      }
    } finally {
      await client.end();
    }
    const lease = await runtime.recordingCapabilities.acquireCaptureBinding({
      ...f.browser,
      deviceId: f.deviceId,
      capabilityRevision: 1
    });
    await lease.release();
  });
  it.each(["user-status", "session-expiry", "device-expiry", "capability-revoke"] as const)(
    "SHARE fences non-key %s updates until admitted work releases its binding",
    async (target) => {
      const f = await fixture();
      const input = { ...f.browser, deviceId: f.deviceId, capabilityRevision: 1 };
      const lease = await runtime.recordingCapabilities.acquireCaptureBinding(input);
      const updater = await bootstrap.connect();
      const query =
        target === "user-status"
          ? "UPDATE app.users SET status='deactivated' WHERE id=$1"
          : target === "session-expiry"
            ? "UPDATE app.better_auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1"
            : target === "device-expiry"
              ? "UPDATE app.companion_devices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1"
              : "UPDATE app.companion_recording_capabilities SET revoked_at=clock_timestamp(),revision=revision+1 WHERE device_id=$1";
      const id =
        target === "user-status"
          ? f.browser.actorUserId
          : target === "session-expiry"
            ? f.browser.sessionId
            : f.deviceId;
      try {
        await updater.query("BEGIN");
        await updater.query("SET LOCAL lock_timeout='200ms'");
        const blocked = await updater.query(query, [id]).catch((error: unknown) => error);
        expect(blocked, "capture-non-key-update-fenced").toMatchObject({ code: "55P03" });
        await updater.query("ROLLBACK");
        await lease.release();
        await updater.query(query, [id]);
        await expect(runtime.recordingCapabilities.acquireCaptureBinding(input)).rejects.toThrow();
      } finally {
        await lease.release();
        await updater.query("ROLLBACK");
        updater.release();
      }
    }
  );
  it.each(["device", "session"] as const)(
    "T1/T4 %s deletion cannot commit until an already-fenced transcript commit finishes",
    async (target) => {
      const f = await fixture(),
        active = await f.begin();
      const secondBrowser = await f.signin();
      const entered = barrier(),
        release = barrier();
      const ingest = MeetingTranscriptRepository.prototype.ingest;
      vi.spyOn(MeetingTranscriptRepository.prototype, "ingest").mockImplementationOnce(
        async function (this: MeetingTranscriptRepository, db, input) {
          entered.open();
          await release.promise;
          return ingest.call(this, db, input);
        }
      );
      const audio = f.service.audio(active.headers, "fenced-audio", active.audio);
      await entered.promise;
      let deletionCommitted = false;
      const deletion = runtime.meSessions
        .revokeOne({
          actorUserId: f.browser.actorUserId,
          sessionId: target === "device" ? f.deviceId : f.browser.sessionId,
          headers: secondBrowser
        })
        .then((value) => {
          deletionCommitted = true;
          return value;
        });
      try {
        const table = target === "device" ? "companion_devices" : "better_auth_sessions";
        await expect
          .poll(
            async () =>
              Number(
                (
                  await bootstrap.query(
                    "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
                    [`DELETE FROM app.${table}%`]
                  )
                ).rows[0].waiting
              ),
            { timeout: 5000, interval: 20 }
          )
          .toBeGreaterThan(0);
        expect(deletionCommitted).toBe(false);
      } finally {
        release.open();
      }
      expect(await audio).toMatchObject({ status: "saved" });
      expect(await deletion).toMatchObject({ revoked: true });
      const before = await bootstrap.query(
        "SELECT count(*)::int AS count FROM app.meeting_transcript_batches WHERE meeting_id=$1",
        [f.meeting.id]
      );
      await expect(
        f.service.audio(active.headers, "after-delete", active.audio)
      ).rejects.toMatchObject({ httpStatus: 401 });
      expect(
        (
          await bootstrap.query(
            "SELECT count(*)::int AS count FROM app.meeting_transcript_batches WHERE meeting_id=$1",
            [f.meeting.id]
          )
        ).rows
      ).toEqual(before.rows);
    }
  );
  it("T1/T3 a revoke after provider admission blocks persistence without pretending to cancel accepted provider work", async () => {
    for (const target of ["device", "capability"] as const) {
      const f = await fixture(),
        active = await f.begin(),
        admitted = barrier(),
        response = barrier();
      vi.mocked(f.deps.transcribe).mockImplementation(async (_actor, input) =>
        input.dispatch(async () => {
          admitted.open();
          await response.promise;
          return {
            segments: [{ startMs: 0, endMs: 900, text: "Must not persist after revoke" }],
            modelRoute: "synthetic-transcription"
          };
        })
      );
      const pending = f.service.audio(active.headers, "provider-race", active.audio);
      await admitted.promise;
      try {
        if (target === "device")
          await runtime.companionDevices.logout({ ...f.browser, deviceId: f.deviceId });
        else {
          // The dispatch transaction is bounded. Retry its documented busy result once it releases.
          await expect
            .poll(
              async () => {
                try {
                  await runtime.recordingCapabilities.revoke(f.browser, f.deviceId);
                  return true;
                } catch (error) {
                  if ((error as { httpStatus?: number }).httpStatus === 429) return false;
                  throw error;
                }
              },
              { timeout: 5000, interval: 20 }
            )
            .toBe(true);
        }
      } finally {
        response.open();
      }
      await expect(pending).rejects.toMatchObject({ httpStatus: 401 });
      expect((await active.stored())?.status).toBe("revoked");
      expect(
        (
          await bootstrap.query(
            "SELECT 1 FROM app.meeting_transcript_batches WHERE meeting_id=$1",
            [f.meeting.id]
          )
        ).rows
      ).toEqual([]);
    }
  });
  it("contended auth rows fail temporarily with no false grant revocation and recover after rollback", async () => {
    const f = await fixture(),
      active = await f.begin();
    const blocker = await bootstrap.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM app.companion_devices WHERE id=$1 FOR UPDATE", [
        f.deviceId
      ]);
      const failure = await active.status().catch((error: unknown) => error);
      expect(captureAuthorizationError(failure)).toMatchObject({ httpStatus: 503 });
      expect((await active.stored())?.status).toBe("active");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    await expect(active.status()).resolves.toHaveProperty("capture.desired", "recording");
  });
  it("T11 rollback-only worker grant removal exposes credential hashes and restoration denies them again", async () => {
    const f = await fixture();
    await f.begin();
    const client = await bootstrap.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE jarvis_worker_runtime");
      await client.query("SELECT set_config('app.actor_user_id',$1,true)", [f.browser.actorUserId]);
      await assertSecretProjectionDenied(client);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query(
        "GRANT SELECT (credential_hash,verifier_hash) ON app.meeting_capture_grants TO jarvis_worker_runtime"
      );
      await client.query("SET LOCAL ROLE jarvis_worker_runtime");
      await client.query("SELECT set_config('app.actor_user_id',$1,true)", [f.browser.actorUserId]);
      await expect(assertSecretProjectionDenied(client)).rejects.toBeInstanceOf(
        ProtectedProjectionFailure
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const worker = new pg.Client({ connectionString: connectionStrings.worker });
    await worker.connect();
    try {
      await expect(
        worker.query("SELECT credential_hash FROM app.meeting_capture_grants")
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await worker.end();
    }
  });
  it("T6 rollback-only owner-RLS removal exposes another owner's grant and restoration hides it", async () => {
    const a = await fixture(),
      active = await a.begin(),
      b = await fixture();
    const client = await bootstrap.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER POLICY meeting_capture_grants_owner ON app.meeting_capture_grants USING (true) WITH CHECK (true)"
      );
      await client.query("SET LOCAL ROLE jarvis_app_runtime");
      await client.query("SELECT set_config('app.actor_user_id',$1,true)", [b.browser.actorUserId]);
      const leaked = await client.query(
        "SELECT owner_user_id FROM app.meeting_capture_grants WHERE id=$1",
        [active.grantId]
      );
      expect(leaked.rows).toHaveLength(1);
      expect(() => assertOwnerProjection(leaked.rows, b.browser.actorUserId)).toThrow(
        ProtectedProjectionFailure
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const protection = await bootstrap.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='app.meeting_capture_grants'::regclass"
    );
    expect(protection.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const restored = await b.deps.dataContext.withDataContext(b.browser, (db) =>
      new MeetingCaptureRepository().grant(db, active.grantId)
    );
    expect(restored).toBeNull();
    assertOwnerProjection(restored ? [restored] : [], b.browser.actorUserId);
  });
});
