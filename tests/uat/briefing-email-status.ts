import assert from "node:assert/strict";

/** The live proof must retain uncertainty without accepting an unsupported liability claim. */
export function assertUnknownPaymentStatus(report: string): void {
  assert.match(
    report,
    /unknown|unclear|unconfirmed|not confirmed|does not show.*payment status|status (?:is )?not known/i
  );
  assert.doesNotMatch(report, /\b(unpaid|owed|overdue|due[ -]now|pay today)\b/i);
}
