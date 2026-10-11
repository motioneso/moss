export class RecordingCapabilityError extends Error {
  readonly statusCode: number;
  readonly bindingReason = "recording-permission-revoked";
  constructor(
    readonly httpStatus: 400 | 403 | 409 | 429 = 403,
    readonly retryAfterSeconds = 60
  ) {
    super("Recording connection unavailable");
    this.name = "RecordingCapabilityError";
    this.statusCode = httpStatus;
  }
}
