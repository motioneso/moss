import { randomUUID } from "node:crypto";
import type { AccessContext, DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { readVaultFile } from "@moss/vault";
import type {
  RecordingImportDependencies,
  RecordingImportPayload
} from "./recording-import-service.js";
import {
  RecordingImportRepository,
  type RecordingImportRow
} from "./recording-import-repository.js";
import { RecordingUploadRepository } from "./recording-upload-repository.js";
import { parseRecordingUpload } from "./recording-upload-manifest.js";
import {
  readRecordingWindow,
  normalizeWindowTranscript
} from "./recording-transcription-window.js";
import { MeetingRecordsRepository } from "./repository.js";
import { MeetingTranscriptRepository } from "./transcript-repository.js";
import { MeetingPreferencesRepository } from "./preferences.js";

/** One non-overlapping window per metadata-only job; commit + next job are atomic. */
export class RecordingWindowService {
  private readonly imports = new RecordingImportRepository();
  private readonly uploads = new RecordingUploadRepository();
  private readonly records = new MeetingRecordsRepository();
  constructor(private readonly deps: RecordingImportDependencies) {}
  private async current(db: DataContextDb, row: RecordingImportRow, attemptId: string) {
    // The same meeting-before-import order as deletion, user edits and provider dispatch.
    if (row.meeting_id && !(await this.records.get(db, row.meeting_id, { forUpdate: true })))
      return null;
    const current = await this.imports.get(db, row.id, true);
    return current?.state === "transcribing" &&
      current.attempt_id === attemptId &&
      current.next_window_ms === row.next_window_ms
      ? current
      : null;
  }
  async process(actor: AccessContext, payload: RecordingImportPayload) {
    const attemptId = randomUUID();
    const row = await this.deps.dataContext.withDataContext(actor, async (db) => {
      const row = await this.imports.get(db, payload.resourceId, true);
      if (
        !row?.source_manifest_json ||
        !row.ready ||
        row.state === "complete" ||
        row.state === "failed" ||
        (payload.windowStartMs ?? 0) !== row.next_window_ms
      )
        return null;
      if (row.attempts >= 3) {
        await this.imports.finish(db, row.id, "failed", "transcription_failed");
        return null;
      }
      return this.imports.claim(db, row.id, attemptId);
    });
    if (!row) return;
    try {
      await this.deps.assertAvailable(actor);
      const selected = await this.deps.availability(actor);
      if (!selected.ready || !selected.modelRoute)
        throw new HttpError(503, "Transcription unavailable");
      const input = parseRecordingUpload(JSON.parse(row.source_manifest_json!));
      if (input.fingerprint !== row.fingerprint)
        throw new Error("Retained recording manifest changed");
      const chunks = await this.deps.dataContext.withDataContext(actor, (db) =>
        this.uploads.chunks(db, row.id)
      );
      const window = await this.deps.vault.withVaultContext(actor, async (ctx) => {
        if (
          (await readVaultFile(ctx, `meeting-recordings/${row.id}/source.json`)) !== input.canonical
        )
          throw new Error("Retained recording manifest changed");
        return readRecordingWindow(ctx, row.id, input.manifest, chunks, row.next_window_ms);
      });
      const language = row.meeting_id
        ? await this.deps.dataContext.withDataContext(actor, (db) =>
            new MeetingPreferencesRepository().getTranscriptLanguage(db)
          )
        : null;
      const result = await this.deps.transcribe(actor, {
        ...(language ? { language } : {}),
        audio: window.audio,
        signal: AbortSignal.timeout(35_000),
        expectedModelRoute: selected.modelRoute,
        dispatch: async (send, validate) => {
          const dispatch = await this.deps.dataContext.withDataContext(actor, async (db) => {
            if (!(await this.current(db, row, attemptId)))
              throw new Error("Recording attempt superseded");
            await this.deps.assertAvailable(actor);
            await validate?.(db);
            return { request: send() };
          });
          return dispatch.request;
        }
      });
      const segments = normalizeWindowTranscript(result.segments, window.endMs - window.startMs);
      await this.deps.dataContext.withDataContext(actor, async (db) => {
        if (!(await this.current(db, row, attemptId))) return;
        await this.deps.assertAvailable(actor);
        if (!row.meeting_id) {
          const text = [row.voice_transcript, ...segments.map((segment) => segment.text)]
            .filter(Boolean)
            .join("\n");
          await this.uploads.voiceTranscript(db, row.id, text);
          await this.uploads.checkpoint(db, row.id, window.endMs, 0, 0);
          if (window.endMs === window.durationMs) {
            if (!this.deps.admitVoiceRequest)
              throw new HttpError(503, "Voice admission unavailable");
            const receipt = await this.deps.admitVoiceRequest(db, {
              version: 2,
              intent: "voice-request",
              sourceDeviceId: input.manifest.sourceDeviceId,
              recordingId: input.manifest.recordingId,
              sourceFingerprint: row.fingerprint,
              transcriptRevision: 1,
              transcript: text,
              capturedAt: row.voice_captured_at?.toISOString() ?? null,
              automatic: row.voice_automatic
            });
            await this.imports.completeVoice(db, row.id, receipt.id);
          } else await this.deps.schedule(db, { ...payload, windowStartMs: window.endMs });
          return;
        }
        const transcript = new MeetingTranscriptRepository();
        const state = await transcript.approvalSnapshot(db, row.meeting_id);
        if (!state) return;
        let version = state.receipt.version,
          cursor = state.receipt.cursor;
        const events = segments.map((segment, i) => ({
          cursor: ++cursor,
          segment: {
            ...segment,
            startMs: window.startMs + segment.startMs,
            endMs: window.startMs + segment.endMs,
            meetingId: row.meeting_id!,
            segmentId: `${row.id}:${window.startMs}:${i}`,
            sourceId: row.id,
            epoch: 1,
            revision: 1,
            finality: "final" as const,
            provenance: "transcription" as const,
            speakerId: null
          }
        }));
        const source = {
          sourceId: row.id,
          epoch: 1,
          kind: "recording" as const,
          label: input.mode === "voice-request" ? "Imported voice request" : "Imported recording",
          startMs: 0,
          endMs: window.durationMs
        };
        const sources = [...(state.ledger?.sources ?? [])];
        if (!sources.some((existing) => existing.sourceId === row.id)) sources.push(source);
        const saved = await transcript.ingest(db, {
          meetingId: row.meeting_id,
          requestKey: randomUUID(),
          expectedVersion: version,
          sources,
          events,
          stopCutoffMs: window.durationMs
        });
        if (saved.status !== "saved") throw new Error("Recording transcript checkpoint conflict");
        version = saved.receipt.version;
        await this.uploads.checkpoint(db, row.id, window.endMs, version, saved.receipt.cursor);
        if (window.endMs === window.durationMs) {
          await this.imports.finish(db, row.id, "complete", null);
          await this.deps.scheduleSummary(db, actor, {
            meetingId: row.meeting_id,
            importId: row.id
          });
        } else await this.deps.schedule(db, { ...payload, windowStartMs: window.endMs });
      });
    } catch (error) {
      const failure = this.deps.describeFailure(error);
      const retry = await this.deps.dataContext.withDataContext(actor, async (db) => {
        if (!(await this.current(db, row, attemptId))) return false;
        const retry = failure.retryable && row.attempts < 3;
        await this.imports.finish(
          db,
          row.id,
          retry ? "queued" : "failed",
          failure.unavailable ? "transcription_unavailable" : "transcription_failed",
          retry || !row.meeting_id
        );
        return retry;
      });
      if (retry) throw new Error("Recording window retry pending", { cause: error });
    }
  }
}
