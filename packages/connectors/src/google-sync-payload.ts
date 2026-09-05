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
    payload.escalations,
    payload.emailDeferred
  ];
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) {
    throw new Error("invalid continuation count");
  }
  if (
    payload.errors.length > GOOGLE_SYNC_ERROR_LABELS.size ||
    payload.errors.some((error) => !GOOGLE_SYNC_ERROR_LABELS.has(error))
  ) {
    throw new Error("invalid continuation error label");
  }
}
