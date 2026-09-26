import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import {
  ConnectorsRepository,
  EmailRefreshRepository,
  dispatchPendingEmailRefreshJobs,
  featureGrantsPrefKey,
  type EncryptedConnectorSecret
} from "@moss/connectors";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";
import { ids, connectionStrings, resetFoundationDatabase } from "./test-database.js";

const userA: AccessContext = { actorUserId: ids.userA, requestId: "email-refresh:user-a" };
const userB: AccessContext = { actorUserId: ids.userB, requestId: "email-refresh:user-b" };
const testSecret = {} as EncryptedConnectorSecret;

describe("owner-scoped durable email refreshes", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let appContext: DataContextRunner;
  let workerContext: DataContextRunner;
  let connectors: ConnectorsRepository;
  let preferences: PreferencesRepository;
  let refreshes: EmailRefreshRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    appContext = new DataContextRunner(appDb);
    workerContext = new DataContextRunner(workerDb);
    connectors = new ConnectorsRepository();
    preferences = new PreferencesRepository();
    refreshes = new EmailRefreshRepository(connectors, preferences);
  });

  afterAll(async () => {
    await Promise.allSettled([appDb?.destroy(), workerDb?.destroy()]);
  });

  it("filters accounts, deduplicates requests, and persists owner-only aggregate status", async () => {
    const addAccount = async (
      providerId: string,
      scopes: readonly string[],
      status: "active" | "error" = "active"
    ) =>
      appContext.withDataContext(userA, (scopedDb) =>
        connectors.createAccount(scopedDb, {
          providerId,
          scopes,
          status,
          encryptedSecret: testSecret
        })
      );

    const fastmail = await addAccount("imap-fastmail", ["email.read"]);
    const icloud = await addAccount("imap-icloud", ["email.read"]);
    const emailDisabled = await addAccount("imap-yahoo", ["email.read"]);
    const inactiveGoogle = await addAccount("google-email", ["gmail.readonly"], "error");
    await appContext.withDataContext(userA, async (scopedDb) => {
      await preferences.upsert(scopedDb, featureGrantsPrefKey(fastmail.id), { email: true });
      await preferences.upsert(scopedDb, featureGrantsPrefKey(icloud.id), { email: true });
      await preferences.upsert(scopedDb, featureGrantsPrefKey(emailDisabled.id), { email: false });
      await preferences.upsert(scopedDb, featureGrantsPrefKey(inactiveGoogle.id), { email: true });
    });

    const noAccounts = await appContext.withDataContext(userB, (scopedDb) =>
      refreshes.request(scopedDb, "90000000-0000-4000-8000-000000000001")
    );
    expect(noAccounts).toMatchObject({ created: true, deduped: false });
    const noAccountsRetry = await appContext.withDataContext(userB, (scopedDb) =>
      refreshes.request(scopedDb, "90000000-0000-4000-8000-000000000001")
    );
    expect(noAccountsRetry).toEqual({
      refreshId: noAccounts.refreshId,
      created: false,
      deduped: true
    });
    const noAccountsStatus = await appContext.withDataContext(userB, (scopedDb) =>
      refreshes.getStatus(scopedDb, noAccounts.refreshId)
    );
    expect(noAccountsStatus).toMatchObject({ status: "failed", errorCode: "no-eligible-accounts" });
    expect(
      await appContext.withDataContext(userA, (scopedDb) =>
        refreshes.getStatus(scopedDb, noAccounts.refreshId)
      )
    ).toBeUndefined();

    const [accepted, concurrent] = await Promise.all([
      appContext.withDataContext(userA, (scopedDb) =>
        refreshes.request(scopedDb, "90000000-0000-4000-8000-000000000002")
      ),
      appContext.withDataContext(userA, (scopedDb) =>
        refreshes.request(scopedDb, "90000000-0000-4000-8000-000000000003")
      )
    ]);
    expect(accepted.refreshId).toBe(concurrent.refreshId);
    expect([accepted, concurrent].filter((attempt) => attempt.created)).toHaveLength(1);
    expect([accepted, concurrent].filter((attempt) => attempt.deduped)).toHaveLength(1);
    expect(
      await appContext.withDataContext(userA, (scopedDb) =>
        refreshes.request(scopedDb, "90000000-0000-4000-8000-000000000002")
      )
    ).toMatchObject({ refreshId: accepted.refreshId, created: false, deduped: true });
    const status = await appContext.withDataContext(userA, (scopedDb) =>
      refreshes.getStatus(scopedDb, accepted.refreshId)
    );
    expect(status?.status).toBe("queued");
    expect(status?.accounts.map((account) => account.accountId)).toEqual(
      [fastmail.id, icloud.id].sort()
    );

    const flakySend = vi
      .fn()
      .mockResolvedValueOnce("job-1")
      .mockRejectedValueOnce(new Error("queue unavailable"));
    const firstDispatch = await appContext.withDataContext(userA, (scopedDb) =>
      dispatchPendingEmailRefreshJobs(scopedDb, { send: flakySend } as never, ids.userA, refreshes)
    );
    expect(firstDispatch).toBe(1);
    const remaining = await appContext.withDataContext(userA, (scopedDb) =>
      refreshes.listPendingDispatch(scopedDb)
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.dispatch_attempts).toBe(1);

    const retrySend = vi.fn().mockResolvedValue("job-2");
    expect(
      await appContext.withDataContext(userA, (scopedDb) =>
        dispatchPendingEmailRefreshJobs(
          scopedDb,
          { send: retrySend } as never,
          ids.userA,
          refreshes
        )
      )
    ).toBe(1);
    expect(
      await appContext.withDataContext(userA, (scopedDb) => refreshes.listPendingDispatch(scopedDb))
    ).toHaveLength(0);

    for (const [index, account] of status!.accounts.entries()) {
      const outcome =
        index === 0
          ? { status: "succeeded" as const, errorCode: null, emailUpserted: 4, emailFailures: 0 }
          : {
              status: "failed" as const,
              errorCode: "auth-error" as const,
              emailUpserted: 0,
              emailFailures: 1
            };
      await workerContext.withDataContext(userA, async (scopedDb) => {
        expect(await refreshes.startAccount(scopedDb, accepted.refreshId, account.accountId)).toBe(
          true
        );
        await refreshes.finishAccount(scopedDb, accepted.refreshId, account.accountId, outcome);
      });
    }

    const completed = await appContext.withDataContext(userA, (scopedDb) =>
      refreshes.getStatus(scopedDb, accepted.refreshId)
    );
    expect(completed).toMatchObject({
      status: "partial",
      completedAt: expect.any(String),
      errorCode: "auth-error"
    });
    expect(completed?.accounts.map((account) => account.status)).toEqual(["succeeded", "failed"]);
    expect(completed?.accounts.map((account) => account.counts.emailUpserted)).toEqual([4, 0]);
    expect(completed?.accounts.map((account) => account.counts.emailFailures)).toEqual([0, 1]);
  });
});
