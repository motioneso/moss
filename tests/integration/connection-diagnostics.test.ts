import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type DataContextDb, type MossDatabase } from "@moss/db";
import {
  ConnectorsRepository,
  createConnectorSecretCipher,
  outlookHealthKey,
  readConnectionDiagnostics
} from "@moss/connectors";
import { PreferencesRepository } from "@moss/structured-state";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const OUTLOOK_BROWSER_PROVIDER = "outlook-browser-calendar";
const RAW_ERROR = "401 Unauthorized: token abc123-SECRET-MARKER rejected";

describe("connection diagnostics reader", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  const repository = new ConnectorsRepository();
  const prefs = new PreferencesRepository();
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_CONNECTOR_SECRET_KEY;
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb?.destroy();
    if (originalSecretKey === undefined) delete process.env.JARVIS_CONNECTOR_SECRET_KEY;
    else process.env.JARVIS_CONNECTOR_SECRET_KEY = originalSecretKey;
  });

  const as = <T>(actor: string, work: (db: DataContextDb) => Promise<T>) =>
    dataContext.withDataContext({ actorUserId: actor, requestId: "conn-diag" }, work);

  function create(actor: string, providerId: string): Promise<string> {
    return as(actor, async (db) => {
      const account = await repository.createAccount(db, {
        providerId,
        scopes: ["x"],
        encryptedSecret: createConnectorSecretCipher().encryptJson({ accessToken: "a" })
      });
      return account.id;
    });
  }

  it("1. reports a failed sync as status, attempt time and a fixed label, never the raw error", async () => {
    const id = await create(ids.userA, "google-email");
    await as(ids.userA, async (db) => {
      await repository.markSyncStarted(db, id, {
        startedAt: new Date("2026-09-04T10:00:00.000Z"),
        trigger: "schedule"
      });
      await repository.markSyncFinished(db, id, {
        finishedAt: new Date("2026-09-04T10:01:00.000Z"),
        status: "failed",
        error: RAW_ERROR,
        counts: {}
      });
    });
    const section = await as(ids.userA, (db) => readConnectionDiagnostics(db, { limit: 10 }));
    const item = section.items.find((entry) => entry.accountId === id);
    expect(item).toMatchObject({
      provider: "google-email",
      status: "sync-failed",
      lastAttemptAt: "2026-09-04T10:00:00.000Z",
      failureCount: 1
    });
    expect(item?.errorLabel).toBe("auth-error");
    expect(JSON.stringify(section)).not.toContain("SECRET-MARKER");
  });

  it("2. never shows another user's account", async () => {
    const bId = await create(ids.userB, "google-email");
    const aSection = await as(ids.userA, (db) => readConnectionDiagnostics(db, { limit: 10 }));
    expect(aSection.items.some((entry) => entry.accountId === bId)).toBe(false);
    const bSection = await as(ids.userB, (db) => readConnectionDiagnostics(db, { limit: 10 }));
    expect(bSection.items.map((entry) => entry.accountId)).toEqual([bId]);
  });

  it("3. reports a revoked account as revoked, not healthy", async () => {
    const id = await create(ids.userC, "google-email");
    await as(ids.userC, async (db) => {
      await repository.markSyncFinished(db, id, {
        finishedAt: new Date(),
        status: "success",
        error: null,
        counts: {}
      });
      await repository.revokeAccount(db, id, createConnectorSecretCipher().encryptJson({}));
    });
    const section = await as(ids.userC, (db) => readConnectionDiagnostics(db, { limit: 10 }));
    expect(section.items.find((entry) => entry.accountId === id)).toMatchObject({
      status: "revoked",
      errorLabel: "revoked"
    });
  });

  it("4. gives Outlook sign-in-needed and partial distinct labels", async () => {
    const signIn = await create(ids.userD, OUTLOOK_BROWSER_PROVIDER);
    const partial = await create(ids.userC, OUTLOOK_BROWSER_PROVIDER);
    await as(ids.userD, (db) =>
      prefs.upsert(db, outlookHealthKey(signIn), { state: "sign-in-needed" })
    );
    await as(ids.userC, async (db) => {
      await prefs.upsert(db, outlookHealthKey(partial), {
        state: "partial",
        failures: 2,
        attemptedAt: "2026-09-04T11:00:00.000Z",
        lastCompleteAt: "2026-09-04T09:00:00.000Z"
      });
    });
    const signSection = await as(ids.userD, (db) => readConnectionDiagnostics(db, { limit: 10 }));
    const partialSection = await as(ids.userC, (db) =>
      readConnectionDiagnostics(db, { limit: 10 })
    );
    const bySign = signSection.items.find((entry) => entry.accountId === signIn);
    const byPartial = partialSection.items.find((entry) => entry.accountId === partial);
    expect(bySign).toMatchObject({ status: "sign-in-needed", errorLabel: "sign-in-needed" });
    expect(byPartial).toMatchObject({
      status: "partial",
      errorLabel: "scan-incomplete-or-helper-unreachable",
      failureCount: 2,
      lastAttemptAt: "2026-09-04T11:00:00.000Z",
      lastGoodAt: "2026-09-04T09:00:00.000Z"
    });
    expect(bySign?.errorLabel).not.toBe(byPartial?.errorLabel);
  });
});
