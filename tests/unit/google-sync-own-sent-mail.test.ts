import { describe, expect, it } from "vitest";
import { hasFinishedVerdict } from "../../packages/email/src/repository.js";
import {
  sortFetchedEmails,
  type SavedEmailMarker
} from "../../packages/connectors/src/google-sync-phases.js";

// #2878: mail the user sent themselves is never sorted or sent to a model, and a row already
// marked as waiting for a decision is settled on the next sync.
describe("own sent mail in sync", () => {
  const own = new Set(["me@example.com"]);
  const base = {
    externalId: "m1",
    threadId: "t1",
    historyId: "H1",
    recipients: ["boss@corp.example"],
    subject: "Re: Final Interview",
    snippet: "",
    receivedAt: "2026-09-20T12:00:00.000Z",
    labelIds: ["SENT"]
  };

  const run = async (from: string, marker?: Partial<SavedEmailMarker>) => {
    const saved: { externalId: string; extracted: unknown }[] = [];
    const result = await sortFetchedEmails({
      parsedMessages: [{ ...base, from } as never],
      seen: new Map(
        marker
          ? [
              [
                "m1",
                {
                  historyId: "H1",
                  hasFinishedVerdict: true,
                  awaitingJudgement: false,
                  analysisAttempts: 0,
                  ...marker
                }
              ]
            ]
          : []
      ),
      persistEmail: async (parsed, extracted) => {
        saved.push({ externalId: parsed.externalId, extracted });
      },
      progress: { emailUpserted: 0, emailFailures: 0, errors: [] },
      onFailure: () => undefined,
      ownAddresses: own
    });
    return { result, saved };
  };

  it("does not queue a new own message for a model", async () => {
    const { result, saved } = await run("Me <ME@example.com>");
    expect(result.pending).toEqual([]);
    expect(result.ownSentKeys).toEqual(["m1"]);
    expect(saved).toHaveLength(1);
    expect(hasFinishedVerdict(null, (saved[0]!.extracted as { signals: unknown }).signals)).toBe(
      true
    );
    expect(
      (saved[0]!.extracted as { signals: { pendingJudgement?: boolean } }).signals.pendingJudgement
    ).toBeUndefined();
  });

  it("settles a stuck row that is waiting for a decision", async () => {
    const { result, saved } = await run("me@example.com", {
      awaitingJudgement: true,
      judgementRequestedAt: null
    });
    expect(result.rejudgeThreadRefs).toEqual([]);
    expect(result.ownSentKeys).toEqual(["m1"]);
    expect(saved).toHaveLength(1);
  });

  it("leaves a settled own message alone", async () => {
    const { result, saved } = await run("me@example.com", { awaitingJudgement: false });
    expect(saved).toHaveLength(0);
    expect(result.unchangedKeys).toEqual(["m1"]);
  });

  it("still sorts mail from someone else", async () => {
    const { result } = await run("boss@corp.example");
    expect(result.pending.map((p) => p.externalId)).toEqual(["m1"]);
    expect(result.ownSentKeys).toEqual([]);
  });
});
