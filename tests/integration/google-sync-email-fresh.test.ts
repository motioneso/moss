import { describe, expect, it } from "vitest";
import { EmailExtractRetryableError, GoogleApiError } from "@moss/connectors";
import {
  EmailRepository,
  handles,
  ids,
  runGoogleSync,
  runGoogleSyncChunk,
  seedGoogleAccount
} from "./helpers/google-sync-orchestration.js";

// #2804 fixes 3 and 5 plus the uncapped retry: small committed current-day
// batches with a chunk time budget, a kept failure reason, and capped assays.
describe("google sync fresh mail, failure reasons, retry cap (#2804)", () => {
  const message = (id: string, historyId: string) => ({
    id,
    threadId: `${id}-thread`,
    historyId,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: `Status ${id}` },
        { name: "From", value: "a@b.example" }
      ],
      body: { data: Buffer.from("A short status update for the week.").toString("base64") }
    }
  });

  const junkReply = () => ({
    text: JSON.stringify({ gate: "nothing", category: "noise", confidence: 0.9 })
  });

  // A current-day page larger than one chunk must hand off after a small
  // batch, so each committed chunk makes its mail visible right away.
  it("pages the current-day mail in small committed batches", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:fresh-batches" };
    const ids10 = Array.from({ length: 10 }, (_, index) => `fresh-${index}`);
    const outcome = await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSyncChunk(db, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async () => [],
          listMessageIdsPage: async ({
            pageToken,
            maxResults
          }: {
            pageToken?: string;
            maxResults?: number;
          }) => {
            const start = pageToken ? Number(pageToken) : 0;
            const slice = ids10.slice(start, start + (maxResults ?? 500));
            const next = start + slice.length;
            return {
              messages: slice.map((id) => ({ id })),
              ...(next < ids10.length ? { nextPageToken: String(next) } : {})
            };
          },
          getMessage: async ({ id }: { id: string }) => message(id, `H-${id}`)
        },
        emailExtractDeps: { runChat: async () => junkReply() },
        now: () => new Date("2026-09-30T12:00:00.000Z")
      })
    );
    expect(outcome.result.truncated).toBe(true);
    expect(outcome.continuation?.phase).toBe("email-current-day");
    expect(outcome.result.emailUpserted).toBeLessThanOrEqual(8);
  });

  // A chunk that runs past its time budget must hand off the same page
  // instead of running past the job expiry.
  it("hands off the same page when the chunk time budget is spent", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:fresh-budget" };
    let clockMs = new Date("2026-09-30T12:00:00.000Z").getTime();
    const outcome = await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSyncChunk(db, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async () => [{ id: "budget-0" }, { id: "budget-1" }, { id: "budget-2" }],
          getMessage: async ({ id }: { id: string }) => message(id, `H-${id}`)
        },
        emailExtractDeps: {
          runChat: async () => {
            clockMs += 700_000;
            return junkReply();
          }
        },
        now: () => new Date(clockMs)
      })
    );
    expect(outcome.result.truncated).toBe(true);
    expect(outcome.continuation?.phase).toBe("email-current-day");
    // All three rows are saved (visible), but the over-budget chunk leaves
    // some for the next chunk instead of analysing everything itself.
    const rows = await handles.dataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.email_messages")
        .select(["external_id", "signals"])
        .where("connector_account_id", "=", accountId)
        .where("external_id", "in", ["budget-0", "budget-1", "budget-2"])
        .execute()
    );
    expect(rows).toHaveLength(3);
    const analysed = rows.filter(
      (row) =>
        (row.signals as { actionability?: { category?: unknown } })?.actionability?.category ===
        "noise"
    );
    expect(analysed.length).toBeGreaterThan(0);
    expect(analysed.length).toBeLessThan(3);
  });

  // A refused message must leave its bounded reason in the sync record, with
  // nothing secret beside it.
  it("keeps a refused message's reason in the sync record", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:fresh-reason" };
    await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSync(db, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async ({ query }: { query?: string }) =>
            query?.includes("older_than:1d") ? [] : [{ id: "reason-bad" }, { id: "reason-good" }],
          getMessage: async ({ id }: { id: string }) => {
            if (id === "reason-bad") {
              throw new GoogleApiError(
                "Gmail refused the message (bearer secret-xyz must never be stored)",
                403,
                "rateLimitExceeded",
                "gmail.messages.get"
              );
            }
            return message(id, `H-${id}`);
          }
        },
        emailExtractDeps: { runChat: async () => junkReply() },
        now: () => new Date("2026-09-30T12:00:00.000Z")
      })
    );
    const row = await handles.dataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.connector_accounts")
        .select(["last_sync_status", "last_sync_error", "last_sync_counts"])
        .where("id", "=", accountId)
        .executeTakeFirstOrThrow()
    );
    expect(row.last_sync_status).toBe("partial");
    expect(row.last_sync_error).toBe("email-message-error");
    expect(row.last_sync_counts).toMatchObject({
      emailErrorDetail: {
        status: 403,
        reason: "rateLimitExceeded",
        operation: "gmail.messages.get"
      }
    });
    expect(JSON.stringify(row.last_sync_counts)).not.toContain("secret-xyz");
  });

  // A message whose analysis always fails must stop being re-sent: after a
  // few syncs it is given up on and the model is no longer called for it.
  it("gives up on a message whose analysis always fails", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:fresh-retrycap" };
    let modelCalls = 0;
    const oneSync = () =>
      handles.workerDataContext.withDataContext(ctx, (db) =>
        runGoogleSyncChunk(db, {
          actorUserId: ids.userA,
          getFreshAccessToken: async () => "tok",
          getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
          googleClient: {
            listCalendarEvents: async () => [],
            listMessageIds: async () => [{ id: "cap-poison" }],
            getMessage: async ({ id }: { id: string }) => message(id, "H-cap")
          },
          emailExtractDeps: {
            runChat: async () => {
              modelCalls += 1;
              throw new EmailExtractRetryableError("timeout");
            }
          },
          now: () => new Date("2026-09-30T12:00:00.000Z")
        })
      );
    for (let sync = 0; sync < 7; sync += 1) {
      await oneSync();
    }
    expect(modelCalls).toBe(5);
    const stored = await handles.dataContext.withDataContext(ctx, (db) =>
      new EmailRepository().getByConnectorAccountAndExternalId(db, accountId, "cap-poison")
    );
    expect(stored).toMatchObject({ summary: null, signals: {} });
    const attempts = await handles.dataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.email_messages")
        .select("analysis_attempts")
        .where("connector_account_id", "=", accountId)
        .where("external_id", "=", "cap-poison")
        .executeTakeFirstOrThrow()
    );
    expect(Number(attempts.analysis_attempts)).toBe(5);
  });
});
