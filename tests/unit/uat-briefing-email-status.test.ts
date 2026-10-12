import { expect, it } from "vitest";
import {
  assertUnknownPaymentStatus,
  assertUnknownReplyStatus
} from "../uat/briefing-email-status.js";

const UNKNOWN = "The email does not show its payment status.";

it("accepts a report explicitly stating that payment status is not shown", () => {
  expect(() => assertUnknownPaymentStatus(UNKNOWN)).not.toThrow();
});

it.each([
  "Its payment status is not shown in what I can see.",
  "I cannot see whether it was paid.",
  "Payment status is unclear.",
  "Payment status is unknown.",
  "There is no record of payment in what I can see."
])("accepts explicit uncertainty about payment: %s", (report) => {
  expect(() => assertUnknownPaymentStatus(report)).not.toThrow();
});

it("rejects an unknown-status report that also claims payment was made", () => {
  expect(() => assertUnknownPaymentStatus(`${UNKNOWN} But it has been paid.`)).toThrow();
});

it.each(["unpaid", "owed", "overdue", "due now", "due-now"])(
  "rejects an unknown-status report that also claims the invoice is %s",
  (claim) => {
    expect(() => assertUnknownPaymentStatus(`${UNKNOWN} The invoice is ${claim}.`)).toThrow();
  }
);

it.each([
  "Dana asked for draft feedback; its current status is unknown.",
  "Dana asked for draft feedback, so respond if that remains outstanding.",
  "Dana asked for draft feedback; reply if you have not already.",
  "Dana's dated question may still need a reply."
])("accepts a historical reply report with uncertainty: %s", (report) => {
  expect(() => assertUnknownReplyStatus(report)).not.toThrow();
});

it.each(["overdue", "urgent", "still waiting on you", "you need to reply now", "reply today"])(
  "rejects a historical reply report with a definite claim: %s",
  (claim) => {
    expect(() => assertUnknownReplyStatus(`Its status is unknown, but ${claim}.`)).toThrow();
  }
);

it("rejects a historical reply report without uncertainty", () => {
  expect(() => assertUnknownReplyStatus("Dana asked for draft feedback; reply to Dana.")).toThrow();
});
