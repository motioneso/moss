import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { VoiceRequestService, createVoiceRequestScheduler } from "@moss/chat";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  RecordingImportService,
  collectMeetingsExportSection,
  type RecordingImportDependencies
} from "@moss/meetings";
import { VaultContextRunner } from "@moss/vault";
import { recordingBundle, recordingFile } from "../fixtures/recording-bundle.js";
import { MeetingPreferencesRepository } from "../../packages/meetings/src/preferences.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const previousVaultRoot = process.env.MOSS_VAULT_ROOT;
const actor = { actorUserId: ids.userA },
  other = { actorUserId: ids.userB };
let db: Kysely<MossDatabase>,
  rootDb: Kysely<MossDatabase>,
  context: DataContextRunner,
  boss: PgBoss,
  root: string;
beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  rootDb = createDatabase({ connectionString: connectionStrings.bootstrap });
  context = new DataContextRunner(db);
  boss = createPgBossClient(connectionStrings.app);
  await boss.start();
  root = await mkdtemp(join(tmpdir(), "moss-voice-imports-"));
  process.env.MOSS_VAULT_ROOT = root;
  if (process.env.VOCCI_ENABLEMENT_RLS_NEGATIVE_CONTROL === "1")
    await sql`ALTER TABLE app.meeting_recording_voice_enablements DISABLE ROW LEVEL SECURITY`.execute(
      rootDb
    );
});
afterAll(async () => {
  await boss?.stop({ graceful: true });
  await Promise.allSettled([db?.destroy(), rootDb?.destroy()]);
  if (root) await rm(root, { recursive: true, force: true });
  if (previousVaultRoot === undefined) delete process.env.MOSS_VAULT_ROOT;
  else process.env.MOSS_VAULT_ROOT = previousVaultRoot;
});

function setup(options: { fresh?: boolean; text?: string; failAdmission?: boolean } = {}) {
  const source = { ...recordingBundle(true), sourceDeviceId: randomUUID() };
  const capturedAt = new Date(Date.now() - 1000).toISOString();
  if (options.fresh) {
    const ms = Date.parse(capturedAt),
      seconds = String(Math.floor(ms / 1000));
    source.sidecar = recordingFile(
      `${source.recordingId}.json`,
      Buffer.from(
        `{"record":["${ms}","start"]},{"duration":["${seconds}","120"]},{"record":["${ms + 120}","end"]}`
      )
    );
  }
  const chat = new VoiceRequestService({
    dataContext: context,
    bootId: randomUUID(),
    now: () => new Date(),
    assertAvailable: async () => {},
    schedule: createVoiceRequestScheduler(boss),
    submit: async () => {
      throw new Error("This receiver proof must not invoke a model");
    }
  });
  let failAdmission = options.failAdmission ?? false;
  let attemptedId = "";
  const summary = vi.fn(async () => {});
  const deps: RecordingImportDependencies = {
    dataContext: context,
    vault: new VaultContextRunner(root),
    assertAvailable: async () => {},
    availability: async () => ({ ready: true, modelRoute: "synthetic" }),
    transcribe: async (_actor, input) =>
      input.dispatch(async () => ({
        segments:
          options.text === ""
            ? []
            : [{ startMs: 0, endMs: 120, text: options.text ?? "Synthetic voice question" }]
      })),
    schedule: async () => {},
    scheduleSummary: summary,
    describeFailure: () => ({ retryable: false, unavailable: false }),
    async admitVoiceRequest(scopedDb, input) {
      const admission = await chat.admitInTransaction(scopedDb, input);
      attemptedId = admission.request.id;
      if (failAdmission) {
        failAdmission = false;
        throw new Error("Synthetic commit interruption");
      }
      return { id: admission.request.id };
    }
  };
  const service = new RecordingImportService(deps);
  const snapshot = {
    version: 2,
    sourceDeviceId: source.sourceDeviceId,
    requestKey: randomUUID(),
    recordingIds: [] as string[]
  };
  return {
    service,
    chat,
    source,
    snapshot,
    summary,
    deps,
    attemptedId: () => attemptedId,
    async enable(recordingIds: string[] = []) {
      const enabled = await service.enableVoice(actor, { ...snapshot, recordingIds });
      if (options.fresh)
        await sql`UPDATE app.meeting_recording_voice_enablements SET enabled_at=${new Date(Date.parse(capturedAt) - 1000)} WHERE id=${enabled.id}::uuid`.execute(
          rootDb
        );
      return {
        version: 2 as const,
        intent: "voice-request" as const,
        enablementId: enabled.id,
        capturedAt: options.fresh ? capturedAt : null,
        recording: source
      };
    },
    process(id: string) {
      return service.process(actor, {
        actorUserId: actor.actorUserId,
        resourceId: id,
        kind: "transcribe"
      });
    }
  };
}

describe("explicit versioned voice recording receiver", () => {
  it("keeps version-one hold files as meetings forever", async () => {
    const f = setup();
    const prior = await f.service.accept(actor, f.source);
    await f.process(prior.id);
    expect(await f.service.status(actor, prior.id)).toMatchObject({
      state: "complete",
      meetingId: prior.meetingId
    });
    expect(f.summary).toHaveBeenCalledOnce();
    const voice = await f.enable();
    await expect(f.service.acceptVoice(actor, voice)).rejects.toThrow();
    expect(await f.chat.list(actor)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_device_id: f.source.sourceDeviceId })
      ])
    );
  });
  it("rejects the baseline even after disable and a later empty snapshot", async () => {
    const f = setup();
    const voice = await f.enable([f.source.recordingId]);
    await expect(f.service.acceptVoice(actor, voice)).rejects.toThrow(/inventory/);
    await f.service.disableVoice(actor, voice.enablementId);
    const later = await f.service.enableVoice(actor, { ...f.snapshot, requestKey: randomUUID() });
    await expect(
      f.service.acceptVoice(actor, { ...voice, enablementId: later.id })
    ).rejects.toThrow(/inventory/);
  });
  it("retains uncertain audio and admits one reviewable Main request without creating a meeting", async () => {
    const f = setup(),
      voice = await f.enable();
    const accepted = await f.service.acceptVoice(actor, voice);
    expect(accepted).toMatchObject({ state: "queued", voiceRequestId: null });
    const transcribe = vi.spyOn(f.deps, "transcribe");
    const preferences = new MeetingPreferencesRepository();
    await context.withDataContext(actor, (db) =>
      preferences.update(db, { transcriptLanguage: "es", transcriptVocabulary: ["José"] })
    );
    try {
      await f.process(accepted.id);
      expect(transcribe).toHaveBeenCalledTimes(1);
      expect(transcribe.mock.calls[0]![1]).not.toHaveProperty("language");
      expect(transcribe.mock.calls[0]![1]).not.toHaveProperty("prompt");
    } finally {
      await context.withDataContext(actor, (db) =>
        preferences.update(db, { transcriptLanguage: null, transcriptVocabulary: [] })
      );
    }
    const status = await f.service.voiceStatus(actor, accepted.id);
    expect(status).toMatchObject({ state: "complete", voiceRequestId: expect.any(String) });
    expect(await f.chat.status(actor, status!.voiceRequestId!)).toMatchObject({
      state: "queued",
      automatic: false,
      transcript: "Synthetic voice question"
    });
    expect(f.summary).not.toHaveBeenCalled();
    expect(await f.service.status(actor, accepted.id)).toBeNull();
    const backing = await sql<{
      meeting_id: string | null;
    }>`SELECT meeting_id FROM app.meeting_recording_imports WHERE id=${accepted.id}::uuid`.execute(
      rootDb
    );
    expect(backing.rows[0]!.meeting_id).toBeNull();
    await f.process(accepted.id);
    expect(await f.service.acceptVoice(actor, voice)).toMatchObject({
      id: accepted.id,
      created: false,
      voiceRequestId: status!.voiceRequestId
    });
    expect(await f.service.retryVoice(actor, accepted.id)).toEqual(status);
    await expect(
      f.service.acceptVoice(actor, { ...voice, capturedAt: new Date().toISOString() })
    ).rejects.toThrow();
    const retained = (
      await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM app.chat_voice_requests WHERE source_device_id=${f.source.sourceDeviceId}`.execute(
        rootDb
      )
    ).rows[0]!.n;
    expect(retained).toBe(1);
  });
  it("queues a fresh capture after enablement, while silence produces no turn", async () => {
    for (const text of ["Synthetic fresh question", ""]) {
      const f = setup({ fresh: true, text }),
        voice = await f.enable();
      const accepted = await f.service.acceptVoice(actor, voice);
      await f.process(accepted.id);
      const status = await f.service.voiceStatus(actor, accepted.id);
      expect(await f.chat.status(actor, status!.voiceRequestId!)).toMatchObject({
        state: text ? "queued" : "no-speech",
        automatic: true
      });
    }
  });
  it("rolls admission and its queued job back with completion, then permits transcription retry", async () => {
    const f = setup({ fresh: true, failAdmission: true }),
      voice = await f.enable();
    const accepted = await f.service.acceptVoice(actor, voice);
    await f.process(accepted.id);
    expect(await f.service.voiceStatus(actor, accepted.id)).toMatchObject({
      state: "failed",
      voiceRequestId: null,
      retryable: true
    });
    expect(await f.chat.status(actor, f.attemptedId())).toBeUndefined();
    const jobs =
      await sql`SELECT id FROM pgboss.job WHERE data->>'resourceId'=${f.attemptedId()}`.execute(
        rootDb
      );
    expect(jobs.rows).toHaveLength(0);
    expect(await f.service.retryVoice(actor, accepted.id)).toMatchObject({ state: "queued" });
    await f.process(accepted.id);
    expect(await f.service.voiceStatus(actor, accepted.id)).toMatchObject({
      state: "complete",
      voiceRequestId: expect.any(String)
    });
  });
  it("keeps enablement snapshots owner-scoped, immutable and bound to the source ring", async () => {
    const f = setup(),
      voice = await f.enable();
    const same = await f.service.enableVoice(actor, f.snapshot);
    expect(same.id).toBe(voice.enablementId);
    await expect(
      f.service.enableVoice(actor, { ...f.snapshot, recordingIds: [f.source.recordingId] })
    ).rejects.toThrow(/changed/);
    const secondOwner = await f.service.enableVoice(other, f.snapshot);
    expect(secondOwner.id).not.toBe(same.id);
    await expect(f.service.acceptVoice(other, voice)).rejects.toThrow();
    await expect(
      f.service.acceptVoice(actor, {
        ...voice,
        recording: { ...f.source, sourceDeviceId: randomUUID() }
      })
    ).rejects.toThrow();
    expect(await f.service.disableVoice(other, same.id)).toBeNull();
    await f.service.disableVoice(actor, same.id);
    expect(await f.service.enableVoice(actor, f.snapshot)).toMatchObject({
      id: same.id,
      enabled: false
    });
    await expect(f.service.acceptVoice(actor, voice)).rejects.toThrow();
  });
  it("exports the enablement inventory through the owner-scoped public collector", async () => {
    const f = setup(),
      voice = await f.enable([f.source.recordingId]);
    const exported = await context.withDataContext(actor, (scoped) =>
      collectMeetingsExportSection(scoped, {
        actorUserId: actor.actorUserId,
        requestId: "voice-export-proof"
      })
    );
    expect(exported.voice_enablements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: voice.enablementId,
          inventoryJson: JSON.stringify([f.source.recordingId])
        })
      ])
    );
    const others = await context.withDataContext(other, (scoped) =>
      collectMeetingsExportSection(scoped, {
        actorUserId: other.actorUserId,
        requestId: "other-export-proof"
      })
    );
    expect(others.voice_enablements).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: voice.enablementId })])
    );
  });
});
