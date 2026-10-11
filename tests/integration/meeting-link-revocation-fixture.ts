import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { expect, vi } from "vitest";
import { createMossAuthRuntime, sha256Base64url, type MossAuthRuntime } from "@moss/auth";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { MeetingCaptureAudioInput, MeetingCaptureAudioReceipt } from "@moss/shared";
import { registerCompanionRecordingRoutes } from "../../apps/api/src/companion-recording-routes.js";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import type { MeetingCaptureDependencies } from "../../packages/meetings/src/capture-service.js";
import { MeetingCaptureRepository } from "../../packages/meetings/src/capture-repository.js";
import { MeetingRecordsRepository } from "../../packages/meetings/src/repository.js";
import { MeetingPreferencesRepository } from "../../packages/meetings/src/preferences.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const inventory = {
  defaultMicrophoneId: "fixture-mic",
  microphones: [{ deviceId: "fixture-mic", sourceId: "mic", label: "Synthetic microphone" }],
  applications: [],
  computerAudio: { available: false, excludedProcessTreeIds: [] },
  microphonePermission: "granted" as const,
  systemAudioPermission: "unknown" as const
};
let database: Kysely<MossDatabase>, context: DataContextRunner;
let runtime: MossAuthRuntime;

export async function setupMeetingLinkRevocation() {
  // The shared harness enforces the canonical gate or CI's explicit ephemeral-DB override.
  await resetEmptyFoundationDatabase();
  await setInstanceSetting("registration.requires_approval", { value: false });
  await setInstanceSetting("registration.enabled", { value: true });
  database = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  context = new DataContextRunner(database);
  runtime = createMossAuthRuntime({ appDb: database, runner: context });
}

export async function closeMeetingLinkRevocation() {
  await runtime?.close();
  await database?.destroy();
}

export async function meetingLinkRevocationFixture() {
  const origin = runtime.trustedOrigins[0]!;
  const signup = await runtime.auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `meeting-revocation-${randomUUID()}@example.test`,
        password: `Synthetic-only-${randomUUID()}`,
        name: "Synthetic recording owner"
      })
    })
  );
  expect(signup.status, "synthetic-cookie-signup").toBe(200);
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const browserHeaders = { cookie, origin };
  const browser = await runtime.sessionBindings.resolveBrowser({
    headers: browserHeaders,
    requestId: "synthetic-meeting-revocation"
  });
  const verifier = "v".repeat(43),
    proof = "p".repeat(43);
  const attempt = await runtime.companionPairing.create({
    deviceName: "Synthetic recording Mac",
    platform: "macos",
    appVersion: "test",
    osVersion: "test",
    verifierHash: sha256Base64url(verifier),
    recordingProofHash: hash(proof),
    recordingPolicyVersion: 1
  });
  expect(
    await runtime.companionPairing.decide({
      approvalCode: attempt.approvalCode,
      decision: "approve",
      actorUserId: browser.actorUserId,
      browserSessionId: browser.sessionId,
      recordingPolicyVersion: 1
    })
  ).toMatchObject({ ok: true });
  const redemption = await runtime.companionPairing.redeem({
    attemptId: attempt.attemptId,
    verifier
  });
  if (redemption.status !== "issued") throw new Error("Synthetic initial link did not issue");
  const linked = redemption.response,
    deviceId = linked.device.id,
    connectionId = randomUUID();
  expect(linked.recordingCapability).toEqual({ policyVersion: 1, revision: 1 });
  const native = { authorization: `Bearer ${linked.credential}`, "x-moss-recording-proof": proof };
  await expect(
    runtime.recordingCapabilities.resolve({ headers: native, requestId: "linked-recording-proof" })
  ).resolves.toMatchObject({ deviceId, capabilityRevision: 1 });
  let clock = new Date();
  const transcribe: MeetingCaptureDependencies["transcribe"] = vi.fn(async (_actor, input) =>
    input.dispatch(async () => ({
      segments: [{ startMs: 0, endMs: 900, text: "Synthetic revocation transcript" }],
      modelRoute: "synthetic-transcription"
    }))
  );
  const dependencies: MeetingCaptureDependencies = {
    dataContext: context,
    resolveBrowser: runtime.sessionBindings.resolveBrowser,
    resolveCompanion: runtime.companionDevices.resolve,
    resolveRecording: runtime.recordingCapabilities.resolve,
    assertRecordingBinding: runtime.recordingCapabilities.assertLive,
    acquireRecordingBinding: runtime.recordingCapabilities.acquireCaptureBinding,
    // Synthetic maintenance deliberately does not run. This proves request-driven settlement,
    // not background revocation timing or durable maintenance scheduling.
    scheduleMaintenance: async () => {},
    assertBinding: runtime.sessionBindings.assertLive,
    device: runtime.sessionBindings.device,
    trustedOrigins: runtime.trustedOrigins,
    // Module/provider availability and transcription are also synthetic. Auth, cookies,
    // initial linking approval, proof, session/device checks, the auth fence, RLS and storage are real.
    assertModuleAvailable: async () => {},
    processingAvailability: async () => ({ ready: true, modelRoute: "synthetic-transcription" }),
    transcribe,
    now: () => clock
  };
  const meeting = await context.withDataContext(
    browser,
    async (db) =>
      (
        await new MeetingRecordsRepository().create(db, {
          title: "Synthetic active-recording revocation",
          requestKey: randomUUID()
        })
      ).meeting
  );
  await context.withDataContext(browser, (db) =>
    new MeetingPreferencesRepository().update(db, {
      defaultCaptureMode: "microphone-only",
      rememberedSource: { deviceId, microphoneId: "fixture-mic", mode: "microphone-only" }
    })
  );
  const server = Fastify({ logger: false });
  registerMeetingCaptureRoutes(server, dependencies);
  registerCompanionRecordingRoutes(server, runtime);
  const browserStatus = () =>
    server.inject({
      method: "GET",
      url: `/api/meetings/records/${meeting.id}/capture`,
      headers: browserHeaders
    });
  const begin = async () => {
    const registered = await server.inject({
      method: "POST",
      url: "/api/meetings/capture/connection",
      headers: native,
      payload: { connectionId, verifierHash: hash(verifier), inventory }
    });
    expect(registered.statusCode, "real-recording-connection").toBe(200);
    const beforeStart = await browserStatus();
    expect(beforeStart.statusCode).toBe(200);
    expect(beforeStart.json().capture, "initial-link-does-not-start-recording").toBeNull();
    const started = await server.inject({
      method: "POST",
      url: `/api/meetings/records/${meeting.id}/capture/start`,
      headers: browserHeaders,
      payload: { requestKey: randomUUID() }
    });
    expect(started.statusCode, "explicit-browser-start").toBe(200);
    expect(started.json().capture.selection, "server-resolved-synthetic-microphone").toEqual({
      mode: "microphone-only",
      microphone: { deviceId: "fixture-mic", sourceId: "mic" }
    });
    const grantId = started.json<{ capture: { grantId: string } }>().capture.grantId;
    const credential = `mm1_${browser.actorUserId}.${grantId}.${"s".repeat(43)}`;
    const claimed = await server.inject({
      method: "POST",
      url: "/api/meetings/capture/claim",
      headers: native,
      payload: { connectionId, verifier, grantId, credentialHash: hash(credential) }
    });
    expect(claimed.statusCode, "native-capture-claim").toBe(200);
    const headers = { authorization: `Bearer ${credential}` };
    const status = await server.inject({
      method: "POST",
      url: "/api/meetings/capture/status",
      headers,
      payload: {
        meetingId: meeting.id,
        grantId,
        inventory,
        observed: { generation: 1, phase: "recording" }
      }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().capture, "active-native-recording").toMatchObject({
      desired: "recording",
      observed: { generation: 1, phase: "recording" }
    });
    clock = new Date(clock.getTime() + 2000);
    const audio: MeetingCaptureAudioInput = {
      meetingId: meeting.id,
      grantId,
      requestKey: randomUUID(),
      generation: 1,
      epoch: 1,
      sourceId: "mic",
      sequence: 0,
      startMs: 0,
      endMs: 1000,
      sampleRateHz: 16000,
      pcmBase64: Buffer.alloc(32000, 1).toString("base64")
    };
    const upload = (input: MeetingCaptureAudioInput) =>
      server.inject({
        method: "POST",
        url: "/api/meetings/capture/audio",
        headers,
        payload: input
      });
    const accepted = await upload(audio);
    expect(accepted.statusCode, "pre-revocation-audio-accepted").toBe(200);
    expect(accepted.json<MeetingCaptureAudioReceipt>()).toMatchObject({ status: "saved" });
    expect(transcribe).toHaveBeenCalledTimes(1);
    return {
      upload,
      audio: { ...audio, requestKey: randomUUID(), sequence: 1, startMs: 1000, endMs: 2000 },
      stored: () =>
        context.withDataContext(browser, (db) => new MeetingCaptureRepository().grant(db, grantId)),
      storage: () =>
        context.withDataContext(browser, async (db) => ({
          batches: (
            await sql`SELECT * FROM app.meeting_transcript_batches WHERE meeting_id=${meeting.id}::uuid ORDER BY version`.execute(
              db.db
            )
          ).rows,
          receipts: (
            await sql`SELECT * FROM app.meeting_capture_receipts WHERE grant_id=${grantId}::uuid ORDER BY request_key`.execute(
              db.db
            )
          ).rows
        }))
    };
  };
  return {
    server,
    begin,
    browserStatus,
    transcribe,
    revoke: () =>
      server.inject({
        method: "POST",
        url: "/api/companion/recording-capability/revoke",
        headers: browserHeaders,
        payload: { deviceId }
      }),
    unlink: async () => runtime.companionDevices.logoutCredential({ headers: native }),
    ordinaryLink: () =>
      runtime.companionDevices.resolve({
        headers: native,
        requestId: "ordinary-link-after-revoke"
      }),
    recordingLink: () =>
      runtime.recordingCapabilities.resolve({
        headers: native,
        requestId: "recording-after-revoke"
      }),
    deviceId
  };
}
