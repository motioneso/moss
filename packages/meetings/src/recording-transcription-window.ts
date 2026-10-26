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
export function normalizeWindowTranscript(
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
        segment.startMs >= durationMs ||
        segment.endMs <= segment.startMs ||
        // ASR timestamps are estimates; only bound small trailing end drift.
        segment.endMs > durationMs + 500 ||
        typeof segment.text !== "string"
    )
  )
    throw new Error("Invalid recording window transcript");
  return segments.map((segment) => ({ ...segment, endMs: Math.min(segment.endMs, durationMs) }));
}

type WindowSegment = { startMs: number; endMs: number; text: string };
// <25% coverage or <0.5 words/s catches early stops (including stretched timestamps);
// -35 dBFS RMS excludes quiet PCM without altering noisy source audio.
const THIN_COVERAGE_RATIO = 0.25;
const THIN_WORDS_PER_SECOND = 0.5;
const AUDIBLE_RMS_DBFS = -35;
const RETRY_HALF_MS = 15_000;

function wordCount(segments: readonly WindowSegment[]) {
  return segments.reduce(
    (count, segment) => count + (segment.text.trim().match(/\S+/gu)?.length ?? 0),
    0
  );
}

function coveredMs(segments: readonly WindowSegment[]) {
  let end = 0,
    covered = 0;
  const speech = segments
    .filter((segment) => segment.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  for (const segment of speech) {
    covered += Math.max(0, segment.endMs - Math.max(end, segment.startMs));
    end = Math.max(end, segment.endMs);
  }
  return covered;
}

function audiblePcm(audio: Buffer) {
  let squares = 0;
  for (let offset = 44; offset < audio.length; offset += 2) {
    const sample = audio.readInt16LE(offset) / 32768;
    squares += sample * sample;
  }
  return squares / ((audio.length - 44) / 2) >= 10 ** (AUDIBLE_RMS_DBFS / 10);
}

function sliceWindowAudio(audio: Buffer, startMs: number, endMs: number) {
  const part = Buffer.alloc(44 + (endMs - startMs) * 32);
  part.set(audio.subarray(0, 44));
  part.set(audio.subarray(44 + startMs * 32, 44 + endMs * 32), 44);
  part.writeUInt32LE(part.length - 8, 4);
  part.writeUInt32LE(part.length - 44, 40);
  return part;
}

/** One split retry within the existing checkpoint; every request uses the caller's admission guard. */
export async function transcribeWindowWithRetry(
  audio: Buffer,
  durationMs: number,
  transcribe: (audio: Buffer) => Promise<{ segments: readonly WindowSegment[] }>
) {
  const original = normalizeWindowTranscript((await transcribe(audio)).segments, durationMs);
  const originalWords = wordCount(original);
  if (
    durationMs < 2 ||
    (coveredMs(original) >= durationMs * THIN_COVERAGE_RATIO &&
      originalWords >= (durationMs / 1000) * THIN_WORDS_PER_SECOND) ||
    !audiblePcm(audio)
  )
    return original;

  const splitMs = Math.min(RETRY_HALF_MS, Math.floor(durationMs / 2));
  const first = normalizeWindowTranscript(
    (await transcribe(sliceWindowAudio(audio, 0, splitMs))).segments,
    splitMs
  );
  const second = normalizeWindowTranscript(
    (await transcribe(sliceWindowAudio(audio, splitMs, durationMs))).segments,
    durationMs - splitMs
  );
  const retry = normalizeWindowTranscript(
    [
      ...first,
      ...second.map((segment) => ({
        ...segment,
        startMs: splitMs + segment.startMs,
        endMs: splitMs + segment.endMs
      }))
    ],
    durationMs
  );
  return wordCount(retry) > originalWords ? retry : original;
}
