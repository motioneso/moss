import {
  createVaultFile,
  getVaultAvailableBytes,
  readVaultFile,
  readVaultFileRange,
  reserveVaultFileBytes,
  type VaultContext
} from "@moss/vault";
import { HttpError } from "@moss/module-sdk";
import type { MeetingRecordingUploadManifest } from "@moss/shared";
import { RecordingImportConflictError } from "./recording-import-repository.js";
import {
  RECORDING_SOURCE_LIMITS,
  type RecordingSourceKind
} from "./recording-source-validation.js";
import {
  recordingChunkLength,
  recordingChunkPath,
  recordingHash,
  recordingSourceKinds
} from "./recording-upload-manifest.js";
import type { RecordingChunkRow } from "./recording-upload-repository.js";

const freeReserve = 100n * 1024n * 1024n;
/** Called only while holding the durable import row lock. Never sparse-reserve. */
export async function reserveRecordingStorage(
  ctx: VaultContext,
  id: string,
  canonical: string,
  manifest: MeetingRecordingUploadManifest
) {
  const path = `meeting-recordings/${id}/source.json`;
  if (
    (await createVaultFile(ctx, path, canonical)) === "exists" &&
    (await readVaultFile(ctx, path)) !== canonical
  )
    throw new RecordingImportConflictError();
  try {
    for (const kind of recordingSourceKinds) {
      const count = Math.ceil(manifest[kind].byteLength / RECORDING_SOURCE_LIMITS.chunk);
      for (let index = 0; index < count; index++) {
        const length = recordingChunkLength(manifest, kind, index);
        if ((await getVaultAvailableBytes(ctx)) < freeReserve + BigInt(length))
          throw new HttpError(507, "Recording storage unavailable");
        await reserveVaultFileBytes(ctx, recordingChunkPath(id, kind, index), length);
      }
    }
    if ((await getVaultAvailableBytes(ctx)) < freeReserve)
      throw new HttpError(507, "Recording storage unavailable");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOSPC" || error.code === "EDQUOT")
    )
      throw new HttpError(507, "Recording storage unavailable");
    throw error;
  }
}
export async function readRecordingChunk(ctx: VaultContext, id: string, chunk: RecordingChunkRow) {
  const bytes = await readVaultFileRange(
    ctx,
    recordingChunkPath(id, chunk.kind, chunk.chunk_index),
    0,
    chunk.byte_length,
    chunk.byte_length
  );
  if (recordingHash(bytes) !== chunk.sha256) throw new Error("Retained recording chunk changed");
  return bytes;
}
export function recordingSourceReader(
  ctx: VaultContext,
  id: string,
  chunks: readonly RecordingChunkRow[]
) {
  return async function* (kind: RecordingSourceKind) {
    for (const chunk of chunks.filter((chunk) => chunk.kind === kind))
      yield await readRecordingChunk(ctx, id, chunk);
  };
}
