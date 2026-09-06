import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EMAIL_LLM_TIMEOUT_MS,
  extractEmailSignals,
  type EmailExtractDeps,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

const MESSAGE: ParsedEmail = {
  externalId: "synthetic-0",
  threadId: "thread-0",
  historyId: "history-0",
  subject: "Quarterly numbers requested",
  from: "alice@example.invalid",
  recipients: ["ben@example.invalid"],
  receivedAt: "2026-08-03T12:00:00.000Z",
  labelIds: ["INBOX"],
  snippet: "Please send the Q2 numbers by Friday.",
  body: "Hi Ben, could you send the Q2 numbers by Friday afternoon? Thanks, Alice.",
  bodyTruncated: false
};

/**
 * Review B4: the one-shot engine that now serves every structured email-extraction call takes
 * longer than the old 20-second default to start a fresh process and answer, so every batch timed
 * out. This proves the call budget is 120 seconds when no setting is present, not 20 seconds.
 */
describe("email extraction default call budget", () => {
  const originalEnv = process.env.JARVIS_EMAIL_LLM_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.JARVIS_EMAIL_LLM_TIMEOUT_MS;
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.JARVIS_EMAIL_LLM_TIMEOUT_MS;
    else process.env.JARVIS_EMAIL_LLM_TIMEOUT_MS = originalEnv;
    vi.useRealTimers();
  });

  it("is 120 seconds", () => {
    expect(DEFAULT_EMAIL_LLM_TIMEOUT_MS).toBe(120_000);
  });

  /** A model call that only ends when its budget aborts it, mirroring the real structured-call
   *  adapter, which kills the engine and rejects on the abort signal rather than hanging forever. */
  function slowRunChat(): EmailExtractDeps["runChat"] {
    return (_prompt, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
  }

  it("does not give up at the old 20-second budget when no setting is present", async () => {
    const deps: EmailExtractDeps = { runChat: slowRunChat() };

    let settled = false;
    const pending = extractEmailSignals(MESSAGE, deps).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(DEFAULT_EMAIL_LLM_TIMEOUT_MS - 20_000);
    await pending;
    expect(settled).toBe(true);
  });

  it("degrades to a no-confidence result once the 120-second default is reached", async () => {
    const deps: EmailExtractDeps = { runChat: slowRunChat() };

    let settled = false;
    const pending = extractEmailSignals(MESSAGE, deps).then((result) => {
      settled = true;
      return result;
    });

    // Proves the budget is actually 120 seconds, not a shorter value with the exported constant
    // left at 120000: a run still 1ms short of the deadline must still be waiting.
    await vi.advanceTimersByTimeAsync(DEFAULT_EMAIL_LLM_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(settled).toBe(true);
    expect(result.signals.confidence).toBe(0);
    expect(result.summary).toBeNull();
  });
});
