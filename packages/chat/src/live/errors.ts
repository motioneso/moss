/**
 * Thrown when a live CLI session cannot be hosted: no terminal multiplexer
 * (tmux/herdr) is available/configured, OR the chosen multiplexer failed to launch
 * the session. Both map to HTTP 503. `cause` carries the underlying error for
 * server-side logging; the message is operator-safe (no secrets/stderr leakage).
 */
export class CliChatUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliChatUnavailableError";
  }
}

/**
 * #2348 — thrown when the app and the model program genuinely disagree about where the
 * answer file lives: the program has had a fair chance to create its project folder and
 * never did. Distinct from an ordinary "still writing" miss, which never throws. The
 * message names only the expected folder path — no prompt or reply content.
 */
export class CliTranscriptLocationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliTranscriptLocationMismatchError";
  }
}

/** Enter may have reached provider, but exact transcript ACK was not observed. Never auto-retry. */
export class CliChatDeliveryUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliChatDeliveryUnknownError";
  }
}

export class ChatTurnInFlightError extends Error {
  constructor() {
    super("A chat turn is already in progress. Wait for it to finish before sending another.");
    this.name = "ChatTurnInFlightError";
  }
}

export class ChatStreamLimitError extends Error {
  constructor() {
    super("Too many open chat streams for this user.");
    this.name = "ChatStreamLimitError";
  }
}

export class ChatThreadNotFoundError extends Error {
  constructor() {
    super("Chat thread not found or does not belong to this user.");
    this.name = "ChatThreadNotFoundError";
  }
}
