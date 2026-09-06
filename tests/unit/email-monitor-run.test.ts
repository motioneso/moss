import { describe, expect, it } from "vitest";

import type { DataContextDb, EmailMessage } from "@moss/db";
import {
  buildGmailThreadLink,
  buildEmailActionLink,
  emailSourceRef,
  EMAIL_TASK_MODE_PREF_KEY,
  listEmailContext,
  MONITOR_STATUS_PREF_KEY,
  runEmailMonitor,
  type ConnectorAccountSafeRow,
  type EmailSourceContextDeps,
  type EmailContextItem,
  type EmailContextResult,
  type MonitorPreferencesPort,
  type RunEmailMonitorDeps
} from "@moss/connectors";

const DB = {} as DataContextDb;
const ACCOUNT = "acct-1";
const NOW = () => new Date("2026-07-04T12:00:00.000Z");

function item(overrides: Partial<EmailContextItem> = {}): EmailContextItem {
  return {
    messageKey: "msg-1",
    account: { connectorAccountId: ACCOUNT, providerId: "google", providerLabel: "Gmail" },
    sender: "boss@work.example",
    recipients: ["me@self.example"],
    subject: "Budget approval needed",
    receivedAt: "2026-07-04T09:00:00.000Z",
    threadId: null,
    sourceHref: "https://mail.google.com/mail/u/0/#all/thread-1",
    snippet: null,
    summary: "Approve the Q3 budget by Friday",
    actionability: "needs_action",
    importance: "normal",
    confidence: 0.9,
    reason: "Asks you to approve the budget",
    inferredSubject: "Budget approval",
    dueDate: null,
    suggestedTasks: [{ title: "Approve Q3 budget", dueDate: "2026-07-10T00:00:00.000Z" }],
    source: "live",
    degradedReason: null,
    cacheMessageId: "cache-msg-1",
    ...overrides
  };
}

function liveResult(items: EmailContextItem[]): EmailContextResult {
  return {
    items,
    accounts: [
      {
        account: { connectorAccountId: ACCOUNT, providerId: "google", providerLabel: "Gmail" },
        source: "live",
        degradedReason: null
      }
    ],
    gaps: []
  };
}

function sourceAccount(id: string): ConnectorAccountSafeRow {
  return {
    id,
    provider_id: "google",
    provider_type: "google",
    provider_display_name: "Gmail",
    provider_status: "available",
    owner_user_id: "user-1",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    status: "active",
    has_secret: true,
    revoked_at: null,
    created_at: new Date("2026-07-04T00:00:00.000Z"),
    updated_at: new Date("2026-07-04T00:00:00.000Z"),
    last_sync_started_at: null,
    last_sync_finished_at: null,
    last_sync_status: null,
    last_sync_error: null,
    last_sync_counts: null
  };
}

function cachedEmail(accountId: string, id: string): EmailMessage {
  return {
    id,
    connector_account_id: accountId,
    owner_user_id: "user-1",
    sender: "boss@work.example",
    recipients: ["me@self.example"],
    subject: "Budget approval needed",
    snippet: null,
    body_excerpt: null,
    received_at: new Date("2026-07-04T09:00:00.000Z"),
    external_id: "shared-provider-message-id",
    external_metadata: { threadId: `thread-${accountId}` },
    summary: `Cached summary for ${accountId}`,
    signals: { actionability: { category: "needs_action" }, confidence: 0.9 },
    created_at: new Date("2026-07-04T09:00:00.000Z"),
    updated_at: new Date("2026-07-04T09:00:00.000Z")
  };
}

interface FakePorts {
  deps: RunEmailMonitorDeps;
  taskStore: Map<string, { status: string; title: string }>;
  prefs: Map<string, unknown>;
}

function fakePorts(result: EmailContextResult, options: { mode?: string } = {}): FakePorts {
  const taskStore = new Map<string, { status: string; title: string }>();
  const prefs = new Map<string, unknown>();
  if (options.mode) {
    prefs.set(EMAIL_TASK_MODE_PREF_KEY, options.mode);
  }
  const preferencesRepository: MonitorPreferencesPort = {
    get: async (_db: DataContextDb, key: string) => prefs.get(key) ?? null,
    upsert: async (_db: DataContextDb, key: string, value: unknown) => {
      prefs.set(key, value);
    }
  };
  const deps: RunEmailMonitorDeps = {
    savedContext: { listEmailContext: async () => result },
    taskPort: {
      // Dedupes on externalKey like TasksRepository.create's (source, external_key) check.
      create: async (_db, input) => {
        const key = input.externalKey ?? `no-key-${taskStore.size}`;
        if (!taskStore.has(key)) {
          taskStore.set(key, { status: input.status, title: input.title });
        }
        return { id: key };
      }
    },
    preferencesRepository,
    now: NOW
  };
  return { deps, taskStore, prefs };
}

describe("runEmailMonitor", () => {
  it("preserves account identity when external message ids collide", async () => {
    const first = sourceAccount("acct-1");
    const second = sourceAccount("acct-2");
    const deps: EmailSourceContextDeps = {
      connectorsRepository: { listAccounts: async () => [first, second] },
      preferencesRepository: { get: async () => null },
      resolveGoogleCredential: async () => "token",
      resolveImapCredential: async () => undefined,
      googleProvider: {
        listFolders: async () => ["INBOX"],
        listMessageKeys: async () => [{ folder: "INBOX", id: "shared-provider-message-id" }],
        getMessage: async () => ({
          externalId: "shared-provider-message-id",
          historyId: null,
          subject: "Budget approval needed",
          from: "boss@work.example",
          recipients: ["me@self.example"],
          receivedAt: "2026-07-04T09:00:00.000Z",
          labelIds: [],
          snippet: null,
          body: "",
          bodyTruncated: false
        })
      },
      imapProvider: {} as EmailSourceContextDeps["imapProvider"],
      emailRepository: {
        listVisibleForBriefing: async () => [
          cachedEmail("acct-1", "cache-1"),
          cachedEmail("acct-2", "cache-2")
        ]
      },
      makeEmailExtractDeps: () => ({
        runChat: async () => ({ text: "{}" })
      })
    };

    const result = await listEmailContext(DB, deps, {});
    expect(
      result.items.map((entry) => [entry.account.connectorAccountId, entry.cacheMessageId])
    ).toEqual([
      ["acct-1", "cache-1"],
      ["acct-2", "cache-2"]
    ]);
  });

  it("keeps source ref cache id and provider link as distinct values", () => {
    const sourceRef = emailSourceRef(ACCOUNT, "shared-provider-message-id");
    const cacheMessageId = "cache-message-row";
    const sourceHref = buildGmailThreadLink({ accountIndex: 0, threadId: "gmail-thread" });

    expect({ sourceRef, cacheMessageId, sourceHref }).toEqual({
      sourceRef: "acct-1:shared-provider-message-id",
      cacheMessageId: "cache-message-row",
      sourceHref: "https://mail.google.com/mail/u/0/#all/gmail-thread"
    });
    expect(sourceRef).not.toBe(cacheMessageId);
    expect(sourceRef).not.toBe(sourceHref);

    expect(buildEmailActionLink({ providerId: "google", threadId: "gmail-thread" })).toBe(
      sourceHref
    );
    expect(buildEmailActionLink({ providerId: "google", threadId: null })).toBeNull();
    expect(buildEmailActionLink({ providerId: "yahoo-imap", threadId: "imap-thread" })).toBeNull();
  });

  it("suggest mode (default) stages suggested tasks and persists an ok status", async () => {
    const { deps, taskStore, prefs } = fakePorts(liveResult([item()]));
    const run = await runEmailMonitor(DB, ACCOUNT, deps);
    expect(run).toEqual({ planned: 1, created: 1, degraded: false, taskFailures: 0 });
    expect([...taskStore.values()]).toEqual([{ status: "suggested", title: "Approve Q3 budget" }]);
    expect(prefs.get(MONITOR_STATUS_PREF_KEY(ACCOUNT))).toEqual({
      lastRunAt: "2026-07-04T12:00:00.000Z",
      status: "ok",
      planned: 1,
      created: 1
    });
  });

  it("second run over the same items creates zero new tasks (externalKey dedupe)", async () => {
    const { deps, taskStore } = fakePorts(liveResult([item()]));
    await runEmailMonitor(DB, ACCOUNT, deps);
    expect(taskStore.size).toBe(1);
    await runEmailMonitor(DB, ACCOUNT, deps);
    expect(taskStore.size).toBe(1);
  });

  it("off mode creates nothing", async () => {
    const { deps, taskStore } = fakePorts(liveResult([item()]), { mode: "off" });
    const run = await runEmailMonitor(DB, ACCOUNT, deps);
    expect(run).toEqual({ planned: 0, created: 0, degraded: false, taskFailures: 0 });
    expect(taskStore.size).toBe(0);
  });

  it("an account gap plans nothing and persists a gap status — no auth-gap tasks", async () => {
    const gapResult: EmailContextResult = {
      items: [],
      accounts: [],
      gaps: [
        {
          account: { connectorAccountId: ACCOUNT, providerId: "google", providerLabel: "Gmail" },
          reason: "auth_error"
        }
      ]
    };
    const { deps, taskStore, prefs } = fakePorts(gapResult);
    const run = await runEmailMonitor(DB, ACCOUNT, deps);
    expect(run).toEqual({ planned: 0, created: 0, degraded: true, taskFailures: 0 });
    expect(taskStore.size).toBe(0);
    expect(prefs.get(MONITOR_STATUS_PREF_KEY(ACCOUNT))).toEqual({
      lastRunAt: "2026-07-04T12:00:00.000Z",
      status: "gap",
      planned: 0,
      created: 0
    });
  });

  it("a cache-fallback read still plans but persists a degraded status", async () => {
    const cacheResult: EmailContextResult = {
      items: [item({ source: "cache", degradedReason: "network_error" })],
      accounts: [
        {
          account: { connectorAccountId: ACCOUNT, providerId: "google", providerLabel: "Gmail" },
          source: "cache",
          degradedReason: "network_error"
        }
      ],
      gaps: []
    };
    const { deps, taskStore, prefs } = fakePorts(cacheResult);
    const run = await runEmailMonitor(DB, ACCOUNT, deps);
    expect(run).toEqual({ planned: 1, created: 1, degraded: true, taskFailures: 0 });
    expect(taskStore.size).toBe(1);
    expect(prefs.get(MONITOR_STATUS_PREF_KEY(ACCOUNT))).toMatchObject({ status: "degraded" });
  });

  it("ignores items and gaps belonging to other accounts", async () => {
    const mixed: EmailContextResult = {
      items: [
        item(),
        item({
          messageKey: "msg-other",
          account: { connectorAccountId: "acct-2", providerId: "imap", providerLabel: "Yahoo" },
          suggestedTasks: [{ title: "Other account task", dueDate: null }]
        })
      ],
      accounts: [
        {
          account: { connectorAccountId: ACCOUNT, providerId: "google", providerLabel: "Gmail" },
          source: "live",
          degradedReason: null
        },
        {
          account: { connectorAccountId: "acct-2", providerId: "imap", providerLabel: "Yahoo" },
          source: "cache",
          degradedReason: "network_error"
        }
      ],
      gaps: [
        {
          account: { connectorAccountId: "acct-2", providerId: "imap", providerLabel: "Yahoo" },
          reason: "auth_error"
        }
      ]
    };
    const { deps, taskStore } = fakePorts(mixed);
    const run = await runEmailMonitor(DB, ACCOUNT, deps);
    expect(run).toEqual({ planned: 1, created: 1, degraded: false, taskFailures: 0 });
    expect([...taskStore.values()].map((t) => t.title)).toEqual(["Approve Q3 budget"]);
  });

  it("persisted status holds counts only — never titles, subjects, or bodies", async () => {
    const { deps, prefs } = fakePorts(liveResult([item({ subject: "SECRET subject line" })]));
    await runEmailMonitor(DB, ACCOUNT, deps);
    const status = JSON.stringify(prefs.get(MONITOR_STATUS_PREF_KEY(ACCOUNT)));
    expect(status).not.toMatch(/SECRET|Approve|budget/i);
  });
});
