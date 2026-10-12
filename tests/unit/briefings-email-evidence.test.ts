import type { ToolExecute } from "@moss/module-sdk";
import type { BriefingEmailEvidenceV1 } from "@moss/shared";
import { assessBriefingEmailEvidence } from "../../packages/briefings/src/email-evidence.js";
import { describe, expect, it } from "vitest";
import { composeBriefing, type ComposeDeps } from "../../packages/briefings/src/compose.js";
import { definition, fakeScopedDb, makeFakeDeps, runInput } from "./briefings-compose.harness.js";

const NOW = new Date("2026-10-11T15:00:00Z");
const LOCALE = { timezone: "America/Los_Angeles", region: "en-US", dateFormat: "12" as const };
const bills = ["Alpha", "Beta", "Gamma"].map((sender, i) => ({
  id: `bill-${i}`,
  connectorAccountId: "account-1",
  threadId: `invoice-${i}`,
  sender,
  subject: `Invoice #${i} due September 15`,
  receivedAt: "2026-09-01T15:00:00Z",
  actionability: "fyi",
  awaitingJudgement: true,
  summary: `Invoice #${i} is due September 15.`
}));
const receipts = bills.map((bill, i) => ({
  ...bill,
  id: `receipt-${i}`,
  subject: `Invoice #${i} paid in full`,
  receivedAt: "2026-09-15T15:00:00Z",
  actionability: "receipt_or_notice",
  awaitingJudgement: false,
  summary: `Invoice #${i} was paid in full.`
}));
async function compose(
  messages: readonly Record<string, unknown>[],
  briefingType: "morning" | "evening" = "morning",
  noModel = false
) {
  let prompt = "";
  const base = makeFakeDeps({
    userName: "Proof owner",
    noModel,
    generateChat: async (input) => {
      prompt = input.messages.map((m) => m.content).join("\n");
      return { text: "A quiet day." };
    }
  });
  const deps: ComposeDeps = {
    ...base,
    moduleManifests: base.moduleManifests.map((m) => ({
      ...m,
      assistantTools: m.assistantTools?.map((t) =>
        t.name === "email.listVisibleMessages"
          ? { ...t, execute: async () => ({ data: { messages } }) }
          : t
      )
    }))
  };
  const result = await composeBriefing(
    fakeScopedDb,
    definition({
      briefing_type: briefingType,
      selected_tool_names: ["email.listVisibleMessages"],
      schedule_metadata: { timezone: LOCALE.timezone }
    }),
    { runKind: "manual", now: NOW, locale: LOCALE },
    deps
  );
  return { result, prompt };
}

describe("briefing email current-status evidence (#3465)", () => {
  it.each(["morning", "evening"] as const)(
    "%s does not turn older invoices with newer receipts into current obligations",
    async (kind) => {
      const { result, prompt } = await compose([...bills, ...receipts], kind);
      expect(result.sourceMetadata.emailSignals).toEqual([]);
      expect(prompt).not.toContain("timing pressure today");
      expect(prompt).not.toContain("Invoice #0");
      expect(result.sourceMetadata.emailEvidence).toMatchObject({ version: 1 });
      expect((result.sourceMetadata.emailEvidence as BriefingEmailEvidenceV1).items).toContainEqual(
        expect.objectContaining({
          messageId: "bill-0",
          status: "settled",
          contraryMessageIds: ["receipt-0"]
        })
      );
    }
  );
  it.each(["morning"] as const)(
    "%s keeps an old reply as a dated unknown report beside suppressed invoices",
    async (kind) => {
      const question = {
        id: "colleague",
        connectorAccountId: "account-1",
        sender: "Dana",
        subject: "Can you reply about the draft?",
        receivedAt: "2026-09-01T15:00:00Z",
        actionability: "needs_reply",
        awaitingJudgement: false
      };
      const { result, prompt } = await compose([question, ...bills, ...receipts], kind);
      expect(prompt).toContain("current status unknown");
      expect(prompt).toContain("Dana asked for a reply");
      expect(prompt).toContain("Sep");
      expect(prompt).not.toContain("Invoice #0");
      expect(result.sourceMetadata.emailSignals).toEqual([]);
      expect(
        (result.sourceMetadata.emailEvidence as BriefingEmailEvidenceV1).items[0]
      ).toMatchObject({ messageId: "colleague", status: "current_status_unknown", rank: null });
    }
  );

  it("keeps an older needs-reply report outside the current signal ranking", async () => {
    const deps = makeFakeDeps();
    const manifests = deps.moduleManifests.map((m) => ({
      ...m,
      assistantTools: (m.assistantTools ?? []).map((t) =>
        t.name === "email.listVisibleMessages"
          ? {
              ...t,
              execute: (async () => ({
                data: {
                  messages: [
                    {
                      id: "bill-1",
                      connectorAccountId: "conn-1",
                      sender: "billing@example.test",
                      subject: "Invoice due today",
                      snippet: "Payment due today",
                      actionability: "needs_action"
                    },
                    {
                      id: "bill-2",
                      connectorAccountId: "conn-1",
                      sender: "bank@example.test",
                      subject: "Past due statement",
                      snippet: "Past due notice",
                      actionability: "needs_action"
                    },
                    {
                      id: "urgent-1",
                      connectorAccountId: "conn-1",
                      sender: "pm@example.test",
                      subject: "Can you reply before the 3pm review?",
                      snippet: "Need this today",
                      receivedAt: "2026-06-13T08:30:00.000Z",
                      actionability: "needs_reply"
                    },
                    {
                      id: "plan-1",
                      connectorAccountId: "conn-1",
                      sender: "legal@example.test",
                      subject: "Contract draft for meeting",
                      snippet: "Please review before tomorrow",
                      actionability: "time_sensitive_info"
                    },
                    {
                      id: "follow-1",
                      connectorAccountId: "conn-1",
                      sender: "partner@example.test",
                      subject: "Following up on the open thread",
                      snippet: "Can you respond when you have a minute?",
                      receivedAt: "2026-05-30T08:30:00.000Z",
                      actionability: "needs_reply"
                    },
                    {
                      id: "extra-1",
                      connectorAccountId: "conn-1",
                      sender: "ops@example.test",
                      subject: "Due today",
                      snippet: "Urgent follow up needed",
                      actionability: "needs_action"
                    }
                  ]
                }
              })) as ToolExecute
            }
          : t
      )
    }));

    const result = await composeBriefing(fakeScopedDb, definition(), runInput, {
      ...deps,
      moduleManifests: manifests
    });

    expect(result.sourceMetadata.emailSignals).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ messageIds: ["follow-1"] })])
    );
    expect(result.sourceMetadata.emailEvidence).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          messageId: "follow-1",
          status: "current_status_unknown",
          rank: null
        })
      ])
    });
    expect((result.sourceMetadata.emailSignals as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it("keeps the assessment on a degraded morning run", async () => {
    const { result } = await compose([...bills, ...receipts], "morning", true);
    expect(result.sourceMetadata.emailEvidence).toMatchObject({ version: 1 });
    expect(result.sourceMetadata.degraded).toBe(true);
  });

  it.each([
    ["absent", []],
    [
      "another invoice",
      [{ ...receipts[0], summary: "Invoice #99 paid in full.", subject: "Invoice #99" }]
    ],
    ["another account", [{ ...receipts[0], connectorAccountId: "other" }]],
    [
      "ambiguous invoice",
      [{ ...receipts[0], subject: "Invoice #0 and invoice #99 paid in full." }]
    ],
    ["another sender", [{ ...receipts[0], sender: "other" }]],
    [
      "partial",
      [
        {
          ...receipts[0],
          subject: "Invoice #0 partially paid in full.",
          summary: "Invoice #0 partially paid in full."
        }
      ]
    ],
    ["future", [{ ...receipts[0], receivedAt: "2099-01-01T00:00:00Z" }]]
  ])("leaves unpaid status unknown when the receipt is %s", (_label, other) => {
    const { evidence, eligibleItems } = assessBriefingEmailEvidence(
      [bills[0]!, ...other],
      NOW,
      LOCALE
    );
    expect(evidence.items[0]).toMatchObject({
      status: "current_status_unknown",
      contraryMessageIds: []
    });
    expect(eligibleItems).toEqual([]);
  });

  it.each([undefined, "invalid", "2099-01-01T00:00:00Z"])(
    "fails closed for timestamp %s",
    (receivedAt) => {
      const { eligibleItems } = assessBriefingEmailEvidence(
        [{ ...bills[0], subject: "Can you reply?", summary: "Question", receivedAt }],
        NOW,
        LOCALE
      );
      expect(eligibleItems).toEqual([]);
    }
  );

  it("uses the owner's local date at midnight and retains the received timestamp", () => {
    const mail = {
      id: "reply",
      connectorAccountId: "account",
      receivedAt: "2026-10-11T06:55:00Z",
      subject: "Can you reply?",
      actionability: "needs_reply"
    };
    const before = assessBriefingEmailEvidence([mail], new Date("2026-10-11T06:59:00Z"), LOCALE);
    const after = assessBriefingEmailEvidence([mail], new Date("2026-10-11T07:01:00Z"), LOCALE);
    expect(before.eligibleItems).toEqual([mail]);
    expect(before.evidence.localDate).toBe("2026-10-10");
    expect(after.eligibleItems).toEqual([{ ...mail, briefingCurrentStatusUnknown: true }]);
    expect(after.evidence.items[0]).toMatchObject({
      ageDays: 1,
      receivedAt: "2026-10-11T06:55:00.000Z"
    });
  });

  it("retains today's email from a full 225-message cache", async () => {
    const messages = Array.from({ length: 225 }, (_, i) => ({
      id: String(i),
      connectorAccountId: "account",
      subject: "Reply?",
      receivedAt: NOW.toISOString(),
      actionability: "needs_reply"
    }));
    const { evidence, eligibleItems } = assessBriefingEmailEvidence(messages, NOW, LOCALE);
    expect(evidence.truncated).toBe(false);
    expect(evidence.items).toHaveLength(225);
    expect(eligibleItems).toHaveLength(225);
    const { result } = await compose(messages);
    expect(result.sourceMetadata.emailSignals).not.toEqual([]);
    const overflow = assessBriefingEmailEvidence(
      [...messages, { ...messages[0], id: "extra" }],
      NOW,
      LOCALE
    );
    expect(overflow.evidence.truncated).toBe(true);
    expect(overflow.eligibleItems).toHaveLength(225);
  });
  it.each(["morning", "evening"] as const)(
    "%s reports today's bill with its date and unknown payment status",
    async (kind) => {
      const bill = {
        ...bills[0],
        id: "today-bill",
        receivedAt: NOW.toISOString(),
        subject: "Invoice #TODAY",
        actionability: "needs_action"
      };
      const { result, prompt } = await compose([bill], kind);
      expect(prompt).toContain("payment status unknown");
      expect(prompt).toContain("Oct");
      expect(prompt).toContain("Invoice #TODAY");
      expect(prompt).not.toContain("is due September");
      expect(result.sourceMetadata.emailSignals).toEqual([]);
      expect(
        (result.sourceMetadata.emailEvidence as BriefingEmailEvidenceV1).items[0]
      ).toMatchObject({ ageDays: 0, status: "current_status_unknown", rank: null });
    }
  );
  it.each(["statement of work", "payment proposal", "invoice details"])(
    "keeps today's explicitly triaged reply about %s in reply ranking",
    async (topic) => {
      const message = {
        id: "reply-request",
        connectorAccountId: "account-1",
        sender: "Colleague",
        subject: `Can you review the ${topic}?`,
        receivedAt: NOW.toISOString(),
        actionability: "needs_reply"
      };
      for (const kind of ["morning", "evening"] as const) {
        const { result, prompt } = await compose([message], kind);
        expect(prompt).toContain(message.subject);
        expect(prompt).not.toContain("payment status unknown");
        expect(result.sourceMetadata.emailSignals).toContainEqual(
          expect.objectContaining({ type: "needs_reply", messageIds: [message.id] })
        );
        expect(
          (result.sourceMetadata.emailEvidence as BriefingEmailEvidenceV1).items[0]
        ).toMatchObject({
          status: "reported_today",
          rank: expect.any(Number)
        });
      }
    }
  );
  it("keeps the strict age cutoff for an old invoice triaged as needing a reply", async () => {
    const { prompt } = await compose([{ ...bills[0], actionability: "needs_reply" }]);
    expect(prompt).not.toContain("Invoice #0");
  });
  it("omits unverified FYI billing summaries", async () => {
    const { prompt } = await compose([
      {
        ...bills[0],
        receivedAt: NOW.toISOString(),
        summary: "Seriously overdue and unpaid invoice",
        actionability: "fyi"
      }
    ]);
    expect(prompt).toContain("payment status unknown");
    expect(prompt).not.toContain("Seriously overdue and unpaid invoice");
  });
  it("evening reconciles historical receipts but only shows today's mail", async () => {
    const question = {
      id: "old-question",
      connectorAccountId: "account-1",
      sender: "Historical colleague",
      subject: "Old draft reply",
      receivedAt: "2026-09-01T15:00:00Z",
      actionability: "needs_reply"
    };
    const current = {
      ...question,
      id: "today-question",
      sender: "Current colleague",
      subject: "Today's draft reply",
      receivedAt: NOW.toISOString()
    };
    const { result, prompt } = await compose([question, current, ...bills, ...receipts], "evening");
    expect(prompt).not.toContain("Historical colleague");
    expect(prompt).not.toContain("Old draft reply");
    expect(prompt).toContain("Current colleague");
    expect(result.sourceMetadata.emailMessageCount).toBe(1);
    expect((result.sourceMetadata.emailEvidence as BriefingEmailEvidenceV1).items).toContainEqual(
      expect.objectContaining({
        messageId: "bill-0",
        status: "settled",
        contraryMessageIds: ["receipt-0"]
      })
    );
  });
});
