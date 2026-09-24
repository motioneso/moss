import { describe, expect, it, vi } from "vitest";

import type { EmailMessage } from "@moss/db";
import type { ConnectorAccountSafeRow } from "../../packages/connectors/src/repository.js";
import type {
  EmailReadProvider,
  MailMessageKey
} from "../../packages/connectors/src/email-read-provider.js";
import type { ParsedEmail } from "../../packages/connectors/src/email-extract.js";
import type { ImapConnectionSecret } from "../../packages/connectors/src/imap-secret.js";
import {
  LIVE_TRIAGE_CAP,
  listEmailContext,
  type EmailSourceContextDeps
} from "../../packages/connectors/src/source-context/email.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const fakeScopedDb = makeRecordingDb().scoped;

const scopedDb = fakeScopedDb;

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

function account(overrides: Partial<ConnectorAccountSafeRow> = {}): ConnectorAccountSafeRow {
  return {
    id: "acc-google",
    provider_id: "google",
    provider_type: "google",
    provider_display_name: "Google",
    provider_status: "active",
    owner_user_id: "user-1",
    scopes: [GMAIL_SCOPE],
    status: "active",
    has_secret: true,
    revoked_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    last_sync_started_at: null,
    last_sync_finished_at: null,
    last_sync_status: null,
    last_sync_error: null,
    last_sync_counts: null,
    ...overrides
  } as ConnectorAccountSafeRow;
}

function imapAccount(overrides: Partial<ConnectorAccountSafeRow> = {}): ConnectorAccountSafeRow {
  return account({
    id: "acc-imap",
    provider_id: "yahoo-imap",
    provider_type: "imap",
    provider_display_name: "Yahoo",
    scopes: ["email.read"],
    ...overrides
  });
}

function parsed(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    externalId: "ext-1",
    threadId: null,
    historyId: null,
    subject: "Hello",
    from: "Alice <alice@example.com>",
    recipients: ["ben@example.com"],
    receivedAt: "2026-07-03T10:00:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Hi Ben",
    body: "Hi Ben, quick question about the plan.",
    bodyTruncated: false,
    ...overrides
  };
}

function cachedRow(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "row-1",
    connector_account_id: "acc-google",
    owner_user_id: "user-1",
    sender: "Alice <alice@example.com>",
    recipients: ["ben@example.com"],
    subject: "Hello",
    snippet: "Hi Ben",
    body_excerpt: null,
    received_at: new Date("2026-07-03T10:00:00.000Z"),
    external_id: "ext-1",
    external_metadata: { threadId: "thread-1" },
    summary: "Alice has a quick question.",
    signals: {
      importance: "normal",
      confidence: 0.8,
      actionability: {
        category: "needs_reply",
        reason: "Direct question.",
        inferredSubject: "Quick question",
        suggestedTasks: [{ text: "Reply to Alice" }]
      }
    },
    created_at: new Date("2026-07-03T10:00:05.000Z"),
    updated_at: new Date("2026-07-03T10:00:05.000Z"),
    ...overrides
  } as EmailMessage;
}

function fakeProvider<TCredential>(
  messages: ParsedEmail[],
  options: {
    listError?: () => Error;
    getError?: (key: MailMessageKey) => Error | undefined;
  } = {}
): EmailReadProvider<TCredential> & { listCalls: number } {
  const provider = {
    listCalls: 0,
    async listFolders() {
      return ["INBOX"];
    },
    async listMessageKeys() {
      provider.listCalls += 1;
      if (options.listError) throw options.listError();
      return messages.map((message) => ({ folder: "INBOX", id: message.externalId }));
    },
    async getMessage(_credential: TCredential, key: MailMessageKey) {
      const maybeError = options.getError?.(key);
      if (maybeError) throw maybeError;
      const found = messages.find((message) => message.externalId === key.id);
      if (!found) throw new Error(`no such message ${key.id}`);
      return found;
    }
  };
  return provider;
}

const IMAP_SECRET: ImapConnectionSecret = {
  kind: "imap-password",
  providerId: "yahoo-imap",
  username: "ben",
  password: "pw",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapTls: true,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecurity: "implicit_tls"
};

function makeDeps(overrides: Partial<EmailSourceContextDeps> = {}): EmailSourceContextDeps & {
  runChat: ReturnType<typeof vi.fn>;
} {
  const runChat = vi.fn(async () => ({
    text: JSON.stringify({
      summary: "Fresh triage summary.",
      billsDue: [],
      actionItems: [],
      deadlines: [],
      mayGetLostInShuffle: false,
      importance: "normal",
      confidence: 0.7,
      actionability: { category: "fyi", reason: "Informational." }
    })
  }));
  return {
    runChat,
    connectorsRepository: { listAccounts: async () => [account()] },
    preferencesRepository: { get: async () => null },
    resolveGoogleCredential: async () => "token-1",
    resolveImapCredential: async () => IMAP_SECRET,
    googleProvider: fakeProvider<string>([parsed()]),
    imapProvider: fakeProvider<ImapConnectionSecret>([]),
    emailRepository: { listVisibleForBriefing: async () => [cachedRow()] },
    makeEmailExtractDeps: () => ({
      runChat
    }),
    now: () => new Date("2026-07-03T12:00:00.000Z"),
    ...overrides
  };
}

describe("listEmailContext", () => {
  it("reads Google and IMAP accounts live", async () => {
    const deps = makeDeps({
      connectorsRepository: { listAccounts: async () => [account(), imapAccount()] },
      googleProvider: fakeProvider<string>([parsed()]),
      imapProvider: fakeProvider<ImapConnectionSecret>([
        parsed({
          externalId: "imap-1",
          subject: "Yahoo mail",
          receivedAt: "2026-07-03T11:00:00.000Z"
        })
      ]),
      emailRepository: { listVisibleForBriefing: async () => [] }
    });
    const result = await listEmailContext(scopedDb, deps, {});
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.source === "live")).toBe(true);
    expect(result.items[0]?.messageKey).toBe("imap-1"); // newest first
    expect(result.accounts).toEqual([
      {
        account: {
          connectorAccountId: "acc-google",
          providerId: "google",
          providerLabel: "Google"
        },
        source: "live",
        degradedReason: null
      },
      {
        account: {
          connectorAccountId: "acc-imap",
          providerId: "yahoo-imap",
          providerLabel: "Yahoo"
        },
        source: "live",
        degradedReason: null
      }
    ]);
    expect(result.gaps).toEqual([]);
  });

  it("falls back to cache for one account on a transient failure without touching the other", async () => {
    const imapRow = cachedRow({
      id: "row-imap",
      connector_account_id: "acc-imap",
      external_id: "imap-cached-1",
      subject: "Cached yahoo mail"
    });
    const deps = makeDeps({
      connectorsRepository: { listAccounts: async () => [account(), imapAccount()] },
      googleProvider: fakeProvider<string>([parsed()]),
      imapProvider: fakeProvider<ImapConnectionSecret>([], {
        listError: () => new Error("read ECONNRESET")
      }),
      emailRepository: { listVisibleForBriefing: async () => [imapRow] }
    });
    const result = await listEmailContext(scopedDb, deps, {});
    const cacheItems = result.items.filter((item) => item.source === "cache");
    expect(cacheItems).toHaveLength(1);
    expect(cacheItems[0]?.messageKey).toBe("imap-cached-1");
    expect(cacheItems[0]?.degradedReason).toBe("network_error");
    expect(cacheItems[0]?.cacheMessageId).toBe("row-imap");
    expect(cacheItems[0]?.actionability).toBe("needs_reply"); // persisted signals reused
    const liveItems = result.items.filter((item) => item.source === "live");
    expect(liveItems).toHaveLength(1);
    expect(
      result.accounts.find((entry) => entry.account.connectorAccountId === "acc-imap")
    ).toMatchObject({ source: "cache", degradedReason: "network_error" });
    expect(result.gaps).toEqual([]);
  });

  it("surfaces an auth gap with ZERO cache items after a failed forced retry", async () => {
    const unauthorized = () => {
      const error = new Error("unauthorized") as Error & { statusCode: number };
      error.statusCode = 401;
      return error;
    };
    const provider = fakeProvider<string>([], { listError: unauthorized });
    const resolveGoogleCredential = vi.fn(async () => "token");
    const deps = makeDeps({
      googleProvider: provider,
      resolveGoogleCredential,
      emailRepository: { listVisibleForBriefing: async () => [cachedRow()] }
    });
    const result = await listEmailContext(scopedDb, deps, {});
    expect(result.items).toEqual([]);
    expect(result.gaps).toEqual([
      {
        account: {
          connectorAccountId: "acc-google",
          providerId: "google",
          providerLabel: "Google"
        },
        reason: "auth_error"
      }
    ]);
    expect(provider.listCalls).toBe(2); // one forced-refresh retry
    expect(resolveGoogleCredential).toHaveBeenCalledWith(scopedDb, { force: true });
  });

  it("reports feature_grant_disabled without attempting a read", async () => {
    const provider = fakeProvider<string>([parsed()]);
    const deps = makeDeps({
      googleProvider: provider,
      preferencesRepository: { get: async () => ({ email: false, calendar: true }) }
    });
    const result = await listEmailContext(scopedDb, deps, {});
    expect(result.items).toEqual([]);
    expect(result.gaps).toEqual([
      {
        account: expect.objectContaining({ connectorAccountId: "acc-google" }),
        reason: "feature_grant_disabled"
      }
    ]);
    expect(provider.listCalls).toBe(0);
  });

  it("reports connector_revoked for a revoked account", async () => {
    const deps = makeDeps({
      connectorsRepository: { listAccounts: async () => [account({ status: "revoked" })] }
    });
    const result = await listEmailContext(scopedDb, deps, {});
    expect(result.items).toEqual([]);
    expect(result.gaps).toEqual([
      {
        account: expect.objectContaining({ connectorAccountId: "acc-google" }),
        reason: "connector_revoked"
      }
    ]);
  });

  it("reuses cached triage without calling the model and marks beyond-cap items unknown", async () => {
    const cachedMessage = parsed({ externalId: "ext-1" });
    const uncached = Array.from({ length: LIVE_TRIAGE_CAP + 3 }, (_, index) =>
      parsed({
        externalId: `fresh-${index}`,
        receivedAt: `2026-07-03T0${Math.min(index, 9)}:00:00.000Z`
      })
    );
    const deps = makeDeps({
      googleProvider: fakeProvider<string>([cachedMessage, ...uncached]),
      emailRepository: { listVisibleForBriefing: async () => [cachedRow()] }
    });
    const result = await listEmailContext(scopedDb, deps, {});
    const reused = result.items.find((item) => item.messageKey === "ext-1");
    expect(reused?.actionability).toBe("needs_reply");
    expect(reused?.summary).toBe("Alice has a quick question.");
    expect(reused?.cacheMessageId).toBe("row-1");
    expect(reused?.threadId).toBe("thread-1");
    // model ran only for uncached messages, capped at LIVE_TRIAGE_CAP
    expect(deps.runChat).toHaveBeenCalledTimes(LIVE_TRIAGE_CAP);
    const unknownItems = result.items.filter((item) => item.actionability === "unknown");
    expect(unknownItems).toHaveLength(3);
    for (const item of unknownItems) {
      expect(item.confidence).toBe(0);
      expect(item.summary).toBeNull();
    }
  });

  it("never exposes a body and keeps summaries bounded", async () => {
    const deps = makeDeps({
      googleProvider: fakeProvider<string>([parsed({ body: "SECRET BODY ".repeat(200) })]),
      emailRepository: { listVisibleForBriefing: async () => [] }
    });
    const result = await listEmailContext(scopedDb, deps, {});
    expect(result.items).toHaveLength(1);
    const item = result.items[0] as unknown as Record<string, unknown>;
    expect("body" in item).toBe(false);
    expect(String(item.summary ?? "").length).toBeLessThanOrEqual(600);
  });
});
