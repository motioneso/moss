import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { createMeetingCaptureMaintenanceScheduler } from "../../packages/meetings/src/capture-maintenance.js";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { expect, vi } from "vitest";
import { createMossAuthRuntime, sha256Base64url, type MossAuthRuntime } from "@moss/auth";
import {
  createDatabase,
  AbortablePgPool,
  DataContextRunner,
  withAbortableDataContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import type { Kysely } from "kysely";
import type { MeetingCaptureAudioInput } from "@moss/shared";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../packages/meetings/src/capture-service.js";
import { MeetingCaptureConnectionService } from "../../packages/meetings/src/capture-connection-service.js";
import { MeetingRecordsRepository } from "../../packages/meetings/src/repository.js";
import { MeetingCaptureRepository } from "../../packages/meetings/src/capture-repository.js";
import { MeetingPreferencesRepository } from "../../packages/meetings/src/preferences.js";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import { recordingLoggerOptions } from "../../apps/api/src/recording-logger-options.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const origin = "http://localhost:3000";
export const inventory = {
  microphones: [{ deviceId: "fixture-mic", sourceId: "mic", label: "Synthetic microphone" }],
  applications: [],
  computerAudio: { available: false, excludedProcessTreeIds: [] },
  microphonePermission: "granted" as const,
  systemAudioPermission: "unknown" as const
};
export let producer: PgBoss;
export let bootstrap: pg.Pool,
  runtime: MossAuthRuntime,
  context: DataContextRunner,
  workerContext: DataContextRunner;
let app: Kysely<MossDatabase>, worker: Kysely<MossDatabase>;
let maintenancePool: AbortablePgPool;
export async function setupLinkDatabase() {
  // The canonical gate alone may execute this fixture; there is no direct-DB override here.
  await resetEmptyFoundationDatabase();
  await setInstanceSetting("registration.requires_approval", { value: false });
  await setInstanceSetting("registration.enabled", { value: true });
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 6 });
  maintenancePool = new AbortablePgPool({
    connectionString: connectionStrings.app,
    application_name: "moss-abortable-data-context"
  });
  worker = createDatabase({ connectionString: connectionStrings.worker });
  context = new DataContextRunner(app);
  workerContext = new DataContextRunner(worker);
  bootstrap = new pg.Pool({ connectionString: connectionStrings.bootstrap });
  runtime = createMossAuthRuntime({ appDb: app, runner: context });
  producer = createPgBossClient(connectionStrings.app);
  await producer.start();
}
export async function closeLinkDatabase() {
  await producer?.stop({ graceful: true });
  await runtime?.close();
  await maintenancePool?.close();
  await Promise.all([bootstrap?.end(), app?.destroy(), worker?.destroy()]);
}
export async function linkFixture(initialNow?: Date) {
  const email = `link-${randomUUID()}@example.test`;
  const password = "Synthetic meeting link fixture password";
  const signup = await runtime.auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password, name: "Synthetic link owner" })
    })
  );
  expect(signup.status).toBe(200);
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const browserHeaders = { cookie, origin };
  const browser = await runtime.sessionBindings.resolveBrowser({
    headers: browserHeaders,
    requestId: "link-fixture"
  });
  const verifier = "v".repeat(43),
    proof = "p".repeat(43);
  const attempt = await runtime.companionPairing.create({
    deviceName: "Synthetic Mac",
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
  if (redemption.status !== "issued") throw new Error("Disposable pairing did not issue");
  const linked = redemption.response,
    deviceId = linked.device.id,
    connectionId = randomUUID();
  const native = { authorization: `Bearer ${linked.credential}`, "x-moss-recording-proof": proof };
  let clock = initialNow ?? new Date();
  const deps: MeetingCaptureDependencies = {
    dataContext: context,
    resolveBrowser: runtime.sessionBindings.resolveBrowser,
    resolveCompanion: runtime.companionDevices.resolve,
    resolveRecording: runtime.recordingCapabilities.resolve,
    assertRecordingBinding: runtime.recordingCapabilities.assertLive,
    acquireRecordingBinding: runtime.recordingCapabilities.acquireCaptureBinding,
    scheduleMaintenance: createMeetingCaptureMaintenanceScheduler(producer),
    assertBinding: runtime.sessionBindings.assertLive,
    device: runtime.sessionBindings.device,
    trustedOrigins: [origin],
    // Only module enablement/provider availability are fixture ports; all authentication,
    // pairing, session/device/capability checks, RLS and transcript storage are real services.
    assertModuleAvailable: async () => {},
    processingAvailability: async () => ({ ready: true, modelRoute: "synthetic-transcription" }),
    transcribe: vi.fn(async (_actor, input) =>
      input.dispatch(async () => ({
        segments: [{ startMs: 0, endMs: 900, text: "Synthetic transcript" }],
        modelRoute: "synthetic-transcription"
      }))
    ),
    now: () => clock
  };
  const service = new MeetingCaptureService(deps),
    connections = new MeetingCaptureConnectionService(deps);
  const createMeeting = async () =>
    (
      await context.withDataContext(browser, (db) =>
        new MeetingRecordsRepository().create(db, {
          title: "Link security fixture",
          requestKey: randomUUID()
        })
      )
    ).meeting;
  const meeting = await createMeeting();
  await context.withDataContext(browser, async (db) => {
    await new MeetingPreferencesRepository().update(db, {
      defaultCaptureMode: "microphone-only",
      rememberedSource: { deviceId, microphoneId: "fixture-mic", mode: "microphone-only" }
    });
  });
  const register = (id = connectionId) =>
    connections.register(native, "register", {
      connectionId: id,
      verifierHash: hash(verifier),
      inventory
    });
  await register();
  const input = { requestKey: randomUUID() };
  const start = () => connections.start(browser, meeting.id, input);
  const begin = async () => {
    const result = await start(),
      grantId = result.capture.grantId;
    const credential = `mm1_${browser.actorUserId}.${grantId}.${"s".repeat(43)}`;
    const claim = { connectionId, verifier, grantId, credentialHash: hash(credential) };
    await connections.claim(native, "claim", claim);
    const headers = { authorization: `Bearer ${credential}` };
    const statusInput = {
      meetingId: meeting.id,
      grantId,
      inventory,
      observed: { generation: 1, phase: "recording" as const }
    };
    await service.status(headers, "recording", statusInput);
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
    return {
      grantId,
      credential,
      headers,
      claim,
      audio,
      statusInput,
      status: () => service.status(headers, "status", statusInput),
      stored: () =>
        context.withDataContext(browser, (db) => new MeetingCaptureRepository().grant(db, grantId))
    };
  };
  const logs: string[] = [];
  const server = Fastify({
    logger: recordingLoggerOptions({
      level: "info",
      stream: new Writable({
        write(chunk, _encoding, done) {
          logs.push(String(chunk));
          done();
        }
      }),
      serializers: {
        req: (req: { headers: unknown; method: string; url: string }) => ({
          headers: req.headers,
          method: req.method,
          url: req.url
        })
      }
    })
  });
  registerMeetingCaptureRoutes(server, deps);
  return {
    maintenance: {
      withDataContext: <T>(
        actor: Parameters<DataContextRunner["withDataContext"]>[0],
        signal: AbortSignal,
        work: (db: DataContextDb) => Promise<T>
      ) => withAbortableDataContext(maintenancePool, actor, signal, work),
      probeBinding: runtime.recordingCapabilities.probeCaptureBinding,
      scheduleMaintenance: deps.scheduleMaintenance
    },
    deps,
    server,
    logs,
    browser,
    browserHeaders,
    deviceId,
    connectionId,
    proof,
    verifier,
    linked,
    native,
    meeting,
    input,
    service,
    connections,
    createMeeting,
    register,
    start,
    begin,
    advance: (milliseconds: number) => {
      clock = new Date(clock.getTime() + milliseconds);
    },
    now: () => clock,
    signin: async () => {
      const response = await runtime.auth.handler(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ email, password })
        })
      );
      expect(response.status).toBe(200);
      return {
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; "),
        origin
      };
    }
  };
}
