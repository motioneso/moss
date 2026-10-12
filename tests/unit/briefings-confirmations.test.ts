import { describe, expect, it } from "vitest";
import { assessBriefingEmailEvidence } from "../../packages/briefings/src/email-evidence.js";
import { buildMorningEmailLines } from "../../packages/briefings/src/morning-inputs.js";
import { buildEmailCatchUp } from "../../packages/briefings/src/action-rows.js";
import { fakeScopedDb } from "./briefings-compose.harness.js";

const now = new Date("2026-10-11T15:00:00Z");
const locale = { timezone: "America/Los_Angeles", region: "en-US", dateFormat: "12" as const };
const confirmations = [
  "Your order is confirmed",
  "Order confirmation #1234",
  "Your package has shipped",
  "Your shipment was dispatched",
  "Your order has been delivered",
  "Your parcel was delivered",
  "Booking confirmed",
  "Your reservation has been confirmed",
  "Payment received",
  "Your payment was successful",
  "Receipt for your purchase",
  "Your subscription has been renewed"
];
function mail(subject: string, awaitingJudgement = true, actionability = "unknown") {
  return {
    id: "message",
    connectorAccountId: "account",
    sender: "store@example.test",
    subject,
    snippet: "Thank you. No further action is required.",
    summary: subject,
    receivedAt: "2026-10-11T14:00:00Z",
    awaitingJudgement,
    actionability,
    importance: "normal"
  };
}
function lines(item: Record<string, unknown>) {
  return buildMorningEmailLines({ items: [item], signals: [], suggestionLines: [] }).lines;
}

describe("Today excludes no-action confirmations", () => {
  it.each(confirmations)(
    "excludes %s before judgement and from informational lists",
    async (subject) => {
      for (const item of [mail(subject), mail(subject, false, "fyi")]) {
        expect(assessBriefingEmailEvidence([item], now, locale).eligibleItems).toEqual([]);
        expect(lines(item)).toEqual([]);
        expect(
          await buildEmailCatchUp(fakeScopedDb, [item], new Set(), undefined, {
            since: null,
            includes: () => true
          })
        ).toBeNull();
      }
    }
  );
  it.each([
    ["Order confirmed", "Action needed to complete your order."],
    ["Payment confirmation", "Your payment failed. Please update your card."],
    ["Payment received", "Your next payment was declined."],
    ["Booking confirmation", "Please confirm your booking."],
    ["Payment receipt", "Your statement has an amount due by October 18."],
    ["Payment receipt", "Your statement balance $35 is due October 18."],
    ["Order confirmation", "Please review your order and approve the change."],
    ["Reservation confirmed", "Could you reply with your arrival time?"],
    ["Subscription renewed", "Please pay the outstanding balance by Friday."]
  ])("keeps an action request in %s", (subject, snippet) => {
    const item = { ...mail(subject), snippet };
    expect(assessBriefingEmailEvidence([item], now, locale).eligibleItems).toHaveLength(1);
    expect(lines(item).join("\n")).toContain(subject);
  });
  it.each(["needs_reply", "needs_action"])("keeps explicit %s confirmation triage", (category) => {
    const item = mail("Booking confirmed", false, category);
    expect(assessBriefingEmailEvidence([item], now, locale).eligibleItems).toHaveLength(1);
  });
  it("excludes a shipping notice with a do-not-reply footer", () => {
    const item = {
      ...mail("Your order has shipped", false, "fyi"),
      snippet:
        "Tracking number 1234. Do not reply to this message. Questions? Visit our help center."
    };
    expect(assessBriefingEmailEvidence([item], now, locale).eligibleItems).toEqual([]);
    expect(lines(item)).toEqual([]);
  });
  it("leaves unfamiliar notices eligible", () => {
    expect(
      assessBriefingEmailEvidence([mail("An account update")], now, locale).eligibleItems
    ).toHaveLength(1);
  });
  it("never treats a model summary or receipt label as source confirmation evidence", () => {
    const item = { ...mail("An update"), snippet: null, summary: "Payment received" };
    expect(assessBriefingEmailEvidence([item], now, locale).eligibleItems).toHaveLength(1);
    expect(lines(item).join("\n")).toContain("An update");
  });
  it("keeps the receipt as evidence when it settles an older invoice", () => {
    const invoice = { ...mail("Invoice #123 due October 9"), receivedAt: "2026-10-09T14:00:00Z" };
    const receipt = {
      ...mail("Payment received for Invoice #123", false, "receipt_or_notice"),
      id: "receipt"
    };
    const result = assessBriefingEmailEvidence([invoice, receipt], now, locale);
    expect(result.evidence.items[0]).toMatchObject({
      status: "settled",
      contraryMessageIds: ["receipt"]
    });
    expect(result.eligibleItems).toEqual([]);
  });
});
