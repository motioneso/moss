import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { MeetingCaptureConnectionService } from "../../packages/meetings/src/capture-connection-service.js";
import { MeetingCaptureRepository } from "../../packages/meetings/src/capture-repository.js";
import { collectMeetingsExportSection } from "../../packages/meetings/src/data-lifecycle.js";
import { MeetingPreferencesRepository } from "../../packages/meetings/src/preferences.js";
import { MeetingCaptureStartLimiter } from "../../packages/meetings/src/capture-start-limiter.js";
import {
  bootstrap,
  runtime,
  context,
  workerContext,
  setupLinkDatabase,
  closeLinkDatabase,
  linkFixture,
  hash,
  origin
} from "./meeting-link-fixture.js";

beforeAll(setupLinkDatabase);
afterAll(closeLinkDatabase);
const fixtures: Awaited<ReturnType<typeof linkFixture>>[] = [];
async function fixture() {
  const result = await linkFixture();
  fixtures.push(result);
  return result;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((f) => f.server.close()));
});

async function assertRevoked(
  f: Awaited<ReturnType<typeof fixture>>,
  active: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["begin"]>>,
  reason: string
) {
  const status = await f.server.inject({
    method: "POST",
    url: "/api/meetings/capture/status",
    headers: active.headers,
    payload: active.statusInput
  });
  expect(status.statusCode, `link-status-denial:${reason}`).toBe(401);
  const audio = await f.server.inject({
    method: "POST",
    url: "/api/meetings/capture/audio",
    headers: active.headers,
    payload: active.audio
  });
  expect(audio.statusCode).toBe(401);
  expect((await active.stored())?.status).toBe("revoked");
  expect(JSON.parse((await active.stored())!.state_json!)).toMatchObject({
    desired: "revoked",
    revocationReason: reason
  });
  expect(
    (
      await bootstrap.query("SELECT 1 FROM app.meeting_transcript_batches WHERE meeting_id=$1", [
        f.meeting.id
      ])
    ).rows
  ).toEqual([]);
  expect(f.deps.transcribe).not.toHaveBeenCalled();
}

describe("Mac link real-auth security matrix (isolated gate only)", () => {
  it.each(["settings", "mac"] as const)(
    "T1/T2 %s Unlink revokes live mm1 and stores no post-commit audio",
    async (surface) => {
      const f = await fixture(),
        active = await f.begin();
      if (surface === "settings") {
        expect(
          await runtime.meSessions.revokeOne({
            actorUserId: f.browser.actorUserId,
            sessionId: f.deviceId,
            headers: f.browserHeaders
          })
        ).toMatchObject({ revoked: true });
      } else {
        await runtime.companionDevices.logoutCredential({ headers: f.native });
      }
      await assertRevoked(f, active, "device-unavailable");
      await expect(
        runtime.companionDevices.resolve({ headers: f.native, requestId: "after" })
      ).rejects.toMatchObject({ httpStatus: 401 });
    }
  );
  it("T1 missing device is rejected independently by real session checks and the auth fence", async () => {
    const f = await fixture();
    await runtime.companionDevices.logout({ ...f.browser, deviceId: f.deviceId });
    await expect(
      runtime.sessionBindings.assertLive({
        actorUserId: f.browser.actorUserId,
        deviceId: f.deviceId
      })
    ).rejects.toMatchObject({ bindingReason: "device-unavailable" });
    await expect(
      runtime.recordingCapabilities.acquireCaptureBinding({
        ...f.browser,
        deviceId: f.deviceId,
        capabilityRevision: 1
      })
    ).rejects.toMatchObject({ bindingReason: "device-unavailable" });
  });
  it("T1 the cascaded capability independently denies after unlink without the separate device precheck", async () => {
    const f = await fixture();
    await runtime.companionDevices.logout({ ...f.browser, deviceId: f.deviceId });
    await expect(
      runtime.recordingCapabilities.assertLive({
        actorUserId: f.browser.actorUserId,
        deviceId: f.deviceId,
        capabilityRevision: 1
      })
    ).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("T3 recording-only revoke settles the grant and preserves the ordinary device link", async () => {
    const f = await fixture(),
      active = await f.begin();
    await runtime.recordingCapabilities.revoke(f.browser, f.deviceId);
    await assertRevoked(f, active, "recording-permission-revoked");
    await expect(
      runtime.companionDevices.resolve({ headers: f.native, requestId: "still-linked" })
    ).resolves.toHaveProperty("deviceId", f.deviceId);
  });
  it.each(["local", "everywhere-else"] as const)(
    "T4 %s sign-out invalidates the starting cookie session",
    async (kind) => {
      const f = await fixture(),
        active = await f.begin();
      if (kind === "local") {
        const response = await runtime.auth.handler(
          new Request(`${origin}/api/auth/sign-out`, { method: "POST", headers: f.browserHeaders })
        );
        expect(response.status).toBe(200);
      } else {
        const otherHeaders = await f.signin();
        await runtime.meSessions.revokeOthers({
          actorUserId: f.browser.actorUserId,
          headers: otherHeaders
        });
      }
      await assertRevoked(f, active, "session-ended");
    }
  );
  it("T5 refuses a claim after 60 seconds with a freshly registered live connection", async () => {
    const f = await fixture(),
      started = await f.start();
    f.advance(60001);
    await f.register();
    await expect(
      f.connections.claim(f.native, "late-claim", {
        connectionId: f.connectionId,
        verifier: f.verifier,
        grantId: started.capture.grantId,
        credentialHash: hash("synthetic late credential")
      })
    ).rejects.toMatchObject({ httpStatus: 401 });
  });
  it("T5 refuses audio after only the 30 second capture lease expires", async () => {
    const f = await fixture(),
      active = await f.begin();
    f.advance(28001);
    await f.register();
    await expect(
      f.service.audio(active.headers, "expired-lease", active.audio)
    ).rejects.toMatchObject({ code: "meeting_capture_interrupted", httpStatus: 409 });
    expect(f.deps.transcribe).not.toHaveBeenCalled();
  });
  it("T5 refuses audio after only the 2 hour hard cap expires with fresh connection and capture leases", async () => {
    const f = await fixture(),
      active = await f.begin();
    await f.service.browserControl(f.browser, f.meeting.id, {
      grantId: active.grantId,
      requestKey: randomUUID(),
      expectedGeneration: 1,
      command: "pause"
    });
    f.advance(7197000);
    await f.register();
    await f.service.status(active.headers, "fresh-paused", {
      ...active.statusInput,
      observed: { generation: 2, phase: "paused" }
    });
    await f.service.browserControl(f.browser, f.meeting.id, {
      grantId: active.grantId,
      requestKey: randomUUID(),
      expectedGeneration: 2,
      command: "record"
    });
    await f.service.status(active.headers, "fresh-recording", {
      ...active.statusInput,
      observed: { generation: 3, phase: "recording" }
    });
    f.advance(1001);
    await expect(
      f.service.audio(active.headers, "hard-cap", {
        ...active.audio,
        generation: 3,
        epoch: 2,
        startMs: 7199000,
        endMs: 7200000
      })
    ).rejects.toMatchObject({ httpStatus: 401 });
    expect(f.deps.transcribe).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "T6 a second owner (admin=%s) cannot list, Start, claim or upload another owner's capture",
    async (admin) => {
      const a = await fixture(),
        active = await a.begin(),
        b = await fixture();
      await bootstrap.query("UPDATE app.users SET is_instance_admin=$2 WHERE id=$1", [
        b.browser.actorUserId,
        admin
      ]);
      expect(
        (await b.connections.devices(b.browser)).devices.map((device) => device.deviceId)
      ).not.toContain(a.deviceId);
      expect(
        (await runtime.recordingCapabilities.list(b.browser.actorUserId)).devices.map(
          (device) => device.deviceId
        )
      ).not.toContain(a.deviceId);
      await context.withDataContext(b.browser, (db) =>
        new MeetingPreferencesRepository().update(db, {
          rememberedSource: {
            deviceId: a.deviceId,
            microphoneId: "fixture-mic",
            mode: "microphone-only"
          }
        })
      );
      await expect(b.start()).rejects.toThrow();
      await expect(b.connections.claim(b.native, "cross-owner", active.claim)).rejects.toThrow();
      const forged = `mm1_${b.browser.actorUserId}.${active.grantId}.${"s".repeat(43)}`;
      await expect(
        b.service.audio({ authorization: `Bearer ${forged}` }, "cross-owner", active.audio)
      ).rejects.toThrow();
      expect(
        await context.withDataContext(b.browser, (db) =>
          new MeetingCaptureRepository().grant(db, active.grantId)
        )
      ).toBeNull();
    }
  );
  it("T6 real auth device lookup rejects another owner's device including an administrator", async () => {
    const a = await fixture(),
      b = await fixture();
    for (const admin of [false, true]) {
      await bootstrap.query("UPDATE app.users SET is_instance_admin=$2 WHERE id=$1", [
        b.browser.actorUserId,
        admin
      ]);
      await expect(
        runtime.sessionBindings.device({ actorUserId: b.browser.actorUserId, deviceId: a.deviceId })
      ).rejects.toMatchObject({ httpStatus: 403 });
    }
  });
  it("T7 fences changed Start bodies and old launch verifier/connection generations", async () => {
    const f = await fixture(),
      started = await f.start();
    await expect(
      f.connections.start(f.browser, f.meeting.id, {
        ...f.input,
        deviceId: f.deviceId,
        connectionId: f.connectionId,
        expectedRevision: 1,
        selection: {
          mode: "microphone-only",
          microphone: { deviceId: "fixture-mic", sourceId: "mic" }
        }
      })
    ).rejects.toMatchObject({ httpStatus: 409 });
    await expect(
      f.connections.claim(f.native, "wrong-verifier", {
        connectionId: f.connectionId,
        verifier: "x".repeat(43),
        grantId: started.capture.grantId,
        credentialHash: hash("synthetic")
      })
    ).rejects.toThrow();
    await f.register(randomUUID());
    await expect(
      f.connections.claim(f.native, "old-launch", {
        connectionId: f.connectionId,
        verifier: f.verifier,
        grantId: started.capture.grantId,
        credentialHash: hash("synthetic")
      })
    ).rejects.toThrow();
  });
  it.each(["missing", "stale"] as const)(
    "T8 a %s stored account notice refuses Start",
    async (kind) => {
      const f = await fixture();
      await bootstrap.query(
        kind === "missing"
          ? "DELETE FROM app.meeting_recording_notices WHERE owner_user_id=$1"
          : "UPDATE app.meeting_recording_notices SET policy_version='old-text' WHERE owner_user_id=$1",
        [f.browser.actorUserId]
      );
      await expect(f.start()).rejects.toMatchObject({
        code: "meeting_capture_notice_required",
        httpStatus: 409
      });
    }
  );
  it("T9 a proof approved over 90 days ago remains valid without any Start while its device is valid", async () => {
    const f = await fixture();
    // Age only consent through the real stored row; the device was contacted and remains valid.
    await bootstrap.query(
      "UPDATE app.companion_recording_capabilities SET approved_at=clock_timestamp()-interval '91 days' WHERE device_id=$1",
      [f.deviceId]
    );
    expect(
      (
        await bootstrap.query("SELECT 1 FROM app.meeting_capture_grants WHERE owner_user_id=$1", [
          f.browser.actorUserId
        ])
      ).rows
    ).toEqual([]);
    await expect(
      runtime.recordingCapabilities.resolve({ headers: f.native, requestId: "persistent" })
    ).resolves.toHaveProperty("capabilityRevision", 1);
    await runtime.recordingCapabilities.revoke(f.browser, f.deviceId);
    await expect(
      runtime.recordingCapabilities.resolve({ headers: f.native, requestId: "revoked" })
    ).rejects.toThrow();
    const another = await fixture();
    await bootstrap.query(
      "UPDATE app.companion_devices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [another.deviceId]
    );
    await expect(
      runtime.recordingCapabilities.resolve({
        headers: another.native,
        requestId: "expired-device"
      })
    ).rejects.toThrow();
  });
  it("T10 shares 10/minute admission across API instances, browser sessions, request replays and concurrent callers", async () => {
    const f = await fixture(),
      headers = await f.signin();
    const second = await runtime.sessionBindings.resolveBrowser({
      headers,
      requestId: "second-browser"
    });
    // Seed a live grant before concurrent replays. Distinct browser sessions fingerprint differently,
    // but those failed requests must consume the same owner's admission budget too.
    await f.start();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        new MeetingCaptureConnectionService(f.deps).start(
          index % 2 ? second : f.browser,
          f.meeting.id,
          f.input
        )
      )
    );
    expect(
      results.filter((result) => result.status === "rejected" && result.reason.httpStatus === 429)
    ).toHaveLength(1);
    const rejected = await f.server.inject({
      method: "POST",
      url: `/api/meetings/records/${f.meeting.id}/capture/start`,
      headers: f.browserHeaders,
      payload: f.input
    });
    expect(rejected.statusCode).toBe(429);
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(rejected.headers["retry-after"])).toBeLessThanOrEqual(60);
    const other = await fixture();
    await expect(other.start()).resolves.toHaveProperty("capture");
  });
  it("T10 enforces 60/hour independently of the minute window and exports/deletes only owner metadata", async () => {
    const f = await fixture();
    await bootstrap.query(
      `INSERT INTO app.meeting_capture_start_limits(owner_user_id,started_at)
      VALUES($1,ARRAY(SELECT clock_timestamp()-interval '2 minutes'-n*interval '1 second' FROM generate_series(0,59) AS n))`,
      [f.browser.actorUserId]
    );
    await expect(
      context.withDataContext(f.browser, (db) => new MeetingCaptureStartLimiter().consume(db))
    ).rejects.toMatchObject({ httpStatus: 429 });
    const exported = await workerContext.withDataContext(f.browser, (db) =>
      collectMeetingsExportSection(db, f.browser)
    );
    expect(exported.capture_start_limits).toHaveLength(1);
    const other = await fixture();
    expect(
      (
        await workerContext.withDataContext(other.browser, (db) =>
          sql`SELECT * FROM app.meeting_capture_start_limits`.execute(db.db)
        )
      ).rows
    ).toEqual([]);
  });
  it("T11 full Start/record/Stop excludes tm1/mm1/proof/verifier from captured logs, responses and owner export", async () => {
    const f = await fixture();
    const started = await f.server.inject({
      method: "POST",
      url: `/api/meetings/records/${f.meeting.id}/capture/start`,
      headers: f.browserHeaders,
      payload: f.input
    });
    expect(started.statusCode).toBe(200);
    const active = await f.begin();
    const audio = await f.server.inject({
      method: "POST",
      url: "/api/meetings/capture/audio",
      headers: active.headers,
      payload: active.audio
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.json()).toMatchObject({ status: "saved" });
    const stopped = await f.server.inject({
      method: "POST",
      url: `/api/meetings/records/${f.meeting.id}/capture/control`,
      headers: f.browserHeaders,
      payload: {
        grantId: active.grantId,
        requestKey: randomUUID(),
        expectedGeneration: 1,
        command: "stop"
      }
    });
    expect(stopped.statusCode).toBe(200);
    f.server.log.info(
      {
        headers: f.native,
        req: { headers: active.headers },
        body: { verifier: f.verifier, recordingProof: f.proof }
      },
      "Synthetic secret-redaction probe"
    );
    const exported = await workerContext.withDataContext(f.browser, (db) =>
      collectMeetingsExportSection(db, f.browser)
    );
    for (const secret of [f.linked.credential, active.credential, f.proof, f.verifier]) {
      expect(f.logs.join("")).not.toContain(secret);
      expect(started.body + audio.body + stopped.body + JSON.stringify(exported)).not.toContain(
        secret
      );
    }
    const receipts = await bootstrap.query(
      "SELECT metadata_json,result_json FROM app.meeting_capture_receipts WHERE grant_id=$1",
      [active.grantId]
    );
    expect(JSON.stringify(receipts.rows)).not.toContain(active.audio.pcmBase64);
    expect(JSON.stringify(receipts.rows)).not.toContain("Synthetic transcript");
    for (const column of ["credential_hash", "verifier_hash", "session_id"])
      await expect(
        workerContext.withDataContext(f.browser, (db) =>
          sql`SELECT ${sql.ref(column)} FROM app.meeting_capture_grants`.execute(db.db)
        )
      ).rejects.toMatchObject({ code: "42501" });
  });
});
