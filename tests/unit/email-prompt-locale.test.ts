process.env.TZ = "UTC";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiRepository } from "@moss/ai";
import type { LocaleSettingsDto } from "@moss/shared";

import {
  extractEmailSignals,
  type EmailExtractDeps,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";
import { buildEmailSortingState } from "../../packages/connectors/src/email-sorting.js";
import { buildEmailExtractDeps } from "../../packages/connectors/src/extract-deps.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

/**
 * #3395: the "Today" and "Received" dates the email models read are the person's own, not the
 * server's UTC day. The machine runs in UTC; 03:30 UTC on Oct 10 is 20:30 on Oct 9 in Los Angeles.
 */

const PACIFIC_24: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-GB",
  dateFormat: "24"
};
const NOW = new Date("2026-10-10T03:30:00.000Z");
const RECEIVED_AT = "2026-10-10T02:00:00.000Z";

const MESSAGE: ParsedEmail = {
  externalId: "m1",
  threadId: null,
  historyId: null,
  subject: "Can you confirm by tomorrow?",
  from: "Friend <friend@example.com>",
  recipients: ["me@example.com"],
  receivedAt: RECEIVED_AT,
  labelIds: ["INBOX"],
  snippet: "",
  body: "Let me know if Saturday still works.",
  bodyTruncated: false
};

afterEach(() => {
  vi.useRealTimers();
});

describe("email triage prompt dates", () => {
  it("writes Today and Received as the person's own day, date only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const prompts: string[] = [];
    const deps: EmailExtractDeps = {
      locale: async () => PACIFIC_24,
      runChat: async (prompt) => {
        prompts.push(prompt);
        return { text: JSON.stringify({ category: "fyi", confidence: 0.9 }) };
      }
    };

    await extractEmailSignals(MESSAGE, deps);

    expect(prompts[0]).toContain("Received: 2026-10-09\n");
    expect(prompts[0]).toContain("Today: 2026-10-09");
  });

  it("gives the sorting model the same local dates", () => {
    const state = buildEmailSortingState(
      { subject: "s", from: "a@b.c", receivedAt: RECEIVED_AT, body: "hello" },
      NOW,
      PACIFIC_24
    );

    expect(state.received).toBe("2026-10-09");
    expect(state.today).toBe("2026-10-09");
  });

  it("reads the person's saved locale once per set of extraction deps", async () => {
    const get = vi.fn(async () => PACIFIC_24);
    const deps = buildEmailExtractDeps(makeRecordingDb().scoped, {} as AiRepository, {} as never, {
      preferences: { get }
    });

    await expect(deps.locale?.()).resolves.toEqual(PACIFIC_24);
    await deps.locale?.();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(expect.anything(), "locale");
  });
});
