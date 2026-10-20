import { randomUUID } from "node:crypto";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import {
  createVaultFile,
  deleteVaultDir,
  readVaultFile,
  type VaultContextRunner
} from "@moss/vault";
import { validateRecordingBundle } from "./recording-bundle.js";
import {
  RecordingImportConflictError,
  RecordingImportRepository,
  recordingImportStatus
} from "./recording-import-repository.js";
import { MeetingRecordsRepository } from "./repository.js";
import { MeetingTranscriptRepository } from "./transcript-repository.js";

export interface RecordingImportPayload {
  actorUserId: string;
  resourceId: string;
  kind: "transcribe" | "abandoned" | "purge";
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
  availability(actor: AccessContext): Promise<{ ready: boolean; modelRoute: string | null }>;
  transcribe(
    actor: AccessContext,
    input: {
      audio: Uint8Array;
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
  constructor(private readonly deps: RecordingImportDependencies) {}
  async accept(actor: AccessContext, value: unknown) {
    await this.deps.assertAvailable(actor);
    const bundle = validateRecordingBundle(value);
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
      const id = randomUUID();
      const { meeting } = await this.records.create(db, {
        requestKey: id,
        title: bundle.mode === "voice-request" ? "Imported voice request" : "Imported recording"
      });
      const row = await this.imports.insert(db, id, meeting.id, bundle);
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
    return { created: reservation.created, ...recordingImportStatus(row) };
  }
  async status(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    const row = await this.deps.dataContext.withDataContext(actor, (db) =>
      this.imports.get(db, id)
    );
    return row ? recordingImportStatus(row) : null;
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
        await this.deps.vault.withVaultContext(actor, (ctx) =>
          deleteVaultDir(ctx, `meeting-recordings/${payload.resourceId}`)
        );
        if (row) await this.imports.finish(db, row.id, "failed", "import_interrupted");
      });
      return;
    }
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
            await this.imports.finish(db, row.id, "failed", "transcription_unavailable");
        });
        return;
      }
      const bundle = await this.deps.vault.withVaultContext(actor, async (ctx) =>
        validateRecordingBundle(JSON.parse(await readVaultFile(ctx, recordingBundlePath(row.id))))
      );
      if (bundle.fingerprint !== row.fingerprint) throw new Error("Retained recording mismatch");
      const result = await this.deps.transcribe(actor, {
        audio: Buffer.from(bundle.manifest.wav.base64, "base64"),
        signal: AbortSignal.timeout(35_000),
        expectedModelRoute: selected.modelRoute,
        dispatch: async (send, validate) => {
          const dispatched = await this.deps.dataContext.withDataContext(actor, async (db) => {
            // Match deletion/transcript lock ordering. Authorization is checked at actual fetch initiation.
            if (!(await this.records.get(db, row.meeting_id, { forUpdate: true })))
              throw new Error("Recording removed");
            const current = await this.imports.get(db, row.id, true);
            if (current?.attempt_id !== attemptId || current.state !== "transcribing")
              throw new Error("Import attempt superseded");
            await this.deps.assertAvailable(actor);
            await validate?.(db);
            return { request: send() };
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
        if (!(await this.records.get(db, row.meeting_id, { forUpdate: true }))) return;
        const current = await this.imports.get(db, row.id, true);
        if (current?.attempt_id !== attemptId || current.state !== "transcribing") return;
        await this.deps.assertAvailable(actor);
        const transcript = new MeetingTranscriptRepository();
        const events = result.segments.map((segment, i) => ({
          cursor: i + 1,
          segment: {
            ...segment,
            meetingId: row.meeting_id,
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
            meetingId: row.meeting_id,
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
          retry
        );
      });
    }
    // pg-boss retry/expiry recovers process interruption; committed transcript + completion are atomic.
    if (retry) throw new Error("Recording transcription retry pending");
  }
}
