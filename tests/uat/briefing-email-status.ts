import assert from "node:assert/strict";

/** The live proof must retain uncertainty without accepting an unsupported liability claim. */
export function assertUnknownPaymentStatus(report: string): void {
  assert.match(
    report,
    /unknown|unclear|unconfirmed|not confirmed|does not show.*payment status|status (?:is )?not (?:known|shown)|(?:cannot|can't) see whether (?:it|the (?:invoice|bill)) (?:was|has been|is) paid|no record of payment in what I can see/i
  );
  assert.doesNotMatch(report, /\b(unpaid|owed|overdue|due[ -]now|pay today)\b/i);
  assert.doesNotMatch(report, /\bit has been paid\b/i);
}

/** Dated questions may be conditional, but cannot claim a current obligation. */
export function assertUnknownReplyStatus(report: string): void {
  assert.match(
    report,
    /unknown|unclear|unconfirmed|not confirmed|status (?:is )?not known|if (?:that|it) remains outstanding|if you have not already|may still need/i
  );
  assert.doesNotMatch(
    report,
    /\b(overdue|urgent|still waiting on you|you need to reply now|reply today)\b/i
  );
}
