import { describe, expect, it } from "vitest";
import {
  REJUDGEMENT_RETRY_MS,
  sortFetchedEmails,
  type SavedEmailMarker
} from "../../packages/connectors/src/google-sync-phases.js";

// #2804: an unchanged hand-off asks for its thread judgement again only when it was never
// requested or the last request is older than the retry window.
describe("rejudgement marker", () => {
  const NOW = new Date("2026-09-30T12:00:00.000Z");
  const parsed = {
    externalId: "m1",
    threadId: "t1",
    historyId: "H1",
    from: "a@b.example",
    recipients: [],
    subject: "Hello",
    snippet: "",
    receivedAt: "2026-09-20T12:00:00.000Z",
    labelIds: []
  };

  const sort = (marker: Partial<SavedEmailMarker>) =>
    sortFetchedEmails({
      parsedMessages: [parsed as never],
      seen: new Map([
        [
          "m1",
          {
            historyId: "H1",
            hasFinishedVerdict: true,
            awaitingJudgement: true,
            analysisAttempts: 0,
            ...marker
          }
        ]
      ]),
      persistEmail: async () => undefined,
      progress: { emailUpserted: 0, emailFailures: 0, errors: [] },
      onFailure: () => undefined,
      now: NOW
    });

  it("asks when it was never requested", async () => {
    const result = await sort({ judgementRequestedAt: null });
    expect(result.rejudgeThreadRefs).toEqual(["t1"]);
    expect(result.rejudgeKeys.get("t1")).toEqual(["m1"]);
  });

  it("stays quiet inside the retry window", async () => {
    const result = await sort({
      judgementRequestedAt: new Date(NOW.getTime() - REJUDGEMENT_RETRY_MS + 60_000)
    });
    expect(result.rejudgeThreadRefs).toEqual([]);
  });

  it("asks again once the last request is older than the window", async () => {
    const result = await sort({
      judgementRequestedAt: new Date(NOW.getTime() - REJUDGEMENT_RETRY_MS - 60_000)
    });
    expect(result.rejudgeThreadRefs).toEqual(["t1"]);
  });
});
