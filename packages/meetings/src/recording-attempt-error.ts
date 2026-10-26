/** Dispatch admission failed because this recording attempt is no longer current. */
export class RecordingAttemptSupersededError extends Error {
  constructor() {
    super("Recording attempt superseded");
    this.name = "RecordingAttemptSupersededError";
  }
}
