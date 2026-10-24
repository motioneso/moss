import { TranscriptionTransportError } from "../transcription-errors.js";

/** Clip-relative ASR timestamps. Source labels and diarization are separate capabilities. */
export interface TranscriptionSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface TranscribeAudioInput {
  readonly model: { readonly provider_model_id: string };
  readonly audio: Blob;
  readonly signal?: AbortSignal;
  readonly timestamps?: "segment";
  /** Standard ASR input-language hint. Omit for automatic detection. */
  readonly language?: string;
  readonly prompt?: string;
  /** Activity attribution; never sent as provider request content. */
  readonly ownerUserId?: string;
  readonly actionCode?: "transcribe.voice_note" | "transcribe.meeting";
  readonly turnId?: string;
  readonly parentId?: string;
}

export interface TranscribeAudioResult {
  readonly text: string;
  readonly segments?: readonly TranscriptionSegment[];
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENTS = 10000;
const MAX_TEXT_LENGTH = 1024 * 1024;
// Real ASR segment boundaries can overlap by one 20 ms acoustic frame.
const MAX_ADJACENT_OVERLAP_MS = 20;

function invalidResponse(): Error {
  return new TranscriptionTransportError("provider-response-invalid", "validation");
}

/** Discard a late response even when an injected transport ignored its abort signal. */
export function rejectAbortedTranscription(response: Response, signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  void response.body?.cancel().catch(() => undefined);
  signal.throwIfAborted();
}

/** Bound provider response allocation before parsing untrusted verbose JSON. */
export async function readTimestampedTranscription(
  response: Response,
  signal?: AbortSignal
): Promise<TranscribeAudioResult> {
  rejectAbortedTranscription(response, signal);
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw invalidResponse();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    if (error instanceof TranscriptionTransportError) throw error;
    // A connection may fail after headers arrived. Keep it retryable without the
    // transport exception, which may quote a destination, credentials or payload.
    throw new TranscriptionTransportError("provider-network", "response");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // JSON parser errors may quote private provider payloads. Never propagate those errors.
    throw invalidResponse();
  }
  if (!json || typeof json !== "object" || !("text" in json)) throw invalidResponse();
  if (typeof json.text !== "string" || json.text.length > MAX_TEXT_LENGTH) throw invalidResponse();
  if (
    !("segments" in json) ||
    !Array.isArray(json.segments) ||
    json.segments.length > MAX_SEGMENTS
  ) {
    throw invalidResponse();
  }
  const segments: TranscriptionSegment[] = [];
  let previousEnd = 0;
  let textLength = 0;
  for (const segment of json.segments as unknown[]) {
    if (!segment || typeof segment !== "object") throw invalidResponse();
    if (!("start" in segment) || !("end" in segment) || !("text" in segment))
      throw invalidResponse();
    const { start, end, text } = segment;
    if (
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      start < 0 ||
      typeof end !== "number" ||
      !Number.isFinite(end) ||
      end < start ||
      end > Number.MAX_SAFE_INTEGER / 1000 ||
      typeof text !== "string"
    )
      throw invalidResponse();
    textLength += text.length;
    if (textLength > MAX_TEXT_LENGTH) throw invalidResponse();
    // Some ASR engines emit empty point markers, including inside the last speech
    // segment. They carry no transcript or duration and must not trim that speech.
    if (end === start && !text.trim()) continue;
    if (
      Math.round(previousEnd * 1000) - Math.round(start * 1000) > MAX_ADJACENT_OVERLAP_MS ||
      Math.round(end * 1000) <= Math.round(start * 1000)
    )
      throw invalidResponse();
    const previous = segments.at(-1);
    if (previous && start < previousEnd) {
      // Keep a short final segment intact; moving its start can erase its duration.
      if (Math.round(start * 1000) <= Math.round(previous.start * 1000)) throw invalidResponse();
      segments[segments.length - 1] = { ...previous, end: start };
    }
    segments.push({ start, end, text });
    previousEnd = end;
  }
  if (json.text.trim() && segments.length === 0) throw invalidResponse();
  signal?.throwIfAborted();
  return { text: json.text, segments };
}
