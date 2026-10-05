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

function invalidResponse(): Error {
  return new Error("Invalid or unsupported timestamped transcription response");
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
    throw error;
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
  if (json.text.trim() && json.segments.length === 0) throw invalidResponse();
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
      start < previousEnd ||
      typeof end !== "number" ||
      !Number.isFinite(end) ||
      end <= start ||
      end > Number.MAX_SAFE_INTEGER / 1000 ||
      Math.round(end * 1000) <= Math.round(start * 1000) ||
      typeof text !== "string"
    )
      throw invalidResponse();
    textLength += text.length;
    if (textLength > MAX_TEXT_LENGTH) throw invalidResponse();
    segments.push({ start, end, text });
    previousEnd = end;
  }
  signal?.throwIfAborted();
  return { text: json.text, segments };
}
