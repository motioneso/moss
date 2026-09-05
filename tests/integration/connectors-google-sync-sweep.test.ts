import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { sql, type Kysely } from "kysely";
import {
  CALENDAR_SCOPE,
  ConnectorsRepository,
  GMAIL_SCOPE,
  GOOGLE_SYNC_QUEUE,
  createConnectorSecretCipher,
  handleGoogleSyncSweepJob,
  listConnectedGoogleCalendarAccounts,
  type ConnectorAccountSafeRow
} from "@moss/connectors";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Runs first (declaration order, no shuffle configured — vitest.config.ts) against a
// database with no connector accounts at all, so it must not depend on any other test's
// state. Every other test below explicitly revokes what it connects in its own cleanup.
describe("google sync sweep (#792)", () => {
  let appDb: Kysely<MossDatabase>;
  let rootDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ConnectorsRepository;
  const userA = (): AccessContext => ({ actorUserId: ids.userA, requestId: "req:a" });
  const userB = (): AccessContext => ({ actorUserId: ids.userB, requestId: "req:b" });

  beforeAll(async () => {
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    rootDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    repository = new ConnectorsRepository();
  });
  afterAll(async () => {
    await appDb?.destroy();
    await rootDb?.destroy();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeBoss() {
    const send = vi.fn().mockResolvedValue("job-id");
    return { send, boss: { send } as unknown as Parameters<typeof handleGoogleSyncSweepJob>[1] };
  }

  async function connectGoogleAccount(
    actor: AccessContext,
    scopes: readonly string[]
  ): Promise<ConnectorAccountSafeRow> {
    const cipher = createConnectorSecretCipher();
    return dataContext.withDataContext(actor, (db) =>
      repository.upsertGoogleAccount(db, {
        scopes,
        encryptedSecret: cipher.encryptJson({ kind: "google-oauth", accessToken: "at" })
      })
    );
  }

  async function revokeGoogleAccount(actor: AccessContext, accountId: string): Promise<void> {
    const cipher = createConnectorSecretCipher();
    await dataContext.withDataContext(actor, (db) =>
      repository.revokeAccount(
        db,
        accountId,
        cipher.encryptJson({ kind: "google-oauth", accessToken: "revoked" })
      )
    );
  }

  it("enqueues nothing when no accounts are connected", async () => {
    const { send, boss } = fakeBoss();

    await handleGoogleSyncSweepJob({ data: { kind: "google-sync-sweep" } } as never, boss, rootDb);

    expect(send).not.toHaveBeenCalled();
    expect(await listConnectedGoogleCalendarAccounts(rootDb)).toEqual([]);
  });

  it("keeps direct connector_accounts SELECT under jarvis_worker_runtime owner-scoped — only the SECURITY DEFINER function bypasses RLS", async () => {
    // 0143 grants EXECUTE on the sweep's SECURITY DEFINER function to jarvis_worker_runtime
    // only (never jarvis_app_runtime), and its RLS bypass policy is scoped to the function's
    // owning role (jarvis_migration_owner) alone. This proves the bypass doesn't leak to
    // ordinary jarvis_worker_runtime table access: with no actor context set on the raw
    // worker connection, a ordinary SELECT against app.connector_accounts must still return
    // zero rows even though a matching account exists.
    const account = await connectGoogleAccount(userA(), [CALENDAR_SCOPE]);
    try {
      const direct = await sql<{ id: string }>`
        SELECT id FROM app.connector_accounts WHERE id = ${account.id}
      `.execute(rootDb);
      expect(direct.rows).toEqual([]);
    } finally {
      await revokeGoogleAccount(userA(), account.id);
    }
  });

  it("lists only active, calendar-scoped google accounts, excluding gmail-only and revoked ones", async () => {
    const calendarAccount = await connectGoogleAccount(userA(), [CALENDAR_SCOPE, GMAIL_SCOPE]);
    await connectGoogleAccount(userB(), [GMAIL_SCOPE]);

    try {
      const accounts = await listConnectedGoogleCalendarAccounts(rootDb);
      expect(accounts.map((a) => a.actorUserId)).toEqual([ids.userA]);

      await revokeGoogleAccount(userA(), calendarAccount.id);
      expect(await listConnectedGoogleCalendarAccounts(rootDb)).toEqual([]);
    } finally {
      // userB's gmail-only account is never calendar-scoped, so nothing else to revoke;
      // reactivate + revoke userA's row so later tests start from a clean slate.
      await connectGoogleAccount(userA(), [CALENDAR_SCOPE]);
      await revokeGoogleAccount(userA(), calendarAccount.id);
    }
  });

  it("never returns scopes, tokens, or secrets — only id and actorUserId", async () => {
    const account = await connectGoogleAccount(userA(), [CALENDAR_SCOPE]);
    try {
      const [row] = await listConnectedGoogleCalendarAccounts(rootDb);
      expect(row).toBeDefined();
      expect(Object.keys(row as object).sort()).toEqual(["actorUserId", "id"]);
    } finally {
      await revokeGoogleAccount(userA(), account.id);
    }
  });

  it("enqueues a metadata-only GOOGLE_SYNC_QUEUE job per connected calendar account, matching the connect/manual-sync payload shape", async () => {
    const accountA = await connectGoogleAccount(userA(), [CALENDAR_SCOPE]);
    const accountB = await connectGoogleAccount(userB(), [CALENDAR_SCOPE, GMAIL_SCOPE]);

    try {
      const { send, boss } = fakeBoss();

      await handleGoogleSyncSweepJob(
        { data: { kind: "google-sync-sweep" } } as never,
        boss,
        rootDb
      );

      expect(send).toHaveBeenCalledTimes(2);
      const calls = send.mock.calls
        .map((call) => {
          const [queue, payload, options] = call as [string, Record<string, unknown>, unknown];
          return { queue, payload, options };
        })
        .sort((a, b) =>
          (a.payload.actorUserId as string).localeCompare(b.payload.actorUserId as string)
        );

      for (const call of calls) {
        expect(call.queue).toBe(GOOGLE_SYNC_QUEUE);
        expect(Object.keys(call.payload).sort()).toEqual([
          "actorUserId",
          "idempotencyKey",
          "kind",
          "trigger"
        ]);
        expect(call.payload.kind).toBe("google-sync");
      }
      const [callForA, callForB] = calls;
      expect(callForA?.payload.actorUserId).toBe(ids.userA);
      expect(callForA?.options).toEqual({ singletonKey: ids.userA });
      expect(callForB?.payload.actorUserId).toBe(ids.userB);
      expect(callForB?.options).toEqual({ singletonKey: ids.userB });
    } finally {
      await revokeGoogleAccount(userA(), accountA.id);
      await revokeGoogleAccount(userB(), accountB.id);
    }
  });
});
