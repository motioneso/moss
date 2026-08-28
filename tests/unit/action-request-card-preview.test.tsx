import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ActionRequestCard } from "../../apps/web/src/chat/action-request-card.js";
import { parseRecord } from "../../apps/web/src/chat/use-chat-stream.js";

// `ActionRequestCard` reads `useMutation` (#1518), which requires a `QueryClient` in context even
// for the initial idle render — a fresh client per call keeps these tests isolated from each other.
function renderCard(props: Parameters<typeof ActionRequestCard>[0]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(ActionRequestCard, props))
  );
}

describe("ActionRequestCard email preview", () => {
  const baseProps = {
    actionRequestId: "ar_1",
    toolName: "email.draftReply",
    summary: "Draft a reply to Alice"
  };

  it("renders recipient, subject and body when a preview is present", () => {
    const html = renderCard({
      ...baseProps,
      preview: {
        to: "alice@example.test",
        subject: "Re: lunch plans",
        body: "Sounds great — see you at noon."
      }
    });
    expect(html).toContain("alice@example.test");
    expect(html).toContain("Re: lunch plans");
    expect(html).toContain("Sounds great — see you at noon.");
    // Approve / Reject controls still render.
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  it("renders summary-only (no preview block) when no preview is supplied", () => {
    const html = renderCard(baseProps);
    expect(html).toContain("Draft a reply to Alice");
    expect(html).toContain('data-action-request-id="ar_1"');
    // The tool-name label reuses the "action-request-preview__label" class (Decision 6),
    // so we assert on the preview-block-specific containers rather than that shared prefix.
    expect(html).not.toContain("action-request-preview__meta");
    expect(html).not.toContain("action-request-preview__value");
  });

  it("keeps exact stable ID on a requested focus target", () => {
    const html = renderCard({ ...baseProps, focusRequested: true });
    expect(html).toContain('data-action-request-id="ar_1"');
  });

  it("labels the card by what it is asking for, never by the function it would call", () => {
    // This asserted the opposite until commit 2493b3da ("say what an approval card is, not which
    // function it calls"), which deliberately dropped the humanized tool name — "Draft Reply",
    // derived from `email.draftReply` — in favour of a plain state label. The test was left
    // asserting the removed behaviour and has been red ever since; it is rewritten here to the
    // shipped contract rather than deleted, because the thing worth defending is that a tool
    // identifier never leaks into the label.
    const html = renderCard(baseProps);
    expect(html).toContain("action-request-preview__label");
    expect(html).toContain("Needs your approval");
    expect(html).not.toContain("Draft Reply");
    expect(html).not.toContain("draftReply");
  });

  // Focus-return-on-resolve (status → done/error) is verified via manual dev QA;
  // renderToString has no DOM/focus APIs to assert against here.
  it("never renders an Always-approve control, and orders Approve before Reject", () => {
    const html = renderCard(baseProps);
    expect(html).not.toMatch(/always approve/i);
    expect(html.indexOf("Approve")).toBeLessThan(html.indexOf("Reject"));
  });
});

describe("parseRecord preview parsing", () => {
  it("parses a well-formed preview object off the SSE chunk", () => {
    const record = parseRecord(
      JSON.stringify({
        kind: "action_request",
        text: "Approve or deny: Draft a reply",
        actionRequestId: "ar_1",
        toolName: "email.draftReply",
        summary: "Draft a reply",
        preview: { to: "alice@example.test", subject: "Re: hi", body: "hello there" }
      })
    );
    expect(record?.preview).toEqual({
      to: "alice@example.test",
      subject: "Re: hi",
      body: "hello there"
    });
  });

  it("drops a malformed preview (missing/wrong-typed fields) rather than trusting it", () => {
    const record = parseRecord(
      JSON.stringify({
        kind: "action_request",
        text: "Approve or deny: Draft a reply",
        summary: "Draft a reply",
        preview: { to: 5, subject: "Re: hi" }
      })
    );
    expect(record?.preview).toBeUndefined();
  });

  it("accepts an allowed outcome on an action_result record", () => {
    const record = parseRecord(
      JSON.stringify({
        kind: "action_result",
        text: "Allowed by YOLO: Read",
        actionRequestId: "ar_1",
        toolName: "Read",
        outcome: "allowed"
      })
    );
    expect(record?.outcome).toBe("allowed");
  });

  it("parses a workflow approval record for the chat thread", () => {
    const record = parseRecord(
      JSON.stringify({
        kind: "workflow_approval",
        text: "Approve the seeded workflow action",
        workflowApprovalId: "approval-1",
        summary: "Approve the seeded workflow action",
        status: "pending"
      })
    );
    expect(record).toMatchObject({
      kind: "workflow_approval",
      workflowApprovalId: "approval-1",
      summary: "Approve the seeded workflow action",
      status: "pending"
    });
  });
});
