import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { emailListVisibleMessagesExecute } from "../../packages/email/src/tools.js";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;
const ctx: ToolContext = { actorUserId: "user-1", requestId: "req-1", chatSessionId: "" };

const account = {
  connectorAccountId: "acc-google",
  providerId: "google",
  providerLabel: "Google"
};

function contextItem(overrides: Record<string, unknown> = {}) {
  return {
    messageKey: "ext-1",
    account,
    sender: "Alice <alice@example.com>",
    recipients: ["ben@example.com"],
    subject: "Hello",
    receivedAt: "2026-07-03T10:00:00.000Z",
    threadId: "thread-1",
    snippet: "Hi Ben",
    summary: "Alice has a quick question.",
    actionability: "needs_reply",
    importance: "normal",
    confidence: 0.8,
    reason: "Direct question.",
    dueDate: null,
    suggestedTasks: [{ title: "Reply to Alice", dueDate: null }],
    source: "live",
    degradedReason: null,
    cacheMessageId: "row-1",
    ...overrides
  };
}

describe("emailListVisibleMessagesExecute (source context)", () => {
  it("fails closed when the sourceContext service is absent", async () => {
    await expect(emailListVisibleMessagesExecute(scopedDb, {}, ctx, {})).rejects.toThrow(
      "sourceContext service is not available"
    );
    await expect(emailListVisibleMessagesExecute(scopedDb, {}, ctx, undefined)).rejects.toThrow(
      "sourceContext service is not available"
    );
  });

  it("serializes items, accounts, and gaps from the service", async () => {
    const listEmailContext = vi.fn(async () => ({
      items: [contextItem()],
      accounts: [{ account, source: "live", degradedReason: null }],
      gaps: [{ account: null, reason: "service_unavailable" }]
    }));
    const services = { sourceContext: { listEmailContext, listCalendarContext: vi.fn() } };
    const result = await emailListVisibleMessagesExecute(scopedDb, {}, ctx, services);
    expect(listEmailContext).toHaveBeenCalledWith(scopedDb, {});
    const data = result.data as {
      messages: Record<string, unknown>[];
      accounts: unknown[];
      gaps: unknown[];
    };
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toEqual({
      id: "ext-1",
      cacheMessageId: "row-1",
      connectorAccountId: "acc-google",
      providerLabel: "Google",
      sender: "Alice <alice@example.com>",
      recipients: ["ben@example.com"],
      subject: "Hello",
      receivedAt: "2026-07-03T10:00:00.000Z",
      threadId: "thread-1",
      snippet: "Hi Ben",
      summary: "Alice has a quick question.",
      actionability: "needs_reply",
      importance: "normal",
      confidence: 0.8,
      reason: "Direct question.",
      dueDate: null,
      suggestedTasks: [{ title: "Reply to Alice", dueDate: null }],
      awaitingJudgement: false,
      source: "live",
      degradedReason: null
    });
    expect(data.accounts).toEqual([{ account, source: "live", degradedReason: null }]);
    expect(data.gaps).toEqual([{ account: null, reason: "service_unavailable" }]);
  });

  it("never exposes body fields even if the service leaks one", async () => {
    const services = {
      sourceContext: {
        listEmailContext: vi.fn(async () => ({
          items: [contextItem({ body: "LEAKED", bodyExcerpt: "LEAKED" })],
          accounts: [],
          gaps: []
        })),
        listCalendarContext: vi.fn()
      }
    };
    const result = await emailListVisibleMessagesExecute(scopedDb, {}, ctx, services);
    const message = (result.data as { messages: Record<string, unknown>[] }).messages[0]!;
    expect("body" in message).toBe(false);
    expect("bodyExcerpt" in message).toBe(false);
  });
});
