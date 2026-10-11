import type { MeetingCaptureRevocationReason } from "@moss/shared";
import { MeetingCaptureError } from "./capture-domain.js";
/** Public auth ports expose status only. Unexpected infrastructure errors never imply revocation. */
export function captureAuthorizationError(error: unknown): MeetingCaptureError {
  if (error instanceof MeetingCaptureError) return error;
  const denied =
    error !== null &&
    typeof error === "object" &&
    (("httpStatus" in error && (error.httpStatus === 401 || error.httpStatus === 403)) ||
      ("statusCode" in error && (error.statusCode === 401 || error.statusCode === 403)));
  const reason = denied && "bindingReason" in error ? error.bindingReason : undefined;
  const known = ["device-unavailable", "recording-permission-revoked", "session-ended"];
  return new MeetingCaptureError(
    "meeting_capture_unavailable",
    denied ? 401 : 503,
    1,
    typeof reason === "string" && known.includes(reason)
      ? (reason as MeetingCaptureRevocationReason)
      : undefined
  );
}
