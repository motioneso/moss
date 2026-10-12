import { expect, it } from "vitest";
import { assertUnknownPaymentStatus } from "../uat/briefing-email-status.js";

const UNKNOWN = "The email does not show its payment status.";

it("accepts a report explicitly stating that payment status is not shown", () => {
  expect(() => assertUnknownPaymentStatus(UNKNOWN)).not.toThrow();
});

it.each(["unpaid", "owed", "overdue", "due now", "due-now"])(
  "rejects an unknown-status report that also claims the invoice is %s",
  (claim) => {
    expect(() => assertUnknownPaymentStatus(`${UNKNOWN} The invoice is ${claim}.`)).toThrow();
  }
);
