import { describe, expect, it } from "vitest";
import { GoogleTokenError } from "@moss/connectors";
import {
  handles,
  ids,
  runGoogleSync,
  seedGoogleAccount
} from "./helpers/google-sync-orchestration.js";

const INFORMATIONAL_COMPACT_REPLY = {
  category: "fyi",
  confidence: 0.9,
  reason: "Informational update."
};

describe("runGoogleSync auth and health", () => {
  it("records a no-active-connection error without throwing", async () => {
    const ctx = { actorUserId: ids.userB, requestId: "pgboss:test" };
    const result = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => {
          throw new Error("No active Google connection");
        },
        getActiveAccount: async () => undefined,
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async () => [],
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({ text: "" })
        },
        now: () => new Date()
      })
    );
    expect(result.errors).toContain("no-active-connection");
  });

  it("forces a token refresh and retries once on a 401 from a Google call", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    let refreshes = 0;
    let calendarAttempts = 0;
    const result = await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSync(db, {
        getFreshAccessToken: async (_db, opts) => {
          if (opts?.force) refreshes += 1;
          return opts?.force ? "fresh-tok" : "stale-tok";
        },
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar"] }),
        googleClient: {
          listCalendarEvents: async ({ accessToken }) => {
            calendarAttempts += 1;
            if (accessToken === "stale-tok") {
              const e = new Error("Google calendar returned 401") as Error & { statusCode: number };
              e.statusCode = 401;
              throw e;
            }
            return [
              {
                id: "g1",
                summary: "X",
                start: { dateTime: "2026-06-13T09:00:00Z" },
                end: { dateTime: "2026-06-13T09:15:00Z" }
              }
            ];
          },
          listMessageIds: async () => [],
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({ text: "" })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );
    expect(refreshes).toBe(1);
    expect(calendarAttempts).toBe(2);
    expect(result.calendarUpserted).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("a mid-loop 401 rotates the token for ALL remaining messages (no per-message re-refresh)", async () => {
    // LOW: when one message 401s and the forced refresh succeeds, the rotated token must be carried
    // forward (shared holder), so every later message uses the fresh token rather than 401ing and
    // refreshing again. Here only the FIRST getMessage on the stale token 401s; with the holder,
    // exactly ONE refresh occurs even though there are several messages.
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    let refreshes = 0;
    let staleHits = 0;
    const msg = (id: string) => ({
      id,
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "Subject", value: "S" },
          { name: "From", value: "a@b.com" }
        ],
        body: { data: Buffer.from("hi").toString("base64") }
      }
    });
    const result = await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSync(db, {
        getFreshAccessToken: async (_db, opts) => {
          if (opts?.force) refreshes += 1;
          return opts?.force ? "fresh-tok" : "stale-tok";
        },
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async ({ query }) =>
            query?.includes("older_than:1d")
              ? []
              : [{ id: "loop-1" }, { id: "loop-2" }, { id: "loop-3" }],
          getMessage: async ({ accessToken, id }) => {
            if (accessToken === "stale-tok") {
              staleHits += 1;
              const e = new Error("Google gmail returned 401") as Error & { statusCode: number };
              e.statusCode = 401;
              throw e;
            }
            return msg(id);
          }
        },
        emailExtractDeps: {
          runChat: async (_prompt, _signal, batchSize = 1) => {
            expect(batchSize).toBe(1);
            return { text: JSON.stringify(INFORMATIONAL_COMPACT_REPLY) };
          }
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );
    // The concurrent page shares one refresh; every in-flight read may observe the stale token,
    // but none launches a second refresh.
    expect(refreshes).toBe(1);
    expect(staleHits).toBe(3);
    expect(result.emailUpserted).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("records success health with aggregate counts after a clean sync", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar", "gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [
            {
              id: "health-ok-evt",
              summary: "Healthy",
              start: { dateTime: "2026-06-13T09:00:00Z" },
              end: { dateTime: "2026-06-13T09:15:00Z" }
            }
          ],
          listMessageIds: async ({ query }) =>
            query?.includes("older_than:1d") ? [] : [{ id: "health-ok-msg" }],
          getMessage: async () => ({
            id: "health-ok-msg",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "S" },
                { name: "From", value: "a@b.com" }
              ],
              body: { data: Buffer.from("hi").toString("base64") }
            }
          })
        },
        emailExtractDeps: {
          runChat: async (_prompt, _signal, batchSize = 1) => {
            expect(batchSize).toBe(1);
            return { text: JSON.stringify(INFORMATIONAL_COMPACT_REPLY) };
          }
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );

    const health = await readAccountHealth(accountId, ctx);
    expect(health.last_sync_status).toBe("success");
    expect(health.last_sync_error).toBeNull();
    expect(health.last_sync_counts).toMatchObject({ calendarUpserted: 1, emailUpserted: 1 });
    expect(health.last_sync_started_at).not.toBeNull();
    expect(health.last_sync_finished_at).not.toBeNull();
  });

  it("records partial health with a bounded label, not the raw error, on a per-item failure", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar", "gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [
            {
              id: "health-bad-evt",
              // start AFTER end → ends_at >= starts_at CHECK fails → bounded calendar-item-error.
              summary: "Inverted times raw provider detail",
              start: { dateTime: "2026-06-13T10:00:00Z" },
              end: { dateTime: "2026-06-13T09:00:00Z" }
            }
          ],
          listMessageIds: async () => [{ id: "health-partial-msg" }],
          getMessage: async () => ({
            id: "health-partial-msg",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "S" },
                { name: "From", value: "a@b.com" }
              ],
              body: { data: Buffer.from("hi").toString("base64") }
            }
          })
        },
        emailExtractDeps: {
          runChat: async (_prompt, _signal, batchSize = 1) => {
            expect(batchSize).toBe(1);
            return { text: JSON.stringify(INFORMATIONAL_COMPACT_REPLY) };
          }
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );

    const health = await readAccountHealth(accountId, ctx);
    expect(health.last_sync_status).toBe("partial");
    expect(health.last_sync_error).toBe("calendar-item-error");
    // Only the bounded label is persisted — never the raw event detail.
    expect(JSON.stringify(health)).not.toContain("Inverted times");
  });

  it("records failed health with a bounded auth label and no provider detail on a top-level auth failure", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => {
          throw new Error("raw provider body 401 invalid_grant secret-token");
        },
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async () => [],
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({ text: "" })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );

    const health = await readAccountHealth(accountId, ctx);
    expect(health.last_sync_status).toBe("failed");
    expect(health.last_sync_error).toBe("auth-error");
    // The raw provider/auth error text must never reach the persisted health row.
    expect(JSON.stringify(health)).not.toContain("raw provider body");
    expect(JSON.stringify(health)).not.toContain("secret-token");
  });

  it("records a temporary token-endpoint failure as a retry, not an expired sign-in (#3839)", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    const outcome = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => {
          throw new GoogleTokenError({
            kind: "transient",
            statusCode: 503,
            oauthError: null,
            message: "Google token endpoint returned 503"
          });
        },
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async () => [],
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({ text: "" })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );

    expect(outcome.errors).toEqual(["provider-unavailable"]);
    const health = await readAccountHealth(accountId, ctx);
    expect(health.last_sync_status).toBe("failed");
    expect(health.last_sync_error).toBe("provider-unavailable");
  });

  it("records a revoked grant as needing a reconnect (#3839)", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => {
          throw new GoogleTokenError({
            kind: "needs-reconnect",
            statusCode: 400,
            oauthError: "invalid_grant",
            message: "Google token endpoint returned 400"
          });
        },
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async () => [],
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({ text: "" })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );

    const health = await readAccountHealth(accountId, ctx);
    expect(health.last_sync_status).toBe("failed");
    expect(health.last_sync_error).toBe("auth-error");
  });

  async function readAccountHealth(
    accountId: string,
    ctx: { actorUserId: string; requestId: string }
  ) {
    return handles.dataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.connector_accounts")
        .select([
          "last_sync_started_at",
          "last_sync_finished_at",
          "last_sync_status",
          "last_sync_error",
          "last_sync_counts"
        ])
        .where("id", "=", accountId)
        .executeTakeFirstOrThrow()
    );
  }
});
