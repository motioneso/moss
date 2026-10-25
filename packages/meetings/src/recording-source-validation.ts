import { createHash } from "node:crypto";
import {
  RecordingPacketValidator,
  recordingSidecarMetadata,
  recordingWavDuration
} from "./recording-audio-validation.js";
import { RecordingImportInputError } from "./recording-validation-error.js";

export const RECORDING_SOURCE_LIMITS = {
  packets: 32 * 1024 * 1024,
  sidecar: 256 * 1024,
  wav: 256 * 1024 * 1024,
  chunk: 1024 * 1024,
  durationMs: 7_200_000
} as const;

export type RecordingSourceKind = "packets" | "sidecar" | "wav";
export interface RecordingSourceFile {
  readonly byteLength: number;
  readonly sha256: string;
}
export type RecordingSourceFiles = Readonly<Record<RecordingSourceKind, RecordingSourceFile>>;
export type RecordingSourceReader = (kind: RecordingSourceKind) => AsyncIterable<Uint8Array>;

async function validateFile(
  source: AsyncIterable<Uint8Array>,
  expected: RecordingSourceFile,
  consume: (chunk: Uint8Array, offset: number) => void
): Promise<void> {
  const hash = createHash("sha256");
  let offset = 0;
  for await (const chunk of source) {
    if (chunk.byteLength > RECORDING_SOURCE_LIMITS.chunk) throw new RecordingImportInputError(413);
    if (offset + chunk.byteLength > expected.byteLength) throw new RecordingImportInputError();
    hash.update(chunk);
    consume(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== expected.byteLength || hash.digest("hex") !== expected.sha256) {
    throw new RecordingImportInputError();
  }
}

/**
 * Internal completion validator for the future resumable transport. Admission must
 * separately reserve immutable owner/source/destination identity before publishing
 * any bytes. This function does not accept uploads or change version-1 limits.
 */
export async function validateRecordingSource(
  files: RecordingSourceFiles,
  read: RecordingSourceReader
) {
  for (const kind of ["packets", "sidecar", "wav"] as const) {
    const file = files[kind];
    if (
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 1 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new RecordingImportInputError();
    }
    if (file.byteLength > RECORDING_SOURCE_LIMITS[kind]) throw new RecordingImportInputError(413);
  }

  const packets = new RecordingPacketValidator();
  await validateFile(read("packets"), files.packets, (chunk) => packets.push(chunk));
  const count = packets.finish();

  const header = Buffer.alloc(44);
  await validateFile(read("wav"), files.wav, (chunk, offset) => {
    if (offset < header.length) header.set(chunk.subarray(0, header.length - offset), offset);
  });
  const durationMs = recordingWavDuration(
    header,
    files.wav.byteLength,
    RECORDING_SOURCE_LIMITS.durationMs
  );

  // The sidecar alone is buffered, after its 256 KiB bound has been validated.
  const sidecar = Buffer.alloc(files.sidecar.byteLength);
  await validateFile(read("sidecar"), files.sidecar, (chunk, offset) => sidecar.set(chunk, offset));
  const metadata = recordingSidecarMetadata(sidecar, durationMs, {
    maxBytes: RECORDING_SOURCE_LIMITS.sidecar,
    maxEntries: RECORDING_SOURCE_LIMITS.sidecar
  });
  return { durationMs, packetCount: count, ...metadata };
}
