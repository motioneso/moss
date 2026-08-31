import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatMessageDto } from "@moss/shared";
import { recordsFromMessages } from "../../apps/web/src/chat/chat-drawer.js";
import { Thread, activityVerb } from "../../apps/web/src/chat/message-row.js";

const allowedRecord = {
  kind: "action_result" as const,
  text: "Allowed: Read",
  outcome: "allowed" as const
};

describe("chat drawer activity outcomes", () => {
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
          ]
        })
      )
    );
    expect(html).toContain('aria-label="Workflow approval"');
    expect(html).toContain('data-workflow-approval-id="approval-1"');
    expect(html).toContain("Approve the seeded workflow action");
  });

  it("renders action outcomes outside Behind the scenes", () => {
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
    expect(html).toContain("Behind the scenes");
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
});
