import { randomUUID } from "node:crypto";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import {
  createVaultFile,
  deleteVaultDir,
  readVaultFile,
  type VaultContextRunner
} from "@moss/vault";
import { HttpError } from "@moss/module-sdk";
import type { VoiceRequestInput } from "@moss/shared";
import {
  RecordingVoiceEnablementRepository,
  RecordingVoiceIneligibleError
} from "./recording-voice-enablement.js";
import { validateVoiceRecordingBundle } from "./recording-voice-bundle.js";
import { validateRecordingBundle, type RecordingBundle } from "./recording-bundle.js";
import {
  RecordingImportConflictError,
  RecordingImportRepository,
  recordingImportStatus,
  voiceRecordingImportStatus
} from "./recording-import-repository.js";
import { MeetingRecordsRepository } from "./repository.js";
import { MeetingTranscriptRepository } from "./transcript-repository.js";
import { RecordingUploadRepository } from "./recording-upload-repository.js";
import { RecordingUploadService } from "./recording-upload-service.js";
import { RecordingWindowService } from "./recording-window-service.js";
import { MeetingPreferencesRepository } from "./preferences.js";

export interface RecordingImportPayload {
  actorUserId: string;
  resourceId: string;
  kind: "transcribe" | "abandoned" | "purge";
  windowStartMs?: number;
}
export interface RecordingImportDependencies {
  dataContext: Pick<DataContextRunner, "withDataContext">;
  vault: Pick<VaultContextRunner, "withVaultContext">;
  assertAvailable(actor: AccessContext): Promise<void>;
  schedule(
    db: DataContextDb,
    payload: RecordingImportPayload,
    delaySeconds?: number
  ): Promise<void>;
  scheduleSummary(
    db: DataContextDb,
    actor: AccessContext,
    input: { meetingId: string; importId: string }
  ): Promise<void>;
  admitVoiceRequest?(db: DataContextDb, input: VoiceRequestInput): Promise<{ id: string }>;
  availability(actor: AccessContext): Promise<{ ready: boolean; modelRoute: string | null }>;
  transcribe(
    actor: AccessContext,
    input: {
      audio: Uint8Array;
      language?: string;
      readonly prompt?: string;
      signal: AbortSignal;
      expectedModelRoute: string;
      dispatch<T>(
        send: () => Promise<T>,
        validate?: (db: DataContextDb) => Promise<void>
      ): Promise<T>;
    }
  ): Promise<{ segments: readonly { startMs: number; endMs: number; text: string }[] }>;
  describeFailure(error: unknown): { retryable: boolean; unavailable: boolean };
}
export const recordingBundlePath = (id: string) => `meeting-recordings/${id}/bundle.json`;
export class RecordingImportService {
  private readonly imports = new RecordingImportRepository();
  private readonly records = new MeetingRecordsRepository();
  readonly uploads: RecordingUploadService;
  constructor(private readonly deps: RecordingImportDependencies) {
    this.uploads = new RecordingUploadService(deps);
  }
  async accept(actor: AccessContext, value: unknown) {
    await this.deps.assertAvailable(actor);
    const bundle = validateRecordingBundle(value);
    const result = await this.acceptBundle(actor, bundle);
    return { created: result.created, ...recordingImportStatus(result.row) };
  }
  async enableVoice(actor: AccessContext, value: unknown) {
    await this.deps.assertAvailable(actor);
    return this.deps.dataContext.withDataContext(actor, (db) =>
      new RecordingVoiceEnablementRepository().enable(db, value)
    );
  }
  async disableVoice(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    return this.deps.dataContext.withDataContext(actor, (db) =>
      new RecordingVoiceEnablementRepository().disable(db, id)
    );
  }
  async acceptVoice(actor: AccessContext, value: unknown) {
    await this.deps.assertAvailable(actor);
    if (!this.deps.admitVoiceRequest) throw new HttpError(503, "Voice admission unavailable");
    const bundle = validateVoiceRecordingBundle(value);
    const result = await this.acceptBundle(actor, bundle, bundle.voice);
    return { created: result.created, ...voiceRecordingImportStatus(result.row) };
  }
  async voiceStatus(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    const row = await this.deps.dataContext.withDataContext(actor, (db) =>
      this.imports.get(db, id)
    );
    return row && !row.meeting_id ? voiceRecordingImportStatus(row) : null;
  }
  async retryVoice(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      const row = await this.imports.get(db, id, true);
      if (!row || row.meeting_id) return null;
      if (row.state !== "failed" || !row.ready) return voiceRecordingImportStatus(row);
      await this.imports.retryVoice(db, id);
      await this.deps.schedule(db, {
        actorUserId: actor.actorUserId,
        resourceId: id,
        kind: "transcribe",
        ...(row.source_manifest_json ? { windowStartMs: row.next_window_ms } : {})
      });
      return voiceRecordingImportStatus({
        ...row,
        state: "queued",
        attempts: 0,
        code: null,
        retryable: false
      });
    });
  }
  private async acceptBundle(
    actor: AccessContext,
    bundle: RecordingBundle,
    voice?: { enablementId: string; capturedAt: string | null }
  ) {
    // The durable reservation schedules abandoned-write cleanup BEFORE any vault publication.
    const reservation = await this.deps.dataContext.withDataContext(actor, async (db) => {
      const existing = await this.imports.lockIdentity(
        db,
        bundle.manifest.sourceDeviceId,
        bundle.manifest.recordingId
      );
      if (existing) {
        if (existing.fingerprint !== bundle.fingerprint) throw new RecordingImportConflictError();
        return { row: existing, created: false };
      }
      if (!voice && bundle.mode === "voice-request")
        throw new RecordingVoiceIneligibleError(
          "Hold recordings go to Main chat and never become meetings"
        );
      const id = randomUUID();
      const policy = voice
        ? await new RecordingVoiceEnablementRepository().admit(db, {
            ...voice,
            sourceDeviceId: bundle.manifest.sourceDeviceId,
            recordingId: bundle.manifest.recordingId,
            startMs: bundle.startMs,
            endMs: bundle.endMs
          })
        : undefined;
      const meeting = policy
        ? null
        : (
            await this.records.create(db, {
              requestKey: id,
              title:
                bundle.mode === "voice-request" ? "Imported voice request" : "Imported recording"
            })
          ).meeting;
      const row = await this.imports.insert(db, id, meeting?.id ?? null, bundle, policy);
      await this.deps.schedule(
        db,
        { actorUserId: actor.actorUserId, resourceId: id, kind: "abandoned" },
        300
      );
      return { row, created: true };
    });
    const row = await this.deps.dataContext.withDataContext(actor, async (db) => {
      const current = await this.imports.get(db, reservation.row.id, true);
      if (!current) throw new Error("Recording import removed");
      if (current.ready || current.state === "failed") return current;
      await this.deps.vault.withVaultContext(actor, async (ctx) => {
        const path = recordingBundlePath(current.id);
        const created = await createVaultFile(ctx, path, bundle.canonical);
        if (created === "exists" && (await readVaultFile(ctx, path)) !== bundle.canonical)
          throw new RecordingImportConflictError();
      });
      await this.imports.ready(db, current.id);
      await this.deps.schedule(db, {
        actorUserId: actor.actorUserId,
        resourceId: current.id,
        kind: "transcribe"
      });
      return { ...current, ready: true };
    });
    return { created: reservation.created, row };
  }
  async status(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    const row = await this.deps.dataContext.withDataContext(actor, (db) =>
      this.imports.get(db, id)
    );
    return row?.meeting_id ? recordingImportStatus(row) : null;
  }
  async beforeRemove(db: DataContextDb, actor: AccessContext, meetingId: string) {
    for (const row of await this.imports.forMeeting(db, meetingId)) {
      await this.deps.schedule(db, {
        actorUserId: actor.actorUserId,
        resourceId: row.id,
        kind: "purge"
      });
    }
  }
  async process(actor: AccessContext, payload: RecordingImportPayload) {
    if (payload.kind !== "transcribe") {
      await this.deps.dataContext.withDataContext(actor, async (db) => {
        const row = await this.imports.get(db, payload.resourceId, true);
        if (payload.kind === "purge" ? !!row : row?.ready) return;
        if (
          row?.source_manifest_json &&
          row.upload_expires_at &&
          row.upload_expires_at.getTime() > Date.now()
        ) {
          await this.deps.schedule(
            db,
            payload,
            Math.ceil((row.upload_expires_at.getTime() - Date.now()) / 1000)
          );
          return;
        }
        await this.deps.vault.withVaultContext(actor, (ctx) =>
          deleteVaultDir(ctx, `meeting-recordings/${payload.resourceId}`)
        );
        if (row?.source_manifest_json)
          await new RecordingUploadRepository().clearExpired(db, row.id);
        if (row) await this.imports.finish(db, row.id, "failed", "import_interrupted");
      });
      return;
    }
    const source = await this.deps.dataContext.withDataContext(actor, (db) =>
      this.imports.get(db, payload.resourceId)
    );
    if (source?.source_manifest_json)
      return new RecordingWindowService(this.deps).process(actor, payload);
    const attemptId = randomUUID();
    const row = await this.deps.dataContext.withDataContext(actor, async (db) => {
      const current = await this.imports.get(db, payload.resourceId, true);
      if (!current || !current.ready || current.state === "complete" || current.state === "failed")
        return null;
      if (current.attempts >= 3) {
        await this.imports.finish(db, current.id, "failed", "transcription_failed");
        return null;
      }
      return this.imports.claim(db, current.id, attemptId);
    });
    if (!row) return;
    let retry = false;
    try {
      await this.deps.assertAvailable(actor);
      const selected = await this.deps.availability(actor);
      if (!selected.ready || !selected.modelRoute) {
        await this.deps.dataContext.withDataContext(actor, async (db) => {
          const current = await this.imports.get(db, row.id, true);
          if (current?.attempt_id === attemptId && current.state === "transcribing")
            await this.imports.finish(
              db,
              row.id,
              "failed",
              "transcription_unavailable",
              !row.meeting_id
            );
        });
        return;
      }
      const bundle = await this.deps.vault.withVaultContext(actor, async (ctx) => {
        const retained: unknown = JSON.parse(await readVaultFile(ctx, recordingBundlePath(row.id)));
        return row.meeting_id
          ? validateRecordingBundle(retained)
          : validateVoiceRecordingBundle(retained);
      });
      if (bundle.fingerprint !== row.fingerprint) throw new Error("Retained recording mismatch");
      const transcriptionOptions = row.meeting_id
        ? await this.deps.dataContext.withDataContext(actor, (db) =>
            new MeetingPreferencesRepository().getTranscriptionOptions(db)
          )
        : {};
      const result = await this.deps.transcribe(actor, {
        ...transcriptionOptions,
        audio: Buffer.from(bundle.manifest.wav.base64, "base64"),
        signal: AbortSignal.timeout(35_000),
        expectedModelRoute: selected.modelRoute,
        dispatch: async (send, validate) => {
          const dispatched = await this.deps.dataContext.withDataContext(actor, async (db) => {
            // Match deletion/transcript lock ordering. Authorization is checked at actual fetch initiation.
            if (
              row.meeting_id &&
              !(await this.records.get(db, row.meeting_id, { forUpdate: true }))
            )
              throw new Error("Recording removed");
            const current = await this.imports.get(db, row.id, true);
            if (current?.attempt_id !== attemptId || current.state !== "transcribing")
              throw new Error("Import attempt superseded");
            await this.deps.assertAvailable(actor);
            await validate?.(db);
            const request = send();
            // Observe early rejection while admission commits; the caller still receives it below.
            void request.catch(() => undefined);
            return { request };
          });
          return dispatched.request;
        }
      });
      if (
        result.segments.length > 500 ||
        result.segments.some(
          (segment) =>
            !Number.isInteger(segment.startMs) ||
            !Number.isInteger(segment.endMs) ||
            segment.startMs < 0 ||
            segment.endMs <= segment.startMs ||
            segment.endMs > bundle.durationMs ||
            typeof segment.text !== "string" ||
            segment.text.length > 100_000
        )
      )
        throw new Error("Invalid imported transcript");
      await this.deps.dataContext.withDataContext(actor, async (db) => {
        if (row.meeting_id && !(await this.records.get(db, row.meeting_id, { forUpdate: true })))
          return;
        const current = await this.imports.get(db, row.id, true);
        if (current?.attempt_id !== attemptId || current.state !== "transcribing") return;
        await this.deps.assertAvailable(actor);
        if (!row.meeting_id) {
          if (!this.deps.admitVoiceRequest) throw new HttpError(503, "Voice admission unavailable");
          const receipt = await this.deps.admitVoiceRequest(db, {
            version: 2,
            intent: "voice-request",
            sourceDeviceId: bundle.manifest.sourceDeviceId,
            recordingId: bundle.manifest.recordingId,
            sourceFingerprint: row.fingerprint,
            transcriptRevision: 1,
            transcript: result.segments.map((segment) => segment.text).join("\n"),
            capturedAt: row.voice_captured_at?.toISOString() ?? null,
            automatic: row.voice_automatic
          });
          await this.imports.completeVoice(db, row.id, receipt.id);
          return;
        }
        const meetingId = row.meeting_id;
        const transcript = new MeetingTranscriptRepository();
        const events = result.segments.map((segment, i) => ({
          cursor: i + 1,
          segment: {
            ...segment,
            meetingId,
            segmentId: `${row.id}:${i}`,
            sourceId: row.id,
            epoch: 1,
            revision: 1,
            finality: "final" as const,
            provenance: "transcription" as const,
            speakerId: null
          }
        }));
        for (let offset = 0; offset < Math.max(events.length, 1); offset += 100) {
          const saved = await transcript.ingest(db, {
            meetingId,
            requestKey: randomUUID(),
            expectedVersion: offset / 100,
            sources: [
              {
                sourceId: row.id,
                epoch: 1,
                kind: "recording",
                label:
                  bundle.mode === "voice-request" ? "Imported voice request" : "Imported recording",
                startMs: 0,
                endMs: bundle.durationMs
              }
            ],
            events: events.slice(offset, offset + 100),
            stopCutoffMs: bundle.durationMs
          });
          if (saved.status !== "saved") throw new Error("Imported transcript commit conflict");
        }
        await this.imports.finish(db, row.id, "complete", null);
        await this.deps.scheduleSummary(db, actor, { meetingId, importId: row.id });
      });
    } catch (error) {
      const failure = this.deps.describeFailure(error);
      retry = failure.retryable && row.attempts < 3;
      await this.deps.dataContext.withDataContext(actor, async (db) => {
        const current = await this.imports.get(db, row.id, true);
        if (current?.attempt_id !== attemptId || current.state !== "transcribing") {
          retry = false;
          return;
        }
        await this.imports.finish(
          db,
          row.id,
          retry ? "queued" : "failed",
          failure.unavailable ? "import_unavailable" : "transcription_failed",
          retry || (!row.meeting_id && row.ready)
        );
      });
    }
    // pg-boss retry/expiry recovers process interruption; committed transcript + completion are atomic.
    if (retry) throw new Error("Recording transcription retry pending");
  }
}
