import { describe, expect, it } from "vitest";

import { composeBriefing } from "../../packages/briefings/src/compose.js";
import { composeEveningBriefing } from "../../packages/briefings/src/compose-evening.js";
import {
  buildEmailCatchUp,
  catchUpWindowSince,
  gatherActionRows,
  projectActionRows
} from "../../packages/briefings/src/action-rows.js";
import {
  FIXED_NOW,
  definition,
  fakeScopedDb,
  makeFakeDeps,
  makeStructuredTaskDeps,
  runInput
} from "./briefings-compose.harness.js";
import type { ComposeDeps } from "../../packages/briefings/src/compose.js";

describe("structured briefing action rows", () => {
  it("returns rows beside prose and excludes their tasks and emails from prose", async () => {
    const captured: string[] = [];
    const deps = makeStructuredTaskDeps(
      makeFakeDeps({
        generateChat: async (input) => {
          captured.push(input.messages[0]!.content);
          return { text: "synth narrative" };
        }
      })
    );
    const result = await composeBriefing(fakeScopedDb, definition(), runInput, deps);

    expect(result.structuredPayload.actionRows).toHaveLength(1);
    expect(result.structuredPayload.actionRows[0]?.taskId).toBe("task-row");
    expect(captured[0]).not.toContain("Reply row title");
    expect(captured[0]).not.toContain("Row email");
    expect(captured[0]).toContain("Prose task");
  });

  it("morning and evening use the same row projector", async () => {
    const deps = makeStructuredTaskDeps(makeFakeDeps());
    const morning = await composeBriefing(fakeScopedDb, definition(), runInput, deps);
    const evening = await composeEveningBriefing(
      fakeScopedDb,
      definition({ briefing_type: "evening" }),
      runInput,
      deps
    );

    expect(evening.structuredPayload.actionRows).toEqual(morning.structuredPayload.actionRows);
  });

  it("counts cached linkless rows and omits rows without a source", () => {
    const result = projectActionRows([
      { id: "missing-source", sourceRef: null, suggestionMetadata: null },
      {
        id: "missing-cache",
        title: "No cache",
        description: null,
        dueAt: null,
        updatedAt: null,
        source: "email",
        sourceRef: "acct:missing-cache",
        suggestionMetadata: {
          version: 1,
          category: "time_sensitive_info",
          sourceLabel: "Gmail",
          sourceHref: "https://mail.example.test/thread",
          cacheMessageId: null,
          subjectSignature: "sig-missing-cache",
          computedAt: FIXED_NOW.toISOString(),
          resurfaceReason: null
        }
      },
      {
        id: "null-source",
        title: "Null source",
        description: null,
        dueAt: null,
        updatedAt: null,
        source: "email",
        sourceRef: null,
        suggestionMetadata: {
          version: 1,
          category: "needs_reply",
          sourceLabel: "Gmail",
          sourceHref: null,
          cacheMessageId: "cache-null-source",
          subjectSignature: "sig-null-source",
          computedAt: FIXED_NOW.toISOString(),
          resurfaceReason: null
        }
      },
      {
        id: "empty-source",
        title: "Empty source",
        description: null,
        dueAt: null,
        updatedAt: null,
        source: "email",
        sourceRef: "",
        suggestionMetadata: {
          version: 1,
          category: "needs_reply",
          sourceLabel: "Gmail",
          sourceHref: null,
          cacheMessageId: "cache-empty-source",
          subjectSignature: "sig-empty-source",
          computedAt: FIXED_NOW.toISOString(),
          resurfaceReason: null
        }
      },
      {
        id: "missing-link",
        title: "No link",
        description: "  ",
        dueAt: null,
        updatedAt: null,
        source: "email",
        sourceRef: "acct:message",
        suggestionMetadata: {
          version: 1,
          category: "needs_action",
          sourceLabel: "IMAP",
          sourceHref: null,
          cacheMessageId: "cache-imap",
          subjectSignature: "sig",
          computedAt: FIXED_NOW.toISOString(),
          resurfaceReason: null
        }
      }
    ]);

    expect(result.payload.actionRows).toHaveLength(1);
    expect(result.payload.actionRows[0]).toMatchObject({
      taskId: "missing-link",
      explanation: "This email may need your attention.",
      primaryAction: null,
      sourceHref: null
    });
    expect(result.sourceRefs).toEqual(new Set(["acct:message"]));
  });

  it("logs only the action-row stage and error class when tasks.list fails", async () => {
    const logs: unknown[][] = [];
    const deps = {
      ...makeFakeDeps({ failTool: "tasks.list" }),
      logger: { error: (...args: unknown[]) => logs.push(args) }
    } as unknown as ComposeDeps;
    const gaps: Parameters<typeof gatherActionRows>[4] = [];

    const result = await gatherActionRows(fakeScopedDb, definition(), runInput, deps, gaps);

    expect(result.payload.actionRows).toEqual([]);
    expect(gaps).toEqual([{ source: "action_rows", reason: "structured_payload_failed" }]);
    expect(logs[0]?.[0]).toEqual({ stage: "action-row-gather", name: "Error" });
    expect(JSON.stringify(logs)).not.toContain("message");
    expect(JSON.stringify(logs)).not.toContain("private");
  });

  it("records a sanitized invalid-metadata metric while omitting malformed rows", async () => {
    const logs: unknown[][] = [];
    const base = makeFakeDeps();
    const deps = {
      ...base,
      logger: { error: (...args: unknown[]) => logs.push(args) },
      moduleManifests: base.moduleManifests.map((manifest) => ({
        ...manifest,
        assistantTools: (manifest.assistantTools ?? []).map((tool) =>
          tool.name === "tasks.list"
            ? {
                ...tool,
                execute: async () => ({
                  data: { items: [{ id: "bad-row", suggestionMetadata: { private: "content" } }] }
                })
              }
            : tool
        )
      }))
    } as unknown as ComposeDeps;
    const gaps: Parameters<typeof gatherActionRows>[4] = [];

    const result = await gatherActionRows(fakeScopedDb, definition(), runInput, deps, gaps);

    expect(result.payload.actionRows).toEqual([]);
    expect(gaps).toEqual([]);
    expect(logs[0]?.[0]).toEqual({
      stage: "action-row-projection",
      name: "InvalidSuggestionMetadata",
      count: 1
    });
    expect(JSON.stringify(logs)).not.toContain("private");
  });

  const since = new Date("2026-06-13T07:00:00.000Z");
  const asOf = new Date("2026-06-13T12:30:00.000Z");
  const mail = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    connectorAccountId: "acct",
    sender: `${id} <${id}@example.com>`,
    receivedAt: "2026-06-13T09:00:00.000Z",
    actionability: "fyi",
    importance: "normal",
    summary: `${id} summary`,
    cacheMessageId: `row-${id}`,
    sourceHref: null,
    bulk: false,
    ...overrides
  });
  const digest = (items: readonly Record<string, unknown>[], excluded: string[] = []) =>
    buildEmailCatchUp(
      fakeScopedDb,
      items,
      new Set(excluded),
      async () => asOf,
      catchUpWindowSince(since)
    );

  it("lists important informational mail with sender, summary, reason and a hashed id", async () => {
    const catchUp = await digest(
      [
        mail("row"),
        mail("plain", {
          sender: '"Priya Raman" <priya@example.com>',
          sourceHref: "https://mail.example.com/p"
        }),
        mail("waiting", { actionability: "waiting_on_someone", sender: "hollis@example.com" })
      ],
      ["acct:row"]
    );

    expect(catchUp).toMatchObject({
      source: "email",
      itemCount: 2,
      since: since.toISOString(),
      leftOutCount: 0,
      asOf: asOf.toISOString()
    });
    expect(catchUp?.entries).toEqual([
      {
        id: expect.stringMatching(/^email-digest:[0-9a-f]{16}$/),
        senderName: "hollis",
        summary: "waiting summary",
        receivedAt: "2026-06-13T09:00:00.000Z",
        reason: "waiting_on_them",
        cacheMessageId: "row-waiting",
        openHref: null
      },
      {
        id: expect.stringMatching(/^email-digest:[0-9a-f]{16}$/),
        senderName: "Priya Raman",
        summary: "plain summary",
        receivedAt: "2026-06-13T09:00:00.000Z",
        reason: null,
        cacheMessageId: "row-plain",
        openHref: "https://mail.example.com/p"
      }
    ]);
    expect(JSON.stringify(catchUp)).not.toContain("acct:");
  });

  it("keeps the entry id stable for the same message across runs", async () => {
    const first = await digest([mail("same")]);
    const second = await digest([mail("same", { summary: "reworded" })]);
    expect(first?.entries[0]?.id).toBe(second?.entries[0]?.id);
  });

  it("leaves out low-importance, list, receipt and noise mail and counts them", async () => {
    const catchUp = await digest(
      [
        mail("keep"),
        mail("low", { importance: "low" }),
        mail("list", { bulk: true }),
        mail("list-high", { bulk: true, importance: "high" }),
        mail("receipt", { actionability: "receipt_or_notice" }),
        mail("noise", { actionability: "noise" }),
        mail("unsorted", { actionability: "unknown" }),
        mail("reply", { actionability: "needs_reply" }),
        mail("no-summary", { summary: "  " }),
        mail("closer-look", { awaitingJudgement: true }),
        mail("noise-row", { actionability: "noise" })
      ],
      ["acct:noise-row"]
    );

    expect(catchUp?.entries.map((entry) => entry.summary)).toEqual([
      "list-high summary",
      "keep summary"
    ]);
    expect(catchUp?.entries[0]?.reason).toBe("important");
    expect(catchUp?.leftOutCount).toBe(4);
  });

  it("only covers mail inside the window", async () => {
    const catchUp = await digest([
      mail("before", { receivedAt: "2026-06-13T06:59:59.000Z", actionability: "noise" }),
      mail("old", { receivedAt: "2026-06-12T09:00:00.000Z" }),
      mail("undated", { receivedAt: "not a date" }),
      mail("fresh", { receivedAt: "2026-06-13T07:00:00.000Z" })
    ]);
    expect(catchUp?.entries.map((entry) => entry.summary)).toEqual(["fresh summary"]);
    expect(catchUp?.leftOutCount).toBe(0);
  });

  it("orders important first, then waiting on them, then newest, capped at eight", async () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      mail(`fyi-${index}`, { receivedAt: `2026-06-13T1${index}:00:00.000Z` })
    );
    const catchUp = await digest([
      ...items,
      mail("waiting", {
        actionability: "waiting_on_someone",
        receivedAt: "2026-06-13T08:00:00.000Z"
      }),
      mail("important", { importance: "high", receivedAt: "2026-06-13T07:30:00.000Z" })
    ]);
    expect(catchUp?.entries.map((entry) => entry.summary)).toEqual([
      "important summary",
      "waiting summary",
      "fyi-9 summary",
      "fyi-8 summary",
      "fyi-7 summary",
      "fyi-6 summary",
      "fyi-5 summary",
      "fyi-4 summary"
    ]);
    expect(catchUp?.itemCount).toBe(8);
  });

  it("decodes HTML entities in summaries and sender names", async () => {
    const catchUp = await digest([
      mail("amp", {
        sender: "Smith &amp; Sons <hello@example.com>",
        summary: "Quote for the deck &amp; railing &#8211; &quot;final&quot;\n  price"
      })
    ]);
    expect(catchUp?.entries[0]).toMatchObject({
      senderName: "Smith & Sons",
      summary: 'Quote for the deck & railing \u2013 "final" price'
    });
  });

  it("drops provider links that are not https", async () => {
    const catchUp = await digest([
      mail("http", { sourceHref: "http://mail.example.com/x" }),
      mail("script", { sourceHref: "javascript:alert(1)" }),
      mail("junk", { sourceHref: "not a url" })
    ]);
    expect(catchUp?.entries.map((entry) => entry.openHref)).toEqual([null, null, null]);
  });

  it("omits catch-up when nothing important arrived", async () => {
    await expect(digest([mail("noise", { actionability: "noise" })])).resolves.toBeNull();
  });
});
