import type { EmailExtractResult, EmailSignals } from "./email-extract.js";

/** What a `maybe_owed` first-pass answer is allowed to become after the deterministic check. */
export type ResolvedMaybeOwedGate = "maybe_owed" | "worth_knowing" | "nothing";

/** The signals the bulk shortcut reads: list mail and whether the sender is already known. */
export interface MaybeOwedGateContext {
  readonly bulk: boolean;
  readonly knownSender: boolean;
}

/**
 * An answer that names a real obligation is never overridden: the closer look exists for exactly
 * those messages, whatever the bulk flag says.
 */
const OBLIGATION_CATEGORIES = new Set([
  "needs_reply",
  "needs_action",
  "time_sensitive_info",
  "waiting_on_someone"
]);

/**
 * Decide whether a `maybe_owed` answer is really worth the reasoning-tier second pass (#2341).
 *
 * Only one thing is resolved at the cheap tier: bulk mail from a sender the user does not know,
 * where the cheap model already said the message asks nothing (noise or fyi). The model's own
 * verdict decides the bucket (noise to `nothing`, fyi to `worth_knowing`), so an advert that was
 * flagged anyway no longer pays for the closer look.
 *
 * Everything else keeps `maybe_owed`. That deliberately includes every security or sign-in
 * notice: a rule that recognizes "no failure" from wording drops real account-takeover alerts,
 * and a wasted model call is far cheaper than a lost one. It also includes ordinary mail from a
 * known sender, where `maybe_owed` plus fyi is the expected unsure answer the prompt asks for.
 */
export function resolveMaybeOwedGate(
  category: string | undefined,
  context: MaybeOwedGateContext
): ResolvedMaybeOwedGate {
  if (category !== undefined && OBLIGATION_CATEGORIES.has(category)) return "maybe_owed";
  if (context.bulk && !context.knownSender && (category === "noise" || category === "fyi")) {
    return category === "noise" ? "nothing" : "worth_knowing";
  }
  return "maybe_owed";
}

/**
 * Apply the first-pass gate to a sanitized result (spec 2026-09-04-email-chief-of-staff §3.1):
 * `nothing` keeps no summary and a bare noise verdict, `worth_knowing` keeps the summary under an
 * fyi verdict, `maybe_owed` flags the message for the thread judgement. Runs after every other
 * guard so a deterministic fallback summary cannot sneak back in for mail the gate said to leave
 * alone, and passes a `maybe_owed` answer through resolveMaybeOwedGate first.
 *
 * Lives beside the extraction, not inside it, so the extraction file stays under the source-line
 * limit; it reads only the result and the known-sender flag.
 */
export function applyGate(result: EmailExtractResult, knownSender: boolean): EmailExtractResult {
  const { gate, signals } = result;
  if (gate === undefined) return result;
  const resolved =
    gate === "maybe_owed"
      ? resolveMaybeOwedGate(signals.actionability?.category, {
          bulk: signals.bulk === true,
          knownSender
        })
      : gate;
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
