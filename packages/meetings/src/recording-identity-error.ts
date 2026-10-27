export class RecordingIdentityError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 400
  ) {
    super(code);
  }
}
