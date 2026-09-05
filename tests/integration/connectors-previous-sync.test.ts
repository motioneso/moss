import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("connector sync records a trigger and a previous-run snapshot (#2239 slice 1)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ConnectorsRepository;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_CONNECTOR_SECRET_KEY;
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";

    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new ConnectorsRepository();
  });

  afterAll(async () => {
    await appDb?.destroy();
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_CONNECTOR_SECRET_KEY;
    } else {
      process.env.JARVIS_CONNECTOR_SECRET_KEY = originalSecretKey;
    }
  });

  async function createTestAccount(): Promise<string> {
    const account = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createAccount(scopedDb, {
        providerId: "google-email",
        scopes: ["gmail.readonly"],
        encryptedSecret: createConnectorSecretCipher().encryptJson({ accessToken: "a" })
      })
    );
    return account.id;
  }

  it("records who started the run and clears the prior status while it runs", async () => {
    const accountId = await createTestAccount();
    const startedAt = new Date("2026-09-04T10:00:00.000Z");

    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncStarted(scopedDb, accountId, { startedAt, trigger: "manual" })
    );

    const row = await getAccountById(dataContext, repository, accountId);

    expect(row?.last_sync_started_at?.toISOString()).toBe(startedAt.toISOString());
    expect(row?.last_sync_status).toBeNull();
    expect(row?.last_sync_trigger).toBe("manual");
    expect(row?.previous_sync).toBeFalsy();
  });

  it("keeps no previous-run snapshot after the very first finished run", async () => {
    const accountId = await createTestAccount();
    const startedAt = new Date("2026-09-04T10:00:00.000Z");
    const finishedAt = new Date("2026-09-04T10:05:00.000Z");

    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncStarted(scopedDb, accountId, { startedAt, trigger: "schedule" })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncFinished(scopedDb, accountId, {
        finishedAt,
        status: "success",
        error: null,
        counts: { calendarUpserted: 3, emailUpserted: 40 }
      })
    );

    const row = await getAccountById(dataContext, repository, accountId);

    expect(row?.last_sync_status).toBe("success");
    expect(row?.previous_sync).toBeFalsy();
  });

  it("copies the finished run into previous_sync before the next run overwrites it", async () => {
    const accountId = await createTestAccount();

    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncStarted(scopedDb, accountId, {
        startedAt: new Date("2026-09-04T10:00:00.000Z"),
        trigger: "schedule"
      })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncFinished(scopedDb, accountId, {
        finishedAt: new Date("2026-09-04T10:05:00.000Z"),
        status: "success",
        error: null,
        counts: { calendarUpserted: 3, emailUpserted: 40 }
      })
    );

    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncStarted(scopedDb, accountId, {
        startedAt: new Date("2026-09-04T11:00:00.000Z"),
        trigger: "manual"
      })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncFinished(scopedDb, accountId, {
        finishedAt: new Date("2026-09-04T11:02:00.000Z"),
        status: "failed",
        error: "auth-error",
        counts: {}
      })
    );

    const row = await getAccountById(dataContext, repository, accountId);

    expect(row?.last_sync_status).toBe("failed");
    expect(row?.last_sync_error).toBe("auth-error");
    expect(row?.previous_sync).toMatchObject({
      status: "success",
      errorCode: null,
      trigger: "schedule",
      counts: { calendarUpserted: 3, emailUpserted: 40 }
    });
    expect(row?.previous_sync?.finishedAt).toBe("2026-09-04T10:05:00.000Z");
  });

  it("keeps an already-populated previous_sync through a mid-run continuation chunk", async () => {
    const accountId = await createTestAccount();

    // Run one: succeeds. Run two: starts, so run one becomes the previous run.
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncStarted(scopedDb, accountId, {
        startedAt: new Date("2026-09-04T09:00:00.000Z"),
        trigger: "schedule"
      })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncFinished(scopedDb, accountId, {
        finishedAt: new Date("2026-09-04T09:05:00.000Z"),
        status: "success",
        error: null,
        counts: { calendarUpserted: 7, emailUpserted: 11 }
      })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncStarted(scopedDb, accountId, {
        startedAt: new Date("2026-09-04T10:00:00.000Z"),
        trigger: "manual"
      })
    );
    const beforeRow = await getAccountById(dataContext, repository, accountId);
    expect(beforeRow?.previous_sync).toMatchObject({ status: "success" });

    // A later chunk of that still-running sync records its own outcome. The good run from
    // 09:05 must survive it — this is the case that catches a change which clears it.
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markSyncFinished(scopedDb, accountId, {
        finishedAt: new Date("2026-09-04T10:02:00.000Z"),
        status: "failed",
        error: "auth-error",
        counts: {}
      })
    );

    const row = await getAccountById(dataContext, repository, accountId);

    expect(row?.last_sync_status).toBe("failed");
    expect(row?.previous_sync).toMatchObject({
      status: "success",
      trigger: "schedule",
      counts: { calendarUpserted: 7, emailUpserted: 11 }
    });
    expect(row?.previous_sync?.finishedAt).toBe("2026-09-04T09:05:00.000Z");
  });
});

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-previous-sync"
  };
}

async function getAccountById(
  dataContext: DataContextRunner,
  repository: ConnectorsRepository,
  accountId: string
) {
  const accounts = await dataContext.withDataContext(userAContext(), (scopedDb) =>
    repository.listAccounts(scopedDb)
  );
  return accounts.find((account) => account.id === accountId);
}
