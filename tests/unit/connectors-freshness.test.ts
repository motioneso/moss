import { describe, expect, it } from "vitest";

import { getConnectorSyncAt } from "../../packages/connectors/src/freshness.js";
import type { ConnectorAccountSafeRow } from "../../packages/connectors/src/repository.js";
import { GMAIL_SCOPE, CALENDAR_SCOPE } from "../../packages/connectors/src/sync-jobs.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const fakeScopedDb = makeRecordingDb().scoped;

function fakeRepo(accounts: Partial<ConnectorAccountSafeRow>[]) {
  return {
    async listAccounts() {
      return accounts as ConnectorAccountSafeRow[];
    }
  } as Parameters<typeof getConnectorSyncAt>[0];
}

const scopedDb = fakeScopedDb;

describe("getConnectorSyncAt", () => {
  it("returns null when no accounts match the kind", async () => {
    const repo = fakeRepo([{ scopes: [], last_sync_finished_at: new Date("2026-06-01") }]);
    expect(await getConnectorSyncAt(repo, scopedDb, "email")).toBeNull();
  });

  it("returns the max last_sync_finished_at for email accounts", async () => {
    const t1 = new Date("2026-06-20T10:00:00Z");
    const t2 = new Date("2026-06-21T08:00:00Z");
    const repo = fakeRepo([
      { scopes: [GMAIL_SCOPE], last_sync_finished_at: t1 },
      { scopes: [GMAIL_SCOPE], last_sync_finished_at: t2 }
    ]);
    expect(await getConnectorSyncAt(repo, scopedDb, "email")).toEqual(t2);
  });

  it("returns the max last_sync_finished_at for calendar accounts", async () => {
    const t = new Date("2026-06-22T06:00:00Z");
    const repo = fakeRepo([
      { scopes: [CALENDAR_SCOPE], last_sync_finished_at: t },
      { scopes: [CALENDAR_SCOPE], last_sync_finished_at: null }
    ]);
    expect(await getConnectorSyncAt(repo, scopedDb, "calendar")).toEqual(t);
  });

  it("returns null when all matching accounts have null last_sync_finished_at", async () => {
    const repo = fakeRepo([{ scopes: [GMAIL_SCOPE], last_sync_finished_at: null }]);
    expect(await getConnectorSyncAt(repo, scopedDb, "email")).toBeNull();
  });

  it("returns null when connectorSyncAt throws", async () => {
    const repo = {
      async listAccounts() {
        throw new Error("network");
      }
    } as Parameters<typeof getConnectorSyncAt>[0];
    expect(await getConnectorSyncAt(repo, scopedDb, "email")).toBeNull();
  });
});
