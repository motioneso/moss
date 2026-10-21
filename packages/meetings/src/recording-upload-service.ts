import { randomUUID } from "node:crypto";
import type { AccessContext, DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { publishReservedVaultFileBytes, readVaultFileRange } from "@moss/vault";
import type { MeetingRecordingUploadProgress } from "@moss/shared";
import type { RecordingImportDependencies } from "./recording-import-service.js";
import {
  RecordingImportRepository,
  RecordingImportConflictError,
  type RecordingImportRow
} from "./recording-import-repository.js";
import { RecordingUploadRepository } from "./recording-upload-repository.js";
import {
  parseRecordingUpload,
  recordingChunkLength,
  recordingChunkPath,
  recordingHash,
  recordingSourceKinds
} from "./recording-upload-manifest.js";
import { reserveRecordingStorage, recordingSourceReader } from "./recording-upload-storage.js";
import {
  validateRecordingSource,
  RECORDING_SOURCE_LIMITS,
  type RecordingSourceKind
} from "./recording-source-validation.js";
import { RecordingVoiceEnablementRepository } from "./recording-voice-enablement.js";
import { MeetingRecordsRepository } from "./repository.js";

export class RecordingUploadService {
  private readonly imports = new RecordingImportRepository();
  private readonly uploads = new RecordingUploadRepository();
  constructor(private readonly deps: RecordingImportDependencies) {}
  async reserve(actor: AccessContext, value: unknown) {
    await this.deps.assertAvailable(actor);
    const input = parseRecordingUpload(value);
    if (input.manifest.destination.intent === "voice-request" && !this.deps.admitVoiceRequest)
      throw new HttpError(503, "Voice admission unavailable");
    const id = await this.deps.dataContext.withDataContext(actor, async (db) => {
      const prior = await this.imports.lockIdentity(
        db,
        input.manifest.sourceDeviceId,
        input.manifest.recordingId
      );
      if (prior) {
        if (
          prior.fingerprint !== input.fingerprint ||
          prior.source_manifest_json !== input.canonical
        )
          throw new RecordingImportConflictError();
        return prior.id;
      }
      const id = randomUUID();
      const destination = input.manifest.destination;
      if (destination.intent === "voice-request") {
        await new RecordingVoiceEnablementRepository().admit(db, {
          ...destination,
          sourceDeviceId: input.manifest.sourceDeviceId,
          recordingId: input.manifest.recordingId,
          capturedAt: null,
          startMs: 0,
          endMs: 0
        });
      }
      const meeting =
        destination.intent === "meeting"
          ? (
              await new MeetingRecordsRepository().create(db, {
                requestKey: id,
                title: "Imported recording"
              })
            ).meeting
          : null;
      await this.uploads.insert(db, id, meeting?.id ?? null, input);
      await this.deps.schedule(
        db,
        { actorUserId: actor.actorUserId, resourceId: id, kind: "abandoned" },
        86400
      );
      return id;
    });
    // Identity + expiry cleanup are committed before the first filesystem operation.
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      const row = await this.row(db, id);
      if (!row.ready) this.active(row);
      if (!row.ready && !row.upload_reserved) {
        await this.deps.vault.withVaultContext(actor, (ctx) =>
          reserveRecordingStorage(ctx, id, input.canonical, input.manifest)
        );
        await this.uploads.reserved(db, id);
        row.upload_reserved = true;
      }
      return this.progress(db, row);
    });
  }
  private async row(db: DataContextDb, id: string) {
    const row = await this.imports.get(db, id, true);
    if (!row?.source_manifest_json) throw new HttpError(404, "Recording upload not found");
    return row;
  }
  private active(row: RecordingImportRow) {
    if (
      row.state === "failed" ||
      !row.upload_expires_at ||
      row.upload_expires_at.getTime() <= Date.now()
    )
      throw new HttpError(410, "Recording upload expired");
  }
  private async progress(
    db: DataContextDb,
    row: RecordingImportRow
  ): Promise<MeetingRecordingUploadProgress> {
    const received: Record<RecordingSourceKind, number[]> = { packets: [], sidecar: [], wav: [] };
    for (const chunk of await this.uploads.chunks(db, row.id))
      received[chunk.kind].push(chunk.chunk_index);
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      chunkBytes: RECORDING_SOURCE_LIMITS.chunk,
      expiresAt: row.upload_expires_at!.toISOString(),
      reserved: row.upload_reserved,
      ready: row.ready,
      expired:
        !row.ready && (row.state === "failed" || row.upload_expires_at!.getTime() <= Date.now()),
      received
    };
  }
  async status(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    return this.deps.dataContext.withDataContext(actor, async (db) =>
      this.progress(db, await this.row(db, id))
    );
  }
  async put(
    actor: AccessContext,
    id: string,
    kind: RecordingSourceKind,
    index: number,
    bytes: Buffer
  ) {
    await this.deps.assertAvailable(actor);
    if (!recordingSourceKinds.includes(kind)) throw new HttpError(400, "Invalid recording file");
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      const row = await this.row(db, id);
      const input = parseRecordingUpload(JSON.parse(row.source_manifest_json!));
      const length = recordingChunkLength(input.manifest, kind, index);
      if (bytes.length !== length) throw new HttpError(400, "Invalid recording chunk length");
      const hash = recordingHash(bytes);
      const prior = (await this.uploads.chunks(db, id)).find(
        (c) => c.kind === kind && c.chunk_index === index
      );
      if (prior && (prior.sha256 !== hash || prior.byte_length !== length))
        throw new RecordingImportConflictError();
      if (!row.ready) this.active(row);
      if (!row.upload_reserved) throw new HttpError(409, "Recording storage not reserved");
      await this.deps.vault.withVaultContext(actor, async (ctx) => {
        const path = recordingChunkPath(id, kind, index);
        if (
          (await publishReservedVaultFileBytes(ctx, path, bytes)) === "exists" &&
          recordingHash(await readVaultFileRange(ctx, path, 0, length, length)) !== hash
        )
          throw new RecordingImportConflictError();
      });
      await this.uploads.acknowledge(db, id, kind, index, length, hash);
      return this.progress(db, row);
    });
  }
  async finalize(actor: AccessContext, id: string) {
    await this.deps.assertAvailable(actor);
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      const row = await this.row(db, id);
      if (row.ready) return this.progress(db, row);
      this.active(row);
      const input = parseRecordingUpload(JSON.parse(row.source_manifest_json!));
      const chunks = await this.uploads.chunks(db, id);
      for (const kind of recordingSourceKinds) {
        const selected = chunks.filter((c) => c.kind === kind);
        if (
          selected.length !==
            Math.ceil(input.manifest[kind].byteLength / RECORDING_SOURCE_LIMITS.chunk) ||
          selected.some(
            (c, i) =>
              c.chunk_index !== i || c.byte_length !== recordingChunkLength(input.manifest, kind, i)
          )
        )
          throw new HttpError(409, "Recording upload incomplete");
      }
      const metadata = await this.deps.vault.withVaultContext(actor, (ctx) =>
        validateRecordingSource(input.manifest, recordingSourceReader(ctx, id, chunks))
      );
      const destination = input.manifest.destination;
      const voice =
        destination.intent === "voice-request"
          ? await new RecordingVoiceEnablementRepository().admit(db, {
              ...destination,
              sourceDeviceId: input.manifest.sourceDeviceId,
              recordingId: input.manifest.recordingId,
              startMs: metadata.startMs,
              endMs: metadata.endMs
            })
          : undefined;
      await this.uploads.finalized(db, id, { ...metadata, mode: input.mode }, voice);
      await this.deps.schedule(db, {
        actorUserId: actor.actorUserId,
        resourceId: id,
        kind: "transcribe",
        windowStartMs: 0
      });
      return this.progress(db, { ...row, ready: true });
    });
  }
}
