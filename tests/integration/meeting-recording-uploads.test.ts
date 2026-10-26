import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fastify } from "fastify";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  VaultContextRunner,
  listVaultFilesRecursive,
  publishReservedVaultFileBytes,
  writeVaultFileBytes
} from "@moss/vault";
import { HttpError } from "@moss/module-sdk";
import { VoiceRequestService, createVoiceRequestScheduler } from "@moss/chat";
import { ACT_AS_GRANT_HEADER } from "@moss/module-sdk/server";
import {
  RecordingImportService,
  RecordingImportRepository,
  MeetingTranscriptRepository,
  MeetingOutputsRepository,
  createRecordingImportScheduler,
  createImportedMeetingSummaryScheduler,
  collectMeetingsExportSection,
  registerRecordingImportRoutes,
  type RecordingImportDependencies,
  type RecordingImportPayload
} from "@moss/meetings";
import { recordingChunkPath } from "../../packages/meetings/src/recording-upload-manifest.js";
import { recordingUpload } from "../fixtures/recording-upload.js";
import { recordingBundle } from "../fixtures/recording-bundle.js";
import { MeetingPreferencesRepository } from "../../packages/meetings/src/preferences.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let app: Kysely<MossDatabase>,
  bootstrap: Kysely<MossDatabase>,
  worker: Kysely<MossDatabase>,
  context: DataContextRunner,
  vault: VaultContextRunner,
  root: string,
  boss: PgBoss;
const actor = { actorUserId: ids.userA },
  other = { actorUserId: ids.userB };
const imports = new RecordingImportRepository(),
  transcripts = new MeetingTranscriptRepository();
const previousRoot = process.env.MOSS_VAULT_ROOT;
beforeAll(async () => {
  await resetFoundationDatabase();
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 6 });
  worker = createDatabase({ connectionString: connectionStrings.worker });
  context = new DataContextRunner(app);
  root = await mkdtemp(join(tmpdir(), "moss-upload-test-"));
  vault = new VaultContextRunner(root);
  process.env.MOSS_VAULT_ROOT = root;
  boss = createPgBossClient(connectionStrings.app);
  await boss.start();
  if (process.env.VOCCI_UPLOAD_NEGATIVE_CONTROL === "owner") {
    await sql`ALTER POLICY meeting_recording_chunks_owner ON app.meeting_recording_chunks USING(true) WITH CHECK(true)`.execute(
      bootstrap
    );
    await sql`ALTER POLICY meeting_recording_chunks_export_worker ON app.meeting_recording_chunks USING(true)`.execute(
      bootstrap
    );
  }
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await Promise.all([app?.destroy(), bootstrap?.destroy(), worker?.destroy()]);
  if (root) await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.MOSS_VAULT_ROOT;
  else process.env.MOSS_VAULT_ROOT = previousRoot;
});
function setup(overrides: Partial<RecordingImportDependencies> = {}) {
  const deps: RecordingImportDependencies = {
    dataContext: context,
    vault,
    assertAvailable: async () => {},
    schedule: createRecordingImportScheduler(boss),
    scheduleSummary: createImportedMeetingSummaryScheduler(boss),
    availability: async () => ({ ready: true, modelRoute: "synthetic-test" }),
    transcribe: vi.fn(async (_actor, input) =>
      input.dispatch(async () => ({
        segments: [{ startMs: 0, endMs: 100, text: "Generated window transcript" }]
      }))
    ),
    describeFailure: () => ({ retryable: true, unavailable: false }),
    ...overrides
  };
  return { deps, service: new RecordingImportService(deps) };
}
const job = (id: string, windowStartMs = 0): RecordingImportPayload => ({
  actorUserId: actor.actorUserId,
  resourceId: id,
  kind: "transcribe",
  windowStartMs
});
async function upload(service: RecordingImportService, fixture = recordingUpload()) {
  const reserved = await service.uploads.reserve(actor, fixture.manifest);
  for (const kind of ["packets", "sidecar", "wav"] as const) {
    let index = 0;
    for (const bytes of fixture.chunks(kind))
      await service.uploads.put(actor, reserved.id, kind, index++, bytes);
  }
  return { ...fixture, id: reserved.id };
}
async function serverFor(service: RecordingImportService) {
  const server = fastify();
  server.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, bytes, done) => done(null, bytes)
  );
  registerRecordingImportRoutes(server, {
    service,
    resolveAccessContext: async (request) => {
      const id = request.headers.authorization?.slice(7);
      if (![ids.userA, ids.userB, ids.adminUser].some((allowed) => allowed === id))
        throw new HttpError(401, "Unauthorized");
      return { actorUserId: id! };
    }
  });
  await server.ready();
  return server;
}
describe("resumable recording transport and checkpointed transcription", () => {
  it("refuses a hold upload aimed at a meeting", async () => {
    const { service } = setup();
    await expect(
      service.uploads.reserve(actor, recordingUpload(90_000, true).manifest)
    ).rejects.toMatchObject({ statusCode: 409 });
    const rows = await context.withDataContext(actor, (db) =>
      sql`SELECT 1 FROM app.meeting_recording_imports WHERE recording_id LIKE 'amsg\\_%'`.execute(
        db.db
      )
    );
    expect(rows.rows).toHaveLength(0);
  });
  it("refuses to finalize a hold upload that was reserved as a meeting before the rule", async () => {
    const { service } = setup();
    const uploaded = await upload(service, recordingUpload(30_500));
    await sql`UPDATE app.meeting_recording_imports SET source_manifest_json=replace(source_manifest_json, '"recordingId":"', '"recordingId":"amsg_') WHERE id=${uploaded.id}::uuid`.execute(
      bootstrap
    );
    await expect(service.uploads.finalize(actor, uploaded.id)).rejects.toMatchObject({
      statusCode: 409
    });
  });
  it("bounds real ASR end drift before checkpointing windows and schedules one final summary", async () => {
    const summary = vi.fn<RecordingImportDependencies["scheduleSummary"]>(async () => {});
    const transcribe = vi.fn<RecordingImportDependencies["transcribe"]>();
    transcribe.mockResolvedValueOnce({
      segments: [
        { startMs: 0, endMs: 29_840, text: "Before the boundary" },
        { startMs: 29_840, endMs: 30_340, text: "At the boundary" }
      ]
    });
    transcribe.mockResolvedValueOnce({
      segments: [{ startMs: 0, endMs: 840, text: "Short final window" }]
    });
    const { service } = setup({
      transcribe,
      scheduleSummary: summary,
      describeFailure: () => ({ retryable: false, unavailable: false })
    });
    const uploaded = await upload(service, recordingUpload(30_500));
    await service.uploads.finalize(actor, uploaded.id);
    const accepted = await service.status(actor, uploaded.id);
    await service.process(actor, job(uploaded.id));
    expect(await service.status(actor, uploaded.id)).toMatchObject({ state: "queued" });
    expect(summary).not.toHaveBeenCalled();
    await service.process(actor, job(uploaded.id, 30_000));
    expect(await service.status(actor, uploaded.id)).toMatchObject({
      state: "complete",
      meetingId: accepted!.meetingId
    });
    const snapshot = await context.withDataContext(actor, (db) =>
      transcripts.snapshot(db, accepted!.meetingId, { maxSegments: 500, maxCharacters: 100000 })
    );
    expect(
      snapshot!.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }))
    ).toEqual([
      { startMs: 0, endMs: 29_840, text: "Before the boundary" },
      { startMs: 29_840, endMs: 30_000, text: "At the boundary" },
      { startMs: 30_000, endMs: 30_500, text: "Short final window" }
    ]);
    await service.process(actor, job(uploaded.id, 30_000));
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(summary).toHaveBeenCalledTimes(1);
  });
  it("recovers thin audible speech with the same preferences and one 30-second checkpoint", async () => {
    const preferences = new MeetingPreferencesRepository();
    const sent = vi.fn();
    const schedule = vi.fn<RecordingImportDependencies["schedule"]>(async () => {});
    const transcribe = vi.fn<RecordingImportDependencies["transcribe"]>(async (_actor, input) =>
      input.dispatch(async () => {
        sent(input.audio);
        return {
          segments: [
            {
              startMs: 0,
              endMs: sent.mock.calls.length === 1 ? 1000 : 15_340,
              text:
                sent.mock.calls.length === 1
                  ? "Two words"
                  : "Recovered the missing stretch of speech in this half"
            }
          ]
        };
      })
    );
    const { service } = setup({ transcribe, schedule });
    const uploaded = await upload(service, recordingUpload(60_000, false, 0, 12_000));
    await service.uploads.finalize(actor, uploaded.id);
    try {
      await context.withDataContext(actor, (db) =>
        preferences.update(db, {
          transcriptLanguage: "es",
          transcriptVocabulary: ["José", "Moss"]
        })
      );
      await service.process(actor, job(uploaded.id));
      expect(sent).toHaveBeenCalledTimes(3);
      for (const [, request] of transcribe.mock.calls) {
        expect(request).toMatchObject({
          language: "es",
          prompt: "José, Moss",
          expectedModelRoute: "synthetic-test"
        });
        expect(request.signal).toBeInstanceOf(AbortSignal);
      }
      expect(new Set(transcribe.mock.calls.map(([, request]) => request.signal)).size).toBe(3);
      expect(sent.mock.calls.map(([audio]) => audio.length)).toEqual([
        44 + 30_000 * 32,
        44 + 15_000 * 32,
        44 + 15_000 * 32
      ]);
      const row = await context.withDataContext(actor, (db) => imports.get(db, uploaded.id));
      expect(row).toMatchObject({ next_window_ms: 30_000, attempts: 0, state: "queued" });
      expect(schedule.mock.calls.at(-1)![1]).toEqual(job(uploaded.id, 30_000));
      const snapshot = await context.withDataContext(actor, (db) =>
        transcripts.snapshot(db, row!.meeting_id!, { maxSegments: 500, maxCharacters: 100000 })
      );
      expect(snapshot!.segments.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual([
        { startMs: 0, endMs: 15_000 },
        { startMs: 15_000, endMs: 30_000 }
      ]);
      await service.process(actor, job(uploaded.id));
      expect(sent).toHaveBeenCalledTimes(3);
    } finally {
      await context.withDataContext(actor, (db) =>
        preferences.update(db, { transcriptLanguage: null, transcriptVocabulary: [] })
      );
    }
  });

  it.each([1, 2])(
    "rechecks dispatch admission after request %s supersedes the piece",
    async (supersedeAfter) => {
      const sent = vi.fn();
      const { service } = setup({
        transcribe: async (_actor, input) => {
          const result = await input.dispatch(async () => {
            sent();
            return { segments: [{ startMs: 0, endMs: 1000, text: "Two words" }] };
          });
          if (sent.mock.calls.length === supersedeAfter)
            await sql`UPDATE app.meeting_recording_imports SET state='failed' WHERE id=${importId}::uuid`.execute(
              bootstrap
            );
          return result;
        }
      });
      const uploaded = await upload(service, recordingUpload(30_000, false, 0, 12_000));
      const importId = uploaded.id;
      await service.uploads.finalize(actor, uploaded.id);
      await service.process(actor, job(uploaded.id));
      expect(sent).toHaveBeenCalledTimes(supersedeAfter);
      const row = await context.withDataContext(actor, (db) => imports.get(db, uploaded.id));
      expect(row).toMatchObject({ state: "failed", next_window_ms: 0 });
      const snapshot = await context.withDataContext(actor, (db) =>
        transcripts.snapshot(db, row!.meeting_id!, { maxSegments: 500, maxCharacters: 100000 })
      );
      expect(snapshot?.segments ?? []).toHaveLength(0);
    }
  );

  it("recovers a no-meeting voice piece before admitting its transcript once", async () => {
    const chat = new VoiceRequestService({
      dataContext: context,
      bootId: randomUUID(),
      now: () => new Date(),
      assertAvailable: async () => {},
      schedule: createVoiceRequestScheduler(boss),
      submit: async () => {
        throw new Error("Receiver test must not invoke a model");
      }
    });
    const admit = vi.fn<NonNullable<RecordingImportDependencies["admitVoiceRequest"]>>(
      async (db, input) => ({ id: (await chat.admitInTransaction(db, input)).request.id })
    );
    let calls = 0;
    const transcribe = vi.fn<RecordingImportDependencies["transcribe"]>(async (_actor, request) =>
      request.dispatch(async () => ({
        segments: [
          {
            startMs: 0,
            endMs: ++calls === 1 ? 1000 : 15_000,
            text: calls === 1 ? "Two words" : "Recovered the rest of this voice request"
          }
        ]
      }))
    );
    const { service } = setup({ transcribe, admitVoiceRequest: admit });
    const fixture = recordingUpload(30_000, true, 0, 12_000);
    const enabled = await service.enableVoice(actor, {
      version: 2,
      sourceDeviceId: fixture.manifest.sourceDeviceId,
      requestKey: randomUUID(),
      recordingIds: []
    });
    const uploaded = await upload(service, {
      ...fixture,
      manifest: {
        ...fixture.manifest,
        destination: { intent: "voice-request", enablementId: enabled.id, capturedAt: null }
      }
    });
    await service.uploads.finalize(actor, uploaded.id);
    await service.process(actor, job(uploaded.id));
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]![1].transcript).toBe(
      "Recovered the rest of this voice request\nRecovered the rest of this voice request"
    );
    const row = await context.withDataContext(actor, (db) => imports.get(db, uploaded.id));
    expect(row).toMatchObject({ meeting_id: null, next_window_ms: 30_000, state: "complete" });
    for (const [, request] of transcribe.mock.calls) expect(request).not.toHaveProperty("language");
    await service.process(actor, job(uploaded.id));
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("retains a safe failure when a window request rejects during admission commit", async () => {
    const { service } = setup({
      describeFailure: () => ({ retryable: false, unavailable: false }),
      transcribe: async (_actor, request) =>
        request.dispatch(async () => {
          throw new Error("Synthetic immediate window transport rejection");
        })
    });
    const normal = await upload(service, recordingUpload(60000));
    await service.uploads.finalize(actor, normal.id);
    await service.process(actor, job(normal.id));
    expect(await service.status(actor, normal.id)).toMatchObject({
      state: "failed",
      code: "transcription_failed"
    });
  });
  it("applies changed language to subsequent normal windows", async () => {
    const preferences = new MeetingPreferencesRepository();
    try {
      const { service, deps } = setup();
      const normal = await upload(service, recordingUpload(60_000));
      await service.uploads.finalize(actor, normal.id);
      await context.withDataContext(actor, (db) =>
        preferences.update(db, { transcriptLanguage: "es", transcriptVocabulary: ["José", "Moss"] })
      );
      await service.process(actor, job(normal.id));
      expect(vi.mocked(deps.transcribe).mock.calls[0]![1].language).toBe("es");
      expect(vi.mocked(deps.transcribe).mock.calls[0]![1].prompt).toBe("José, Moss");
      await context.withDataContext(actor, (db) =>
        preferences.update(db, { transcriptLanguage: null, transcriptVocabulary: [] })
      );
      await service.process(actor, job(normal.id, 30_000));
      expect(vi.mocked(deps.transcribe).mock.calls[1]![1]).not.toHaveProperty("language");
      expect(vi.mocked(deps.transcribe).mock.calls[1]![1]).not.toHaveProperty("prompt");
      expect(await service.status(actor, normal.id)).toMatchObject({ state: "complete" });
    } finally {
      await context.withDataContext(actor, (db) =>
        preferences.update(db, { transcriptLanguage: null, transcriptVocabulary: [] })
      );
    }
  });
  it.each([
    [2_513_160, -4_160],
    [442_320, -2_320]
  ])(
    "finalizes a %s ms recording whose ring clock drifted %s ms through the HTTP receiver",
    async (durationMs, driftMs) => {
      const { service } = setup();
      const uploaded = await upload(service, recordingUpload(durationMs, false, driftMs));
      const server = await serverFor(service);
      try {
        const response = await server.inject({
          method: "POST",
          url: `/api/meetings/recording-uploads/${uploaded.id}/finalize`,
          headers: { authorization: `Bearer ${ids.userA}`, "content-type": "application/json" },
          payload: "null"
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ ready: true });
      } finally {
        await server.close();
      }
    }
  );

  it("admits one short resumable hold transcript through the real Chat boundary after its final window", async () => {
    const chat = new VoiceRequestService({
      dataContext: context,
      bootId: randomUUID(),
      now: () => new Date(),
      assertAvailable: async () => {},
      schedule: createVoiceRequestScheduler(boss),
      submit: async () => {
        throw new Error("This receiver test must not invoke a model");
      }
    });
    const admit = vi.fn<NonNullable<RecordingImportDependencies["admitVoiceRequest"]>>(
      async (db, input) => ({ id: (await chat.admitInTransaction(db, input)).request.id })
    );
    const { service, deps } = setup({
        admitVoiceRequest: admit,
        describeFailure: () => ({ retryable: false, unavailable: true })
      }),
      fixture = recordingUpload(90_000, true);
    const enabled = await service.enableVoice(actor, {
      version: 2,
      sourceDeviceId: fixture.manifest.sourceDeviceId,
      requestKey: randomUUID(),
      recordingIds: []
    });
    const source = {
      ...fixture,
      manifest: {
        ...fixture.manifest,
        destination: {
          intent: "voice-request" as const,
          enablementId: enabled.id,
          capturedAt: null
        }
      }
    };
    const uploaded = await upload(service, source);
    await service.uploads.finalize(actor, uploaded.id);
    const preferences = new MeetingPreferencesRepository();
    await context.withDataContext(actor, (db) =>
      preferences.update(db, { transcriptLanguage: "es" })
    );
    try {
      await service.process(actor, job(uploaded.id));
      expect(vi.mocked(deps.transcribe).mock.calls[0]![1]).not.toHaveProperty("language");
    } finally {
      await context.withDataContext(actor, (db) =>
        preferences.update(db, { transcriptLanguage: null })
      );
    }
    vi.mocked(deps.transcribe).mockRejectedValueOnce(new Error("Provider unavailable"));
    await service.process(actor, job(uploaded.id, 30_000));
    const failed = (await service.voiceStatus(actor, uploaded.id))!;
    expect(failed.state).toBe("failed");
    expect(failed.retryable).toBe(true);
    await service.retryVoice(actor, uploaded.id);
    await service.process(actor, job(uploaded.id, 30_000));
    expect(admit).not.toHaveBeenCalled();
    await service.process(actor, job(uploaded.id, 60_000));
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]![1].transcript).toBe(
      [
        "Generated window transcript",
        "Generated window transcript",
        "Generated window transcript"
      ].join("\n")
    );
    const status = (await service.voiceStatus(actor, uploaded.id))!;
    expect(status.state).toBe("complete");
    expect(status.voiceRequestId).toBeTruthy();
    await service.process(actor, job(uploaded.id, 60_000));
    expect(admit).toHaveBeenCalledTimes(1);
  });
  it("concurrently reserves one immutable identity before allocated files and rejects destination/protocol changes", async () => {
    const { service } = setup(),
      fixture = recordingUpload();
    const [first, second] = await Promise.all([
      service.uploads.reserve(actor, fixture.manifest),
      service.uploads.reserve(actor, fixture.manifest)
    ]);
    expect(first.id).toBe(second.id);
    expect(first.reserved).toBe(true);
    expect(first.ready).toBe(false);
    const files = await vault.withVaultContext(actor, (ctx) =>
      listVaultFilesRecursive(ctx, `meeting-recordings/${first.id}`)
    );
    expect(files.filter((path) => path.endsWith(".reserved")).length).toBe(5);
    await expect(
      service.uploads.reserve(actor, {
        ...fixture.manifest,
        destination: { intent: "voice-request", enablementId: randomUUID(), capturedAt: null }
      })
    ).rejects.toThrow();
    await expect(
      service.accept(actor, {
        ...recordingBundle(),
        sourceDeviceId: fixture.manifest.sourceDeviceId,
        recordingId: fixture.manifest.recordingId,
        packets: { ...recordingBundle().packets, name: `${fixture.manifest.recordingId}.opus` },
        sidecar: { ...recordingBundle().sidecar, name: `${fixture.manifest.recordingId}.json` },
        wav: { ...recordingBundle().wav, name: `${fixture.manifest.recordingId}.wav` }
      })
    ).rejects.toThrow();
  });
  it("repairs bytes published before a lost DB acknowledgement; exact replay succeeds and changed bytes conflict", async () => {
    const { service } = setup(),
      fixture = recordingUpload(),
      reserved = await service.uploads.reserve(actor, fixture.manifest);
    const bytes = [...fixture.chunks("packets")][0]!;
    await vault.withVaultContext(actor, (ctx) =>
      publishReservedVaultFileBytes(ctx, recordingChunkPath(reserved.id, "packets", 0), bytes)
    );
    expect((await service.uploads.status(actor, reserved.id)).received.packets).toEqual([]);
    expect(
      (
        await new RecordingImportService(setup().deps).uploads.put(
          actor,
          reserved.id,
          "packets",
          0,
          bytes
        )
      ).received.packets
    ).toEqual([0]);
    const changed = Buffer.from(bytes);
    changed[2] = 1;
    await expect(service.uploads.put(actor, reserved.id, "packets", 0, changed)).rejects.toThrow();
    expect(
      (await service.uploads.put(actor, reserved.id, "packets", 0, bytes)).received.packets
    ).toEqual([0]);
    await expect(service.uploads.finalize(actor, reserved.id)).rejects.toThrow("incomplete");
  });
  it("enforces owner/admin isolation on import progress and chunk RLS for app and export workers", async () => {
    const { service } = setup(),
      uploaded = await upload(service);
    for (const owner of [other, { actorUserId: ids.adminUser }]) {
      await expect(service.uploads.status(owner, uploaded.id)).rejects.toThrow("not found");
      await expect(service.uploads.finalize(owner, uploaded.id)).rejects.toThrow("not found");
      for (const runner of [context, new DataContextRunner(worker)]) {
        const rows = await runner.withDataContext(
          owner,
          async (db) =>
            (
              await sql`SELECT import_id FROM app.meeting_recording_chunks WHERE import_id=${uploaded.id}::uuid`.execute(
                db.db
              )
            ).rows
        );
        expect(rows).toEqual([]);
      }
    }
  });
  it("requires native user access for reserve, progress, binary chunks and finalize HTTP routes", async () => {
    const { service } = setup(),
      uploaded = await upload(service),
      server = await serverFor(service);
    try {
      for (const [method, suffix, payload] of [
        ["POST", "", uploaded.manifest],
        ["GET", `/${uploaded.id}`, undefined],
        ["PUT", `/${uploaded.id}/packets/0`, [...uploaded.chunks("packets")][0]],
        ["POST", `/${uploaded.id}/finalize`, undefined]
      ] as const) {
        const result = await server.inject({
          method,
          url: `/api/meetings/recording-uploads${suffix}`,
          headers: {
            authorization: `Bearer ${ids.userA}`,
            [ACT_AS_GRANT_HEADER]: randomUUID(),
            ...(method === "PUT" ? { "content-type": "application/octet-stream" } : {})
          },
          payload
        });
        expect(result.statusCode).toBe(403);
      }
    } finally {
      await server.close();
    }
  });
  it("hash-checks retained chunks at finalization and again before each transcription window", async () => {
    const { service, deps } = setup({
        describeFailure: () => ({ retryable: false, unavailable: false })
      }),
      uploaded = await upload(service);
    const path = recordingChunkPath(uploaded.id, "wav", 0);
    const bytes = [...uploaded.chunks("wav")][0]!;
    bytes[100] = 255;
    await vault.withVaultContext(actor, (ctx) => writeVaultFileBytes(ctx, path, bytes));
    await expect(service.uploads.finalize(actor, uploaded.id)).rejects.toThrow("changed");
    await vault.withVaultContext(actor, (ctx) =>
      writeVaultFileBytes(ctx, path, [...uploaded.chunks("wav")][0]!)
    );
    await service.uploads.finalize(actor, uploaded.id);
    await vault.withVaultContext(actor, (ctx) => writeVaultFileBytes(ctx, path, bytes));
    await service.process(actor, job(uploaded.id));
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect((await service.status(actor, uploaded.id))!.state).toBe("failed");
    await vault.withVaultContext(actor, (ctx) =>
      writeVaultFileBytes(ctx, path, [...uploaded.chunks("wav")][0]!)
    );
  });
  it("checkpoints atomically, preserves external transcript corrections and ignores old window jobs", async () => {
    const { service, deps } = setup(),
      uploaded = await upload(service);
    await service.uploads.finalize(actor, uploaded.id);
    await service.process(actor, job(uploaded.id));
    const row = await context.withDataContext(actor, (db) => imports.get(db, uploaded.id));
    expect(row!.next_window_ms).toBe(30_000);
    expect(row!.attempts).toBe(0);
    const meetingId = row!.meeting_id!;
    await context.withDataContext(actor, async (db) => {
      const state = (await transcripts.approvalSnapshot(db, meetingId))!;
      const segment = state.ledger!.revisions[0]!.segment;
      const saved = await transcripts.ingest(db, {
        meetingId,
        requestKey: randomUUID(),
        expectedVersion: state.receipt.version,
        sources: state.ledger!.sources,
        stopCutoffMs: 90_000,
        events: [
          {
            cursor: state.receipt.cursor + 1,
            segment: { ...segment, revision: 2, provenance: "correction", text: "Owner correction" }
          }
        ]
      });
      expect(saved.status).toBe("saved");
    });
    await service.process(actor, job(uploaded.id));
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    await service.process(actor, job(uploaded.id, 30_000));
    await service.process(actor, job(uploaded.id, 60_000));
    expect((await service.status(actor, uploaded.id))!.state).toBe("complete");
    const snapshot = await context.withDataContext(actor, (db) =>
      transcripts.snapshot(db, meetingId, { maxSegments: 500, maxCharacters: 100000 })
    );
    expect(snapshot!.segments.map((segment) => segment.text)).toEqual([
      "Owner correction",
      "Generated window transcript",
      "Generated window transcript"
    ]);
    await service.process(actor, job(uploaded.id, 60_000));
    expect(deps.transcribe).toHaveBeenCalledTimes(3);
  });
  it("preserves a transcript source created before the first imported window", async () => {
    const { service } = setup(),
      uploaded = await upload(service, recordingUpload(1000));
    await service.uploads.finalize(actor, uploaded.id);
    const row = await context.withDataContext(actor, (db) => imports.get(db, uploaded.id));
    const meetingId = row!.meeting_id!;
    await context.withDataContext(actor, async (db) => {
      const state = (await transcripts.approvalSnapshot(db, meetingId))!;
      const saved = await transcripts.ingest(db, {
        meetingId,
        requestKey: randomUUID(),
        expectedVersion: state.receipt.version,
        sources: [
          {
            sourceId: "prior-source",
            epoch: 1,
            kind: "recording",
            label: "Prior source",
            startMs: 0,
            endMs: 1000
          }
        ],
        events: [
          {
            cursor: state.receipt.cursor + 1,
            segment: {
              meetingId,
              segmentId: "prior-segment",
              sourceId: "prior-source",
              epoch: 1,
              revision: 1,
              finality: "final",
              provenance: "transcription",
              startMs: 0,
              endMs: 100,
              text: "Prior transcript",
              speakerId: null
            }
          }
        ],
        stopCutoffMs: 1000
      });
      expect(saved.status).toBe("saved");
    });
    await service.process(actor, job(uploaded.id));
    expect((await service.status(actor, uploaded.id))!.state).toBe("complete");
    const state = await context.withDataContext(actor, (db) =>
      transcripts.approvalSnapshot(db, meetingId)
    );
    expect(state!.ledger!.sources.map((source) => source.sourceId).sort()).toEqual(
      ["prior-source", uploaded.id].sort()
    );
    const snapshot = await context.withDataContext(actor, (db) =>
      transcripts.snapshot(db, meetingId, { maxSegments: 500, maxCharacters: 100000 })
    );
    expect(snapshot!.segments.map((segment) => segment.text)).toEqual(
      expect.arrayContaining(["Prior transcript", "Generated window transcript"])
    );
  });
  it("rolls back a checkpoint when scheduling its next job fails and resets retry attempts per window", async () => {
    const base = setup();
    let fail = false;
    const { service } = setup({
      schedule: async (...args) => {
        if (fail && args[1].windowStartMs === 30_000)
          throw new Error("Synthetic scheduling failure");
        await base.deps.schedule(...args);
      }
    });
    const uploaded = await upload(service);
    await service.uploads.finalize(actor, uploaded.id);
    fail = true;
    await expect(service.process(actor, job(uploaded.id))).rejects.toThrow("retry pending");
    const failed = await context.withDataContext(actor, (db) => imports.get(db, uploaded.id));
    expect(failed!.next_window_ms).toBe(0);
    expect(failed!.attempts).toBe(1);
    const snapshot = await context.withDataContext(actor, (db) =>
      transcripts.approvalSnapshot(db, failed!.meeting_id!)
    );
    expect(snapshot!.receipt.version).toBe(0);
    fail = false;
    await service.process(actor, job(uploaded.id));
    const advanced = await context.withDataContext(actor, (db) => imports.get(db, uploaded.id));
    expect(advanced!.next_window_ms).toBe(30_000);
    expect(advanced!.attempts).toBe(0);
  });
  it("expires abandoned allocated files without reopening their immutable identity", async () => {
    const { service } = setup(),
      fixture = recordingUpload(),
      reserved = await service.uploads.reserve(actor, fixture.manifest);
    await service.uploads.put(actor, reserved.id, "packets", 0, [...fixture.chunks("packets")][0]!);
    await sql`UPDATE app.meeting_recording_imports SET upload_expires_at=now()-interval '1 second' WHERE id=${reserved.id}::uuid`.execute(
      bootstrap
    );
    await expect(
      service.uploads.put(actor, reserved.id, "packets", 0, [...fixture.chunks("packets")][0]!)
    ).rejects.toThrow("expired");
    await service.process(actor, {
      actorUserId: actor.actorUserId,
      resourceId: reserved.id,
      kind: "abandoned"
    });
    const expired = await service.uploads.status(actor, reserved.id);
    expect(expired.expired).toBe(true);
    expect(expired.reserved).toBe(false);
    expect(expired.received).toEqual({ packets: [], sidecar: [], wav: [] });
    expect(
      await vault.withVaultContext(actor, async (ctx) =>
        (await listVaultFilesRecursive(ctx)).filter((path) =>
          path.startsWith(`meeting-recordings/${reserved.id}/`)
        )
      )
    ).toEqual([]);
    await expect(service.uploads.reserve(actor, fixture.manifest)).rejects.toThrow("expired");
  });
  it("exports long-source bytes in independently hash-checked chunks using actual worker credentials", async () => {
    const { service } = setup(),
      uploaded = await upload(service);
    await service.uploads.finalize(actor, uploaded.id);
    const section = await new DataContextRunner(worker).withDataContext(actor, (db) =>
      collectMeetingsExportSection(db, { ...actor, requestId: "upload-export-test" })
    );
    const exported = section.recording_imports.find((row) => row.id === uploaded.id)!;
    const chunks = exported.chunks as { kind: string; sha256: string; base64: string }[];
    expect(chunks.length).toBe(5);
    expect(exported.sourceManifestJson).toBeTypeOf("string");
    for (const chunk of chunks)
      expect(createHash("sha256").update(Buffer.from(chunk.base64, "base64")).digest("hex")).toBe(
        chunk.sha256
      );
    expect(exported.bundleJson).toBeUndefined();
  });
  it("accepts the generated two-hour boundary over binary HTTP and completes 240 durable windows before one summary", async () => {
    const summary = vi.fn<RecordingImportDependencies["scheduleSummary"]>(async () => {});
    const transcribe = vi.fn<RecordingImportDependencies["transcribe"]>(async (_actor, input) =>
      input.dispatch(async () => ({
        segments: [0, 1, 2].map((i) => ({
          startMs: i * 100,
          endMs: i * 100 + 100,
          text: "Synthetic two-hour transport fixture ".repeat(8)
        }))
      }))
    );
    const { service } = setup({ scheduleSummary: summary, transcribe }),
      fixture = recordingUpload(7_200_000),
      server = await serverFor(service);
    const headers = { authorization: `Bearer ${ids.userA}` };
    try {
      const reservation = await server.inject({
        method: "POST",
        url: "/api/meetings/recording-uploads",
        headers,
        payload: fixture.manifest
      });
      expect(reservation.statusCode).toBe(200);
      const id = reservation.json<{ id: string }>().id;
      for (const kind of ["packets", "sidecar", "wav"] as const) {
        let index = 0;
        for (const payload of fixture.chunks(kind)) {
          const response = await server.inject({
            method: "PUT",
            url: `/api/meetings/recording-uploads/${id}/${kind}/${index++}`,
            headers: { ...headers, "content-type": "application/octet-stream" },
            payload
          });
          expect(response.statusCode).toBe(200);
        }
      }
      const finalized = await server.inject({
        method: "POST",
        url: `/api/meetings/recording-uploads/${id}/finalize`,
        headers
      });
      expect(finalized.statusCode).toBe(200);
      expect(finalized.json().ready).toBe(true);
      // Android sends explicit JSON null to avoid its implicit form Content-Type.
      const nativeReplay = await server.inject({
        method: "POST",
        url: `/api/meetings/recording-uploads/${id}/finalize`,
        headers: { ...headers, "content-type": "application/json" },
        payload: "null"
      });
      expect(nativeReplay.statusCode).toBe(200);
      expect(nativeReplay.json().ready).toBe(true);
      await service.uploads.finalize(actor, id);
      for (let start = 0; start < 7_200_000; start += 30_000) {
        expect(summary).not.toHaveBeenCalled();
        await service.process(actor, job(id, start));
      }
      expect(summary).toHaveBeenCalledTimes(1);
      expect(transcribe).toHaveBeenCalledTimes(240);
      const status = (await service.status(actor, id))!;
      expect(status.state).toBe("complete");
      expect(status.bookmarksMs).toEqual([1000]);
      const output = await context.withDataContext(actor, (db) =>
        new MeetingOutputsRepository().inputs(db, status.meetingId)
      );
      expect(output.transcript!.segments).toHaveLength(720);
      expect(output.transcript!.omittedSegments).toBe(0);
      expect(output.transcript!.segments.at(-1)!.startMs).toBe(7_170_200);
      const tooLong = recordingUpload(7_200_001);
      expect(
        (
          await server.inject({
            method: "POST",
            url: "/api/meetings/recording-uploads",
            headers,
            payload: tooLong.manifest
          })
        ).statusCode
      ).toBe(413);
    } finally {
      await server.close();
    }
  }, 180_000);
});
