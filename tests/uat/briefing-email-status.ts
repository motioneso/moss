import assert from "node:assert/strict";

/** Check assertions before a conditional clause, preserving later independent assertions. */
export function assertNoDefiniteEmailClaim(report: string): void {
  const assertions = report
    .split(/[.!?;\n]|\bbut\b|,\s*however\b/i)
    .map((clause) => clause.split(/\b(?:whether|if|confirm)\b/i)[0])
    .join("\n");
  assert.doesNotMatch(
    assertions,
    /\b(unpaid|owed|overdue|due[ -]now|pay today|(?:it|invoice|bill) (?:has been|was|is) paid|urgent|still waiting on you|you need to reply now|reply today)\b/i
  );
}

/** The bounded wording oracle retains uncertainty without accepting a definite payment claim. */
export function assertUnknownPaymentStatus(report: string): void {
  assert.match(
    report,
    /unknown|unclear|unconfirmed|not confirmed|does not show.*payment status|status (?:is )?not (?:known|shown)|(?:cannot|can't) see whether (?:it|the (?:invoice|bill)) (?:was|has been|is) paid|no record of payment in what I can see/i
  );
  assertNoDefiniteEmailClaim(report);
}

/** Dated questions may be conditional, but cannot claim a current obligation. */
export function assertUnknownReplyStatus(report: string): void {
  assert.match(
    report,
    /unknown|unclear|unconfirmed|not confirmed|status (?:is )?not known|if (?:that|it) remains outstanding|if you have not already|may still need/i
  );
  assertNoDefiniteEmailClaim(report);
}
