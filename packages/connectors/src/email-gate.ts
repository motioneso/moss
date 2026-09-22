import type { EmailExtractResult, EmailSignals, ParsedEmail } from "./email-extract.js";
import { resolveMaybeOwedGate } from "./email-security-notice-rule.js";

/**
 * Apply the first-pass gate to a sanitized result (spec 2026-09-04-email-chief-of-staff §3.1):
 * `nothing` keeps no summary and a bare noise verdict, `worth_knowing` keeps the summary under an
 * fyi verdict, `maybe_owed` flags the message for the thread judgement. Runs after every other
 * guard so a deterministic fallback summary cannot sneak back in for mail the gate said to leave
 * alone. A `maybe_owed` answer is first passed through the deterministic tightening in
 * resolveMaybeOwedGate, which is where a bulk advert or a no-failure sign-in notice the cheap
 * model flagged anyway is resolved without paying for the reasoning tier (#2341).
 *
 * Lives beside the extraction, not inside it, so the extraction file stays under the source-line
 * limit; it reads only the result and the message's subject/body.
 */
export function applyGate(
  result: EmailExtractResult,
  message: Pick<ParsedEmail, "subject" | "body">
): EmailExtractResult {
  const { gate, signals } = result;
  if (gate === undefined) return result;
  const resolved =
    gate === "maybe_owed" ? resolveMaybeOwedGate(message, signals.actionability?.category) : gate;
  if (resolved === "nothing") return asNothing(result, signals, resolved);
  if (resolved === "worth_knowing") return asWorthKnowing(result, signals, resolved);
  const { actionability: _drop, ...rest } = signals;
  return { ...result, summary: null, signals: { ...rest, pendingJudgement: true } };
}

function asNothing(
  result: EmailExtractResult,
  signals: EmailSignals,
  gate: "nothing"
): EmailExtractResult {
  const { pendingJudgement: _pending, ...rest } = signals;
  return {
    ...result,
    gate,
    summary: null,
    signals: { ...rest, actionability: { category: "noise" } }
  };
}

function asWorthKnowing(
  result: EmailExtractResult,
  signals: EmailSignals,
  gate: "worth_knowing"
): EmailExtractResult {
  return { ...result, gate, signals: { ...signals, actionability: { category: "fyi" } } };
}
