import type { VaultContext } from "@moss/vault";
import type { MeetingRecordingUploadManifest } from "@moss/shared";
import { RECORDING_SOURCE_LIMITS } from "./recording-source-validation.js";
import { recordingWavDuration } from "./recording-audio-validation.js";
import { readRecordingChunk } from "./recording-upload-storage.js";
import type { RecordingChunkRow } from "./recording-upload-repository.js";

export const RECORDING_WINDOW_MS = 30_000;
/** Hash-check every retained chunk used by a window, including the original header. */
export async function readRecordingWindow(
  ctx: VaultContext,
  id: string,
  manifest: MeetingRecordingUploadManifest,
  chunks: readonly RecordingChunkRow[],
  startMs: number
) {
  const wav = chunks.filter((chunk) => chunk.kind === "wav");
  const first = wav.find((chunk) => chunk.chunk_index === 0);
  if (!first) throw new Error("Missing recording header");
  const firstBytes = await readRecordingChunk(ctx, id, first);
  const header = firstBytes.subarray(0, 44);
  const durationMs = recordingWavDuration(
    header,
    manifest.wav.byteLength,
    RECORDING_SOURCE_LIMITS.durationMs
  );
  if (
    !Number.isSafeInteger(startMs) ||
    startMs < 0 ||
    startMs % RECORDING_WINDOW_MS ||
    startMs >= durationMs
  )
    throw new Error("Invalid recording window checkpoint");
  const endMs = Math.min(startMs + RECORDING_WINDOW_MS, durationMs);
  const audio = Buffer.alloc(44 + (endMs - startMs) * 32);
  audio.set(header);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.writeUInt32LE(audio.length - 44, 40);
  const start = 44 + startMs * 32,
    end = 44 + endMs * 32;
  let copied = 0;
  for (const chunk of wav) {
    const offset = chunk.chunk_index * RECORDING_SOURCE_LIMITS.chunk;
    const from = Math.max(start, offset),
      to = Math.min(end, offset + chunk.byte_length);
    if (from >= to) continue;
    const bytes = chunk.chunk_index === 0 ? firstBytes : await readRecordingChunk(ctx, id, chunk);
    audio.set(bytes.subarray(from - offset, to - offset), 44 + from - start);
    copied += to - from;
  }
  if (copied !== audio.length - 44) throw new Error("Incomplete recording window");
  return { audio, startMs, endMs, durationMs };
}
export function validateWindowTranscript(
  segments: readonly { startMs: number; endMs: number; text: string }[],
  durationMs: number
) {
  if (
    segments.length > 80 ||
    segments.reduce(
      (total, segment) => total + (typeof segment.text === "string" ? segment.text.length : 0),
      0
    ) > 5000 ||
    segments.some(
      (segment) =>
        !Number.isSafeInteger(segment.startMs) ||
        !Number.isSafeInteger(segment.endMs) ||
        segment.startMs < 0 ||
        segment.endMs <= segment.startMs ||
        segment.endMs > durationMs ||
        typeof segment.text !== "string"
    )
  )
    throw new Error("Invalid recording window transcript");
}
