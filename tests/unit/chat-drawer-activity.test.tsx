// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatMessageDto, TranscriptRecord } from "@moss/shared";
import { Thread, activityVerb, groupRecords } from "@moss/ui";
import { recordsFromMessages } from "../../apps/web/src/chat/chat-drawer.js";
import { RecordRow } from "../../apps/web/src/chat/message-row.js";
import { parseRecord, upsertTranscriptRecord } from "../../apps/web/src/chat/use-chat-stream.js";
import {
  serializeSubscriberRecord,
  serializeSubscriberRecords
} from "./helpers/boundary-test-gate.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const allowedRecord = {
  kind: "action_result" as const,
  text: "Allowed: Read",
  outcome: "allowed" as const
};

describe("chat drawer activity outcomes", () => {
  it("renders ACP lines in arrival order and replaces live records by stable id", () => {
    const first = parseRecord(
      JSON.stringify({ kind: "thought", id: "thought-1", sequence: 1, text: "Plan" })
    );
    const replacement = parseRecord(
      JSON.stringify({ kind: "thought", id: "thought-1", sequence: 1, text: "Plan more" })
    );
    const tool = parseRecord(
      JSON.stringify({ kind: "tool", id: "tool-1", sequence: 2, text: "calendar.list" })
    );
    expect(first).not.toBeNull();
    expect(replacement).not.toBeNull();
    expect(tool).not.toBeNull();

    let records = upsertTranscriptRecord([], serializeSubscriberRecord(first!));
    records = upsertTranscriptRecord(records, serializeSubscriberRecord(tool!));
    records = upsertTranscriptRecord(records, serializeSubscriberRecord(replacement!));
    expect(records).toEqual([
      { kind: "thought", id: "thought-1", sequence: 1, text: "Plan more" },
      { kind: "tool", id: "tool-1", sequence: 2, text: "calendar.list" }
    ]);

    const html = renderToString(
      createElement(Thread, {
        records: [
          ...records,
          { kind: "result", id: "result-1", sequence: 3, text: "2 events" },
          { kind: "approved", id: "approval-1", sequence: 4, text: "Approved by you" },
          { kind: "reply", text: "Done." }
        ]
      })
    );
    expect(html).toContain("Thought");
    expect(html).toContain("Tool");
    expect(html).toContain("Result");
    expect(html).toContain("Approved");
    expect(html.indexOf("Plan more")).toBeLessThan(html.indexOf("calendar.list"));
    expect(html.indexOf("calendar.list")).toBeLessThan(html.indexOf("2 events"));
    expect(html.indexOf("2 events")).toBeLessThan(html.indexOf("Approved by you"));
  });

  it("keeps per-turn sequence resets in their originating live turn", () => {
    const records: TranscriptRecord[] = [
      { kind: "user" as const, text: "First" },
      { kind: "thought" as const, id: "thought-1", sequence: 1, text: "First thought" },
      { kind: "tool" as const, id: "tool-1", sequence: 2, text: "first.tool" },
      { kind: "reply" as const, text: "First reply" },
      { kind: "user" as const, text: "Second" }
    ].map(serializeSubscriberRecord);

    let live = records;
    live = upsertTranscriptRecord(
      live,
      serializeSubscriberRecord({
        kind: "thought",
        id: "thought-2",
        sequence: 1,
        text: "Second thought"
      })
    );
    live = upsertTranscriptRecord(
      live,
      serializeSubscriberRecord({ kind: "tool", id: "tool-2", sequence: 2, text: "second.tool" })
    );

    expect(live.map((record) => record.text)).toEqual([
      "First",
      "First thought",
      "first.tool",
      "First reply",
      "Second",
      "Second thought",
      "second.tool"
    ]);
  });

  it("keeps one activity fold per turn for live and reloaded approval results", () => {
    const live: TranscriptRecord[] = [
      { kind: "user" as const, text: "Run it" },
      { kind: "thought" as const, sequence: 1, text: "Planning" },
      {
        kind: "action_request" as const,
        actionRequestId: "request-1",
        text: "Approve calendar.list"
      },
      {
        kind: "action_result" as const,
        text: "Executed: calendar.list",
        outcome: "executed" as const
      },
      { kind: "approved" as const, sequence: 3, text: "calendar.list, approved by you" },
      { kind: "reply" as const, text: "Done." }
    ].map(serializeSubscriberRecord);
    const history = recordsFromMessages([
      {
        id: "m-live",
        threadId: "t1",
        ownerUserId: "u1",
        role: "user",
        status: "stored",
        body: "Run it",
        modelRoute: null,
        tools: [],
        activity: [],
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z"
      },
      {
        id: "m-history",
        threadId: "t1",
        ownerUserId: "u1",
        role: "assistant",
        status: "stored",
        body: "Done.",
        modelRoute: null,
        tools: [],
        activity: [
          { kind: "thought", sequence: 1, text: "Planning" },
          { kind: "action_result", text: "Executed: calendar.list", outcome: "executed" },
          { kind: "approved", sequence: 3, text: "calendar.list, approved by you" }
        ],
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z"
      }
    ]);

    const liveItems = groupRecords(live, false);
    const historyItems = groupRecords(history, false);
    const liveFold = liveItems.find((item) => item.type === "activity");
    const historyFold = historyItems.find((item) => item.type === "activity");
    expect(liveFold).toEqual(historyFold);
    expect(liveItems.filter((item) => item.type === "activity")).toHaveLength(1);
    expect(historyItems.filter((item) => item.type === "activity")).toHaveLength(1);
    expect(liveItems.filter((item) => item.type === "record")).toHaveLength(4);
    expect(historyItems.filter((item) => item.type === "record")).toHaveLength(3);
  });

  it("keeps an open activity fold mounted when approval records arrive", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const initial = serializeSubscriberRecords<TranscriptRecord>([
      { kind: "user", text: "Run it" },
      { kind: "thought", id: "thought-1", sequence: 1, text: "Planning" },
      { kind: "tool", id: "tool-1", sequence: 2, text: "calendar.list" }
    ]);
    const render = (records: readonly TranscriptRecord[]) =>
      root.render(
        createElement(Thread, {
          records,
          working: true,
          renderRecord: (record) => createElement("p", null, record.text)
        })
      );

    await act(async () => render(initial));
    const before = container.querySelector<HTMLDetailsElement>("details");
    expect(before).not.toBeNull();
    before!.open = true;

    const arriving = serializeSubscriberRecords<TranscriptRecord>([
      {
        kind: "action_request",
        actionRequestId: "request-1",
        text: "Approve calendar.list"
      },
      { kind: "action_result", text: "Executed", outcome: "executed" },
      { kind: "approved", id: "approval-1", sequence: 4, text: "Approved by you" }
    ]);
    await act(async () => render([...initial, ...arriving]));
    const after = container.querySelector<HTMLDetailsElement>("details");
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(after).toBe(before);
    expect(after?.open).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps separate approval folds across turns when history is restored", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const firstTurn = serializeSubscriberRecords<TranscriptRecord>([
      { kind: "user", text: "First" },
      { kind: "approved", sequence: 2, text: "First approved" },
      { kind: "tool", id: "tool-1", sequence: 3, text: "calendar.tool1" },
      { kind: "reply", text: "First reply" }
    ]);
    const live = serializeSubscriberRecords<TranscriptRecord>([
      ...firstTurn,
      { kind: "user", text: "Second" },
      { kind: "approved", sequence: 2, text: "Second approved" },
      { kind: "tool", id: "tool-2", sequence: 3, text: "calendar.tool2" },
      { kind: "reply", text: "Second reply" }
    ]);
    const history = recordsFromMessages([
      {
        id: "user-1",
        threadId: "thread-1",
        ownerUserId: "user-1",
        role: "user",
        status: "stored",
        body: "First",
        modelRoute: null,
        tools: [],
        activity: [],
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z"
      },
      {
        id: "assistant-1",
        threadId: "thread-1",
        ownerUserId: "user-1",
        role: "assistant",
        status: "stored",
        body: "First reply",
        modelRoute: null,
        tools: [
          {
            name: "calendar.tool1",
            moduleId: "calendar",
            moduleName: "Calendar",
            permissionId: "calendar.tool1",
            risk: "read"
          }
        ],
        activity: [{ kind: "approved", sequence: 2, text: "First approved" }],
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z"
      },
      {
        id: "user-2",
        threadId: "thread-1",
        ownerUserId: "user-1",
        role: "user",
        status: "stored",
        body: "Second",
        modelRoute: null,
        tools: [],
        activity: [],
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z"
      },
      {
        id: "assistant-2",
        threadId: "thread-1",
        ownerUserId: "user-1",
        role: "assistant",
        status: "stored",
        body: "Second reply",
        modelRoute: null,
        tools: [
          {
            name: "calendar.tool2",
            moduleId: "calendar",
            moduleName: "Calendar",
            permissionId: "calendar.tool2",
            risk: "read"
          }
        ],
        activity: [{ kind: "approved", sequence: 2, text: "Second approved" }],
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z"
      }
    ]);
    const render = (records: readonly TranscriptRecord[]) =>
      root.render(
        createElement(Thread, {
          records,
          working: false,
          renderRecord: (record) => createElement("p", null, record.text)
        })
      );

    await act(async () => render(firstTurn));
    const firstFold = container.querySelector<HTMLDetailsElement>("details");
    expect(firstFold).not.toBeNull();
    firstFold!.open = true;
    await act(async () => render(live));
    const secondFold = container.querySelectorAll<HTMLDetailsElement>("details")[1];
    expect(secondFold).not.toBeNull();
    secondFold!.open = true;
    await act(async () => render(history));

    const folds = container.querySelectorAll("details");
    expect(folds).toHaveLength(2);
    expect(folds[0]).toBe(firstFold);
    expect(folds[1]).toBe(secondFold);
    expect(folds[0]?.open).toBe(true);
    expect(folds[1]?.open).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });

  it("renders workflow approval records with the workflow approval card", () => {
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Thread, {
          records: [
            {
              kind: "workflow_approval",
              text: "Approve the seeded workflow action",
              workflowApprovalId: "approval-1",
              summary: "Approve the seeded workflow action",
              status: "pending"
            }
          ],
          // The approval card is the shell's own row, not part of the shared thread.
          renderRecord: (record) => createElement(RecordRow, { record })
        })
      )
    );
    expect(html).toContain('aria-label="Workflow approval"');
    expect(html).toContain('data-workflow-approval-id="approval-1"');
    expect(html).toContain("Approve the seeded workflow action");
  });

  it("renders action outcomes outside the Thinking steps", () => {
    // #1661: was "Allowed by YOLO". A user's own approval now reports this outcome too, and the
    // record carries nothing that says which, so the verb stops naming a cause it cannot know.
    expect(activityVerb(allowedRecord)).toBe("Allowed");

    const html = renderToString(
      createElement(Thread, {
        records: [
          { kind: "thinking", text: "Checking" },
          { kind: "reply", text: "I changed that." },
          { kind: "action_result", text: "LinkedIn monitoring enabled", outcome: "executed" }
        ]
      })
    );
    expect(html).toContain("Thinking");
    expect(html).toContain("LinkedIn monitoring enabled");
    expect(html.indexOf("LinkedIn monitoring enabled")).toBeGreaterThan(
      html.indexOf("I changed that.")
    );
  });

  // #1661: an error used to fall through to "Denied", so the activity line told the user a tool
  // had been refused when the audit row for the same event said the handler failed. Those are
  // different events with different causes, and only one of them is anybody's decision.
  it("does not call a failed tool a denied one", () => {
    expect(
      activityVerb({ kind: "action_result", text: "Failed: example.write", outcome: "error" })
    ).toBe("Failed");
    expect(activityVerb({ kind: "action_result", text: "Not changed", outcome: "denied" })).toBe(
      "Denied"
    );
  });

  it("shows the standalone chip's true outcome for allowed and failed actions", () => {
    // #1784: the standalone line used to collapse four outcomes into a Changed/Not-changed guess,
    // wrongly calling "allowed" a change it never observed and calling "error" unchanged.
    const html = renderToString(
      createElement(Thread, {
        records: [
          { kind: "action_result", text: "Granted: file access", outcome: "allowed" },
          { kind: "action_result", text: "Broke: example.write", outcome: "error" }
        ]
      })
    );
    expect(html).toContain(">Allowed<");
    expect(html).toContain(">Failed<");
    expect(html).not.toContain("Changed");
    expect(html).not.toContain("Not changed");
  });

  it("restores terminal action outcomes after history reload", () => {
    const message: ChatMessageDto = {
      id: "m1",
      threadId: "t1",
      ownerUserId: "u1",
      role: "assistant",
      status: "stored",
      body: "I changed that.",
      modelRoute: null,
      tools: [],
      activity: [
        { kind: "thinking", text: "Checking" },
        {
          kind: "action_result",
          text: "LinkedIn monitoring enabled",
          toolName: "job-search.portal.set-enabled",
          outcome: "executed"
        }
      ],
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z"
    };

    expect(recordsFromMessages([message])).toEqual([
      { kind: "thinking", text: "Checking" },
      {
        kind: "reply",
        text: "I changed that.",
        messageId: "m1",
        attachments: undefined,
        answerProvenance: undefined,
        answerProvenanceCitedIds: undefined,
        sourceFreshness: undefined
      },
      {
        kind: "action_result",
        text: "LinkedIn monitoring enabled",
        toolName: "job-search.portal.set-enabled",
        outcome: "executed"
      }
    ]);
  });

  it("restores the ACP fold records and reply metadata from history", () => {
    const message: ChatMessageDto = {
      id: "m2",
      threadId: "t1",
      ownerUserId: "u1",
      role: "assistant",
      status: "stored",
      body: "Done.",
      modelRoute: null,
      tools: [],
      activity: [
        { kind: "thought", id: "thought-1", sequence: 1, text: "Plan" },
        {
          kind: "tool",
          id: "tool-1",
          sequence: 2,
          text: "calendar.list",
          toolName: "calendar.list"
        },
        { kind: "result", id: "result-1", sequence: 3, text: "2 events" }
      ],
      elapsedMs: 2400,
      usage: { inputTokens: 12, outputTokens: 8 },
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z"
    };

    expect(recordsFromMessages([message])).toEqual([
      { kind: "thought", id: "thought-1", sequence: 1, text: "Plan" },
      {
        kind: "tool",
        id: "tool-1",
        sequence: 2,
        text: "calendar.list",
        toolName: "calendar.list"
      },
      { kind: "result", id: "result-1", sequence: 3, text: "2 events" },
      {
        kind: "reply",
        text: "Done.",
        messageId: "m2",
        sourceFreshness: undefined,
        answerProvenance: undefined,
        answerProvenanceCitedIds: undefined,
        elapsedMs: 2400,
        usage: { inputTokens: 12, outputTokens: 8 }
      }
    ]);
  });
});
