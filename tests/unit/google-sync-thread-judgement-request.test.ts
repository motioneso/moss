import { describe, expect, it, vi } from "vitest";

import {
  buildEmailBatchExtractOptions,
  persistExtractedBatch
} from "../../packages/connectors/src/google-sync-phases.js";
import type {
  EmailExtractResult,
  ParsedEmail
} from "../../packages/connectors/src/email-extract.js";
import { runImapSync } from "../../packages/connectors/src/imap-sync-jobs.js";
import { createEmailThreadProvider } from "../../packages/email/src/thread-provider.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

type Requester = (actorUserId: string, threadRef: string) => Promise<void>;

function fixture(overrides: Partial<ParsedEmail>): ParsedEmail {
  return {
    externalId: "msg-1",
    threadId: "t1",
    historyId: "history-1",
    subject: "Hello",
    from: "Sarah Kim <Sarah@Kim.Example>",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:00:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Hello",
    body: "Hello",
    bodyTruncated: false,
    ...overrides
  };
}
const owed: EmailExtractResult = { gate: "maybe_owed", summary: null, signals: {} };
const nothing: EmailExtractResult = { gate: "nothing", summary: null, signals: {} };

describe("google sync asks for a thread judgement", () => {
  it("asks once per maybe_owed message on its thread and never for nothing", async () => {
    const requestThreadJudgement = vi.fn<Requester>(async () => {});
    const batch = [
      fixture({ externalId: "a", threadId: "t1" }),
      fixture({ externalId: "b", threadId: "t1" }),
      fixture({ externalId: "c", threadId: "t2" })
    ];
    const progress = { emailFailures: 0, errors: [] as string[] };
    const keys = await persistExtractedBatch({
      batch,
      batchResults: [owed, owed, nothing],
      persistEmail: async () => {},
      progress,
      onFailure: () => {},
      actorUserId: "u1",
      threadJudgementRequester: { requestThreadJudgement }
    });
    expect(keys).toEqual(["a", "b", "c"]);
    expect(requestThreadJudgement).toHaveBeenCalledTimes(2);
    expect(requestThreadJudgement.mock.calls.every((c) => c[0] === "u1" && c[1] === "t1")).toBe(
      true
    );
  });
  it("uses the message id as the thread reference when the provider gives none", async () => {
    const requestThreadJudgement = vi.fn(async () => {});
    await persistExtractedBatch({
      batch: [fixture({ externalId: "solo", threadId: undefined })],
      batchResults: [owed],
      persistEmail: async () => {},
      progress: { emailFailures: 0, errors: [] },
      onFailure: () => {},
      actorUserId: "u1",
      threadJudgementRequester: { requestThreadJudgement }
    });
    expect(requestThreadJudgement).toHaveBeenCalledWith("u1", "solo");
  });
  it("a failed request counts as a message failure but the save stays", async () => {
    const progress = { emailFailures: 0, errors: [] as string[] };
    const onFailure = vi.fn();
    await persistExtractedBatch({
      batch: [fixture({})],
      batchResults: [owed],
      persistEmail: async () => {},
      progress,
      onFailure,
      actorUserId: "u1",
      threadJudgementRequester: {
        requestThreadJudgement: async () => {
          throw new Error("queue down");
        }
      }
    });
    expect(progress.emailFailures).toBe(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
  it("passes known sender addresses into the batch options", () => {
    const options = buildEmailBatchExtractOptions({
      phase: "email",
      closeScope: true,
      knownSenders: new Set(["sarah@kim.example"]),
      runId: "run-1",
      logger: { info: () => {}, warn: () => {} }
    });
    expect(options.knownSenders?.has("sarah@kim.example")).toBe(true);
    expect(options.priority).toBe("background");
    expect(options.closeScope).toBe(true);
  });
});

describe("imap sync asks for a thread judgement", () => {
  function harness(gate: EmailExtractResult["gate"]) {
    const parsed = fixture({ externalId: "imap-1", threadId: undefined });
    const runChat = vi.fn(async (_prompt: string) => ({
      text: JSON.stringify({ gate, summary: null })
    }));
    const requestThreadJudgement = vi.fn(async () => {});
    const upsertCachedMessage = vi.fn(async () => ({}));
    const deps = {
      repository: {
        markSyncStarted: vi.fn(async () => {}),
        markSyncFinished: vi.fn(async () => {}),
        getActiveImapAccountSecret: vi.fn(async () => ({ encryptedSecret: "enc" }))
      },
      cipher: {
        decryptJson: () => ({
          kind: "imap-password",
          providerId: "custom",
          username: "u",
          password: "p",
          imapHost: "imap.example.invalid",
          smtpHost: "smtp.example.invalid"
        })
      },
      emailExtractDeps: { runChat },
      emailReadProvider: {
        listMessageKeys: vi.fn(async () => ["k1"]),
        getMessage: vi.fn(async () => parsed)
      },
      emailRepository: { upsertCachedMessage },
      actorUserId: "u1",
      threadJudgementRequester: { requestThreadJudgement },
      knownSenderAddresses: vi.fn(async () => new Set(["sarah@kim.example"]))
    };
    return { deps, runChat, requestThreadJudgement };
  }
  it("requests a judgement keyed by the message id after a maybe_owed message", async () => {
    const { deps, runChat, requestThreadJudgement } = harness("maybe_owed");
    const result = await runImapSync(makeRecordingDb().scoped as never, "acct-1", deps as never);
    expect(result.emailUpserted).toBe(1);
    expect(requestThreadJudgement).toHaveBeenCalledWith("u1", "imap-1");
    const prompt = runChat.mock.calls[0]![0];
    expect(prompt).toContain("someone this user already deals with");
  });
  it("does not request one for nothing", async () => {
    const { deps, requestThreadJudgement } = harness("nothing");
    await runImapSync(makeRecordingDb().scoped as never, "acct-1", deps as never);
    expect(requestThreadJudgement).not.toHaveBeenCalled();
  });
});

describe("thread provider falls back to the single message", () => {
  it("reads the one message whose id is the thread reference when no thread matches", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000009",
      external_id: "imap-1",
      sender: "Sarah Kim <sarah@kim.example>",
      subject: "Hi",
      received_at: new Date("2026-09-01T10:00:00Z"),
      body_excerpt: "Can you send it?"
    };
    const provider = createEmailThreadProvider(
      {
        listByThread: vi.fn(async () => []),
        listNewerInThreads: vi.fn(async () => []),
        getByOwnerAndExternalId: vi.fn(async () => row)
      } as never,
      async () => new Set(["ben@example.invalid"])
    );
    const messages = await provider.listThreadMessages({}, "u1", "imap-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.externalId).toBe("imap-1");
    expect(messages[0]!.fromIsUser).toBe(false);
  });
});
