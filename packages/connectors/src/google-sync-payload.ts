import type { GoogleSyncContinuationPayload } from "./sync-jobs.js";

const GOOGLE_SYNC_ERROR_LABELS = new Set([
  "auth-error",
  "calendar-error",
  "calendar-item-error",
  "email-error",
  "email-needs-config",
  "email-message-error",
  "no-active-connection"
]);

/** The deferred-message set is capped so a continuation payload can never grow unbounded. */
export const MAX_DEFERRED_KEYS = 500;

const DEFERRED_REASONS = new Set<string>([
  "assistant-login-expired",
  "assistant-unavailable",
  "structured-output"
]);

const HISTORY_MODES = new Set<string>(["history", "full"]);

const SYNC_TRIGGERS = new Set<string>(["schedule", "manual", "assistant", "on-connect"]);

export function assertGoogleSyncContinuationPayload(payload: GoogleSyncContinuationPayload): void {
  if (payload.kind !== "google-sync-continuation") throw new Error("invalid continuation kind");
  if (
    payload.phase !== "calendar" &&
    payload.phase !== "email-current-day" &&
    payload.phase !== "email"
  ) {
    throw new Error("invalid continuation phase");
  }
  if (
    payload.cursor !== undefined &&
    (payload.cursor.length === 0 || payload.cursor.length > 2048)
  ) {
    throw new Error("invalid continuation cursor");
  }
  if (payload.idempotencyKey.length === 0 || payload.idempotencyKey.length > 128) {
    throw new Error("invalid continuation idempotency key");
  }
  if (!Number.isFinite(Date.parse(payload.startedAt))) throw new Error("invalid continuation time");
  if (!Number.isFinite(Date.parse(payload.calendarSeenSince))) {
    throw new Error("invalid calendar continuation time");
  }
  const counts = [
    payload.chunkIndex,
    payload.calendarUpserted,
    payload.calendarReconciled,
    payload.emailUpserted,
    payload.emailFailures,
    payload.escalations
  ];
  // A job queued before this field existed simply has no deferred count. Treat that as zero
  // rather than rejecting the job, but still reject a value that is present and nonsense.
  if (payload.emailDeferred !== undefined) counts.push(payload.emailDeferred);
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) {
    throw new Error("invalid continuation count");
  }
  if (payload.deferredKeys !== undefined) {
    if (
      !Array.isArray(payload.deferredKeys) ||
      payload.deferredKeys.length > MAX_DEFERRED_KEYS ||
      payload.deferredKeys.some(
        (key) => typeof key !== "string" || key.length === 0 || key.length > 256
      )
    ) {
      throw new Error("invalid continuation deferred keys");
    }
  }
  if (
    payload.deferredReason !== undefined &&
    payload.deferredReason !== null &&
    !DEFERRED_REASONS.has(payload.deferredReason)
  ) {
    throw new Error("invalid continuation deferred reason");
  }
  if (payload.historyMode !== undefined && !HISTORY_MODES.has(payload.historyMode)) {
    throw new Error("invalid continuation history mode");
  }
  if (payload.historyAnchor !== undefined && !/^[0-9]{1,32}$/.test(payload.historyAnchor)) {
    throw new Error("invalid continuation history position");
  }
  if (payload.errorDetail !== undefined && payload.errorDetail !== null) {
    const detail = payload.errorDetail;
    if (
      typeof detail !== "object" ||
      (detail.status !== null &&
        (!Number.isInteger(detail.status) || detail.status < 100 || detail.status > 599)) ||
      (detail.reason !== null &&
        (typeof detail.reason !== "string" ||
          detail.reason.length === 0 ||
          detail.reason.length > 64)) ||
      (detail.operation !== null &&
        (typeof detail.operation !== "string" ||
          detail.operation.length === 0 ||
          detail.operation.length > 64))
    ) {
      throw new Error("invalid continuation error detail");
    }
  }
  if (payload.recentOnly !== undefined && typeof payload.recentOnly !== "boolean") {
    throw new Error("invalid continuation recent-only flag");
  }
  if (payload.trigger !== undefined && !SYNC_TRIGGERS.has(payload.trigger)) {
    throw new Error("invalid continuation trigger");
  }
  if (
    payload.errors.length > GOOGLE_SYNC_ERROR_LABELS.size ||
    payload.errors.some((error) => !GOOGLE_SYNC_ERROR_LABELS.has(error))
  ) {
    throw new Error("invalid continuation error label");
  }
}
