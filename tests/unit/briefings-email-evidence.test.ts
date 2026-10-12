import type { BriefingEmailEvidenceV1 } from "@moss/shared";
import { assessBriefingEmailEvidence } from "../../packages/briefings/src/email-evidence.js";
import { describe, expect, it } from "vitest";
import { composeBriefing, type ComposeDeps } from "../../packages/briefings/src/compose.js";
import { definition, fakeScopedDb, makeFakeDeps } from "./briefings-compose.harness.js";

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
  it.each(["morning", "evening"] as const)(
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

  it("fails closed when the bounded evidence overflows", () => {
    const messages = Array.from({ length: 201 }, (_, i) => ({
      id: String(i),
      connectorAccountId: "account",
      subject: "Reply?",
      receivedAt: NOW.toISOString(),
      actionability: "needs_reply"
    }));
    expect(
      assessBriefingEmailEvidence(messages.slice(0, 200), NOW, LOCALE).eligibleItems
    ).toHaveLength(200);
    const { evidence, eligibleItems } = assessBriefingEmailEvidence(messages, NOW, LOCALE);
    expect(evidence.truncated).toBe(true);
    expect(evidence.items).toHaveLength(200);
    expect(eligibleItems).toEqual([]);
  });
});
