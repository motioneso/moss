/** Safe transport facts only. Never retain provider text, request headers or a raw cause. */
export type TranscriptionFailureReason =
  | "configuration-unavailable"
  | "route-changed"
  | "cancelled"
  | "provider-timeout"
  | "provider-rate-limited"
  | "provider-authentication"
  | "provider-unavailable"
  | "provider-network"
  | "provider-response-invalid"
  | "invalid-audio"
  | "unknown";

export type TranscriptionFailureStage = "configuration" | "dispatch" | "response" | "validation";

export interface TranscriptionFailureDescription {
  readonly reason: TranscriptionFailureReason;
  readonly stage: TranscriptionFailureStage;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
}

const RETRYABLE = new Set<TranscriptionFailureReason>([
  "provider-timeout",
  "provider-rate-limited",
  "provider-unavailable",
  "provider-network"
]);

export class TranscriptionTransportError extends Error implements TranscriptionFailureDescription {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;

  constructor(
    readonly reason: TranscriptionFailureReason,
    readonly stage: TranscriptionFailureStage,
    details: { readonly retryAfterMs?: number; readonly httpStatus?: number } = {}
  ) {
    const status =
      details.httpStatus !== undefined &&
      Number.isInteger(details.httpStatus) &&
      details.httpStatus >= 100 &&
      details.httpStatus <= 599
        ? details.httpStatus
        : undefined;
    super(
      reason === "provider-response-invalid"
        ? "Invalid or unsupported timestamped transcription response"
        : `Transcription ${reason}${status === undefined ? "" : `: HTTP ${status}`}`
    );
    this.name = "TranscriptionTransportError";
    this.retryable = RETRYABLE.has(reason);
    if (
      details.httpStatus !== undefined &&
      Number.isInteger(details.httpStatus) &&
      details.httpStatus >= 100 &&
      details.httpStatus <= 599
    )
      this.httpStatus = details.httpStatus;
    if (
      this.retryable &&
      details.retryAfterMs !== undefined &&
      Number.isFinite(details.retryAfterMs) &&
      details.retryAfterMs >= 0
    )
      this.retryAfterMs = Math.min(86_400_000, Math.ceil(details.retryAfterMs));
  }
}

/** Preserve long backoff as a deadline; callers must expire bounded audio, not retry early. */
export function transcriptionRetryAfterMs(
  value: string | null,
  now = Date.now()
): number | undefined {
  if (!value || value.length > 128) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : undefined;
  const delay = seconds === undefined ? Date.parse(value) - now : seconds * 1000;
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return Math.min(86_400_000, Math.ceil(delay));
}

export function transcriptionHttpFailure(response: Response): TranscriptionTransportError {
  const status = response.status;
  const reason: TranscriptionFailureReason =
    status === 429
      ? "provider-rate-limited"
      : status === 408
        ? "provider-timeout"
        : status === 401 || status === 403
          ? "provider-authentication"
          : status >= 500
            ? "provider-unavailable"
            : "provider-response-invalid";
  return new TranscriptionTransportError(reason, "response", {
    httpStatus: status,
    retryAfterMs: transcriptionRetryAfterMs(response.headers.get("retry-after"))
  });
}
