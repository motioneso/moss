import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import {
  ConnectorsRepository,
  createConnectorSecretCipher,
  runGoogleSync,
  runGoogleSyncChunk,
  runImapSync
} from "@moss/connectors";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/**
 * Worker-level cover for the sync-status slice: these go through the real run functions
 * rather than calling the storage methods, so they prove what the account row looks like
 * after a run a user would actually get.
 */
describe("real sync runs record their own health (#2239 slice 1)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  // Sync runs go through the worker role in production, and the app role is missing grants
  // the sync writes need, so a run driven on the app connection dies mid-transaction.
  let workerDb: Kysely<MossDatabase>;
  let workerContext: DataContextRunner;
  let repository: ConnectorsRepository;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_CONNECTOR_SECRET_KEY;
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    workerContext = new DataContextRunner(workerDb);
    repository = new ConnectorsRepository();
  });

  afterAll(async () => {
    await appDb?.destroy();
    await workerDb?.destroy();
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_CONNECTOR_SECRET_KEY;
    } else {
      process.env.JARVIS_CONNECTOR_SECRET_KEY = originalSecretKey;
    }
  });

  async function createGoogleAccount(): Promise<string> {
    const account = await dataContext.withDataContext(context(), (scopedDb) =>
      repository.createAccount(scopedDb, {
        providerId: "google-email",
        scopes: ["gmail", "calendar"],
        encryptedSecret: createConnectorSecretCipher().encryptJson({ accessToken: "a" })
      })
    );
    return account.id;
  }

  async function createImapAccount(): Promise<string> {
    const account = await dataContext.withDataContext(context(), (scopedDb) =>
      repository.upsertImapAccount(scopedDb, {
        providerId: "imap-proton",
        encryptedSecret: createConnectorSecretCipher().encryptJson({
          kind: "imap-password",
          providerId: "imap-proton",
          username: "user@proton.local",
          password: "secret",
          imapHost: "127.0.0.1",
          imapPort: 1143,
          imapTls: false,
          smtpHost: "127.0.0.1",
          smtpPort: 1025,
          smtpSecurity: "none"
        })
      })
    );
    return account.id;
  }

  function googleDeps(accountId: string, at: string) {
    return {
      actorUserId: ids.userA,
      trigger: "schedule" as const,
      getFreshAccessToken: async () => "tok",
      getActiveAccount: async () => ({ id: accountId, scopes: ["gmail", "calendar"] }),
      googleClient: {
        listCalendarEvents: async () => [],
        listMessageIds: async () => [],
        getMessage: async () => {
          throw new Error("no messages in this run");
        }
      },
      emailExtractDeps: { runChat: async () => ({ text: "" }) },
      now: () => new Date(at)
    };
  }

  function imapDeps(at: string, messages: readonly string[]) {
    return {
      repository,
      cipher: createConnectorSecretCipher(),
      emailReadProvider: {
        listFolders: async () => ["INBOX"],
        listMessageKeys: async () => messages.map((id) => ({ folder: "INBOX", id })),
        getMessage: async (_secret: unknown, key: { id: string }) => ({
          externalId: key.id,
          historyId: null,
          subject: "hi",
          from: "friend@example.com",
          recipients: [],
          receivedAt: at,
          labelIds: [],
          snippet: null,
          body: "body",
          bodyTruncated: false
        })
      },
      emailExtractDeps: { runChat: async () => ({ text: "" }) },
      now: () => new Date(at)
    };
  }

  it("two real Google runs leave the first run as the previous run", async () => {
    const accountId = await createGoogleAccount();

    await workerContext.withDataContext(context(), (scopedDb) =>
      runGoogleSync(scopedDb, googleDeps(accountId, "2026-09-04T10:00:00.000Z"))
    );
    const afterFirst = await accountRow(accountId);
    expect(afterFirst?.last_sync_status).toBe("success");
    expect(afterFirst?.previous_sync).toBeFalsy();

    await workerContext.withDataContext(context(), (scopedDb) =>
      runGoogleSync(scopedDb, googleDeps(accountId, "2026-09-04T11:00:00.000Z"))
    );
    const afterSecond = await accountRow(accountId);

    expect(afterSecond?.last_sync_status).toBe("success");
    expect(afterSecond?.last_sync_finished_at?.toISOString()).toBe("2026-09-04T11:00:00.000Z");
    expect(afterSecond?.previous_sync).toMatchObject({ status: "success", trigger: "schedule" });
    expect(afterSecond?.previous_sync?.finishedAt).toBe("2026-09-04T10:00:00.000Z");
  });

  it("two real email-account runs leave the first run as the previous run", async () => {
    const accountId = await createImapAccount();

    await workerContext.withDataContext(context(), (scopedDb) =>
      runImapSync(scopedDb, accountId, imapDeps("2026-09-04T10:00:00.000Z", ["imap:INBOX:1:1"]))
    );
    const afterFirst = await accountRow(accountId);
    expect(afterFirst?.last_sync_status).toBe("success");
    expect(afterFirst?.previous_sync).toBeFalsy();

    await workerContext.withDataContext(context(), (scopedDb) =>
      runImapSync(scopedDb, accountId, imapDeps("2026-09-04T11:00:00.000Z", ["imap:INBOX:1:2"]))
    );
    const afterSecond = await accountRow(accountId);

    expect(afterSecond?.last_sync_status).toBe("success");
    expect(afterSecond?.previous_sync).toMatchObject({ status: "success", trigger: "schedule" });
    expect(afterSecond?.previous_sync?.finishedAt).toBe("2026-09-04T10:00:00.000Z");
  });

  it("a Google run whose sign-in is refused is recorded as a failed run with a sign-in error", async () => {
    const accountId = await createGoogleAccount();

    const result = await workerContext.withDataContext(context(), (scopedDb) =>
      runGoogleSync(scopedDb, {
        ...googleDeps(accountId, "2026-09-04T12:00:00.000Z"),
        getFreshAccessToken: async () => {
          throw new Error("refresh refused");
        }
      })
    );
    expect(result.errors).toEqual(["auth-error"]);

    const row = await accountRow(accountId);
    expect(row?.last_sync_status).toBe("failed");
    expect(row?.last_sync_error).toBe("auth-error");
    // The bounded label only — never the provider's own error text.
    expect(JSON.stringify(row?.last_sync_counts ?? {})).not.toContain("refresh refused");
  });

  it("an email-account run the mail server refuses to sign in to is recorded as a failed run", async () => {
    const accountId = await createImapAccount();

    // The mail server itself refuses the saved password, the way a rotated or revoked
    // mailbox password really fails: authentication is refused on connect, inside the
    // first read call.
    const result = await workerContext.withDataContext(context(), (scopedDb) =>
      runImapSync(scopedDb, accountId, {
        ...imapDeps("2026-09-04T12:00:00.000Z", []),
        emailReadProvider: {
          listFolders: async () => {
            throw imapAuthenticationFailure();
          },
          listMessageKeys: async () => {
            throw imapAuthenticationFailure();
          },
          getMessage: async () => {
            throw imapAuthenticationFailure();
          }
        }
      })
    );
    expect(result.errors).toEqual(["auth-error"]);

    const row = await accountRow(accountId);
    expect(row?.last_sync_status).toBe("failed");
    expect(row?.last_sync_error).toBe("auth-error");
    // The bounded label only — never the mailbox password or the server's own text.
    const stored = JSON.stringify(row?.last_sync_counts ?? {});
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("Invalid credentials");
  });

  it("a continuation chunk of a real run leaves the earlier run as the previous run", async () => {
    const accountId = await createGoogleAccount();

    // Run one finishes, so it is the run that must survive.
    await workerContext.withDataContext(context(), (scopedDb) =>
      runGoogleSync(scopedDb, googleDeps(accountId, "2026-09-04T10:00:00.000Z"))
    );

    // Run two is chunked for real: the first chunk hands work to a continuation.
    const deps = googleDeps(accountId, "2026-09-04T11:00:00.000Z");
    const first = await workerContext.withDataContext(context(), (scopedDb) =>
      runGoogleSyncChunk(scopedDb, deps)
    );
    expect(first.continuation).toBeDefined();

    const midRun = await accountRow(accountId);
    expect(midRun?.previous_sync?.finishedAt).toBe("2026-09-04T10:00:00.000Z");

    // The continuation chunk records this run's own outcome. Run one must still be the
    // previous run afterwards — a build that copies the snapshot again here would replace
    // it with run two's own half-finished state.
    let outcome = first;
    let guard = 0;
    while (outcome.continuation && guard < 10) {
      guard += 1;
      outcome = await workerContext.withDataContext(context(), (scopedDb) =>
        runGoogleSyncChunk(scopedDb, deps, outcome.continuation)
      );
    }
    expect(outcome.continuation).toBeUndefined();

    const row = await accountRow(accountId);
    expect(row?.last_sync_status).toBe("success");
    expect(row?.last_sync_finished_at?.toISOString()).toBe("2026-09-04T11:00:00.000Z");
    expect(row?.previous_sync).toMatchObject({ status: "success", trigger: "schedule" });
    expect(row?.previous_sync?.finishedAt).toBe("2026-09-04T10:00:00.000Z");
  });

  it("a real Google run that keeps deferring the same message counts it once", async () => {
    const accountId = await createGoogleAccount();
    let attempts = 0;
    // The same message comes back on both the current-day pass and the backfill pass, so one
    // run really does try it twice - which is the case the count must not double.
    const deps = {
      ...googleDeps(accountId, "2026-09-04T13:00:00.000Z"),
      googleClient: {
        listCalendarEvents: async () => [],
        listMessageIds: async () => [{ id: "same-message" }],
        getMessage: async () => ({
          id: "same-message",
          historyId: "H1",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "Subject", value: "Please review" },
              { name: "From", value: "sender@example.test" }
            ],
            body: { data: Buffer.from("Please review this.").toString("base64") }
          }
        })
      },
      emailExtractDeps: {
        runChat: async () => {
          attempts += 1;
          // The assistant is not logged in for the first two tries on this one message.
          if (attempts <= 2) throw new Error("session expired, please log in");
          return { text: JSON.stringify({ category: "fyi", confidence: 0.9, reason: "Note." }) };
        }
      }
    };

    let outcome = await workerContext.withDataContext(context(), (scopedDb) =>
      runGoogleSyncChunk(scopedDb, deps)
    );
    expect(outcome.result.emailDeferred).toBe(1);
    expect(outcome.continuation?.deferredReason).toBe("assistant-login-expired");

    // The second try is the same message again, so the count must stay one, not become two.
    outcome = await workerContext.withDataContext(context(), (scopedDb) =>
      runGoogleSyncChunk(scopedDb, deps, outcome.continuation)
    );
    expect(attempts).toBe(2);
    expect(outcome.result.emailDeferred).toBe(1);

    let guard = 0;
    while (outcome.continuation && guard < 10) {
      guard += 1;
      outcome = await workerContext.withDataContext(context(), (scopedDb) =>
        runGoogleSyncChunk(scopedDb, deps, outcome.continuation)
      );
    }

    // It got through on the third try, so nothing is left waiting on the assistant.
    expect(outcome.continuation).toBeUndefined();
    expect(outcome.result.emailDeferred).toBe(0);
    const row = await accountRow(accountId);
    expect(row?.last_sync_counts).toMatchObject({ emailDeferred: 0 });
  });

  async function accountRow(accountId: string) {
    const accounts = await dataContext.withDataContext(context(), (scopedDb) =>
      repository.listAccounts(scopedDb)
    );
    return accounts.find((account) => account.id === accountId);
  }
});

/** What ImapFlow raises when the mail server refuses the sign-in. */
function imapAuthenticationFailure(): Error {
  const error = new Error("Invalid credentials (Failure)") as Error & {
    authenticationFailed: boolean;
    responseText: string;
  };
  error.name = "AuthenticationFailedError";
  error.authenticationFailed = true;
  error.responseText = "Invalid credentials (Failure)";
  return error;
}

function context(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:sync-worker-runs" };
}
