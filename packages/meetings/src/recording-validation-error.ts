export class RecordingImportInputError extends Error {
  constructor(readonly statusCode: 400 | 413 = 400) {
    super("Invalid completed recording bundle");
  }
}
