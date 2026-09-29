import { describe, expect, it } from "vitest";
import { EmailExtractNeedsConfigurationError } from "@moss/connectors";
import {
  EmailRepository,
  handles,
  ids,
  runGoogleSync,
  runGoogleSyncChunk,
  seedGoogleAccount
} from "./helpers/google-sync-orchestration.js";

// #2804: repeat syncs skip messages with a finished verdict, and a root admitted during a
// running lineage fetches recent mail only.
describe("runGoogleSync repeat and overlapping runs (#2804)", () => {
  // #2804: the gate saves junk and thread hand-offs with no summary. A repeat sync must treat
  // those as finished, and must still retry a message that never got a verdict.
  const repeatSync = async (id: string, reply: string | null) => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:repeat-sync" };
    let llmCalls = 0;
    const judgementRequests: string[] = [];
    const run = () =>
      handles.workerDataContext.withDataContext(ctx, (db) =>
        runGoogleSync(db, {
          actorUserId: ids.userA,
          getFreshAccessToken: async () => "tok",
          getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
          googleClient: {
            listCalendarEvents: async () => [],
            listMessageIds: async ({ query }: { query?: string }) =>
              query?.includes("older_than:1d") ? [{ id }] : [],
            getMessage: async () => ({
              id,
              threadId: `${id}-thread`,
              historyId: "H900",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "Subject", value: "Weekly deals" },
                  { name: "From", value: "deals@shop.example" },
                  { name: "List-Unsubscribe", value: "<mailto:u@shop.example>" }
                ],
                body: {
                  data: Buffer.from("Save 20% on everything in store this week only.").toString(
                    "base64"
                  )
                }
              }
            })
          },
          emailExtractDeps: {
            runChat: async () => {
              llmCalls += 1;
              if (reply === null) throw new EmailExtractNeedsConfigurationError();
              return { text: reply };
            }
          },
          threadJudgementRequester: {
            requestThreadJudgement: async (_actor, threadRef) => {
              judgementRequests.push(threadRef);
            }
          },
          now: () => new Date("2026-09-29T12:00:00.000Z")
        })
      );
    await run();
    await run();
    const stored = await handles.dataContext.withDataContext(ctx, (db) =>
      new EmailRepository().getByConnectorAccountAndExternalId(db, accountId, id)
    );
    return { llmCalls, judgementRequests, stored };
  };

  it("does not send a junk message back to the model on a repeat sync", async () => {
    const { llmCalls, stored } = await repeatSync(
      "repeat-junk",
      JSON.stringify({ gate: "nothing", category: "noise", confidence: 0.9 })
    );
    expect(stored).toMatchObject({
      summary: null,
      signals: { actionability: { category: "noise" } }
    });
    expect(llmCalls).toBe(1);
  });

  it("does not send a thread hand-off back to the model on a repeat sync", async () => {
    const { llmCalls, judgementRequests, stored } = await repeatSync(
      "repeat-owed",
      JSON.stringify({ gate: "maybe_owed", category: "needs_reply", confidence: 0.9 })
    );
    expect(stored).toMatchObject({ summary: null, signals: { pendingJudgement: true } });
    expect(llmCalls).toBe(1);
    expect(judgementRequests).toEqual(["repeat-owed-thread"]);
  });

  it("still retries a message that never got a verdict", async () => {
    const { llmCalls, stored } = await repeatSync("repeat-unanswered", null);
    expect(stored).toMatchObject({ summary: null, signals: {} });
    expect(llmCalls).toBe(2);
  });

  // #2804: a root admitted while another lineage is in flight fetches new mail and stops there.
  it("a recent-only run fetches the last day of mail and never walks the backlog", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:recent-only" };
    const queries: string[] = [];
    const message = (id: string) => ({
      id,
      historyId: `H-${id}`,
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "Subject", value: "Status" },
          { name: "From", value: "a@b.example" }
        ],
        body: { data: Buffer.from("A short status update for the week.").toString("base64") }
      }
    });
    const result = await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSync(db, {
        recentOnly: true,
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async ({ query }: { query?: string }) => {
            queries.push(query ?? "");
            return query?.includes("older_than:1d")
              ? [{ id: "recent-only-old" }]
              : [{ id: "recent-only-new" }];
          },
          getMessage: async ({ id }: { id: string }) => message(id)
        },
        emailExtractDeps: {
          runChat: async () => ({
            text: JSON.stringify({ gate: "nothing", category: "noise", confidence: 0.9 })
          })
        },
        now: () => new Date("2026-09-29T12:00:00.000Z")
      })
    );
    expect(result).toMatchObject({ emailUpserted: 1, truncated: false });
    expect(queries.some((query) => query.includes("older_than:1d"))).toBe(false);
    const stored = await handles.dataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.email_messages")
        .select("external_id")
        .where("connector_account_id", "=", accountId)
        .where("external_id", "in", ["recent-only-new", "recent-only-old"])
        .execute()
    );
    expect(stored.map((row) => row.external_id)).toEqual(["recent-only-new"]);
  });

  // #2804: two lineages can overlap, so a finishing lineage must not pair its outcome with the
  // start time another run stamped meanwhile.
  it("a finishing lineage restamps its own start time", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:restamp-start" };
    const deps = {
      getFreshAccessToken: async () => "tok",
      getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
      googleClient: {
        listCalendarEvents: async () => [],
        listMessageIds: async () => [],
        getMessage: async () => {
          throw new Error("no messages");
        }
      },
      emailExtractDeps: { runChat: async () => ({ text: "{}" }) },
      now: () => new Date("2026-09-29T12:00:00.000Z")
    };
    // A newer root stamps its own start on the row.
    await handles.workerDataContext.withDataContext(ctx, (db) => runGoogleSync(db, deps));
    // The older lineage's last chunk then finishes.
    await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSyncChunk(db, deps, {
        idempotencyKey: "older-lineage",
        connectorAccountId: accountId,
        phase: "email",
        chunkIndex: 7,
        startedAt: "2026-09-29T08:00:00.000Z",
        calendarSeenSince: "2026-09-29T08:00:00.000Z",
        calendarUpserted: 0,
        calendarReconciled: 0,
        emailUpserted: 40,
        emailFailures: 0,
        escalations: 0,
        errors: []
      })
    );
    const row = await handles.dataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.connector_accounts")
        .select(["last_sync_started_at", "last_sync_finished_at", "last_sync_counts"])
        .where("id", "=", accountId)
        .executeTakeFirstOrThrow()
    );
    expect(row.last_sync_started_at?.toISOString()).toBe("2026-09-29T08:00:00.000Z");
    expect(row.last_sync_finished_at?.toISOString()).toBe("2026-09-29T12:00:00.000Z");
    expect(row.last_sync_counts).toMatchObject({ emailUpserted: 40 });
  });
});
