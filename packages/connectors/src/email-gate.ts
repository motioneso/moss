import type { EmailExtractResult, EmailSignals } from "./email-extract.js";

/** What a `maybe_owed` first-pass answer is allowed to become after the deterministic check. */
export type ResolvedMaybeOwedGate = "maybe_owed" | "worth_knowing" | "nothing";

/** The signals the bulk shortcut reads: list mail, whether the sender is already known, and the subject and body the veto reads. The text is optional so older callers keep working. */
export interface MaybeOwedGateContext {
  readonly bulk: boolean;
  readonly knownSender: boolean;
  readonly subject?: string;
  readonly body?: string;
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

// Curly quotes, the modifier-letter apostrophe and the backtick all read as an apostrophe here.
const APOSTROPHE_FOLD = new RegExp(`[${String.fromCharCode(0x2018, 0x2019, 0x02bc, 0x0060)}]`, "g");

/**
 * Decode the apostrophe forms mail bodies arrive in before the veto reads them: the named and
 * numeric HTML entities, then the curly and modifier apostrophes some senders use.
 */
function normalizeForSecurityVeto(text: string): string {
  return text
    .replace(/&#8217;|&#8216;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(APOSTROPHE_FOLD, "'");
}

/**
 * Words that mark a message as a possible security or sign-in notice. This list only ever
 * decides "take the closer look", so a word too many costs a model call and never an alert.
 */
const SECURITY_VETO_PATTERNS: readonly RegExp[] = [
  /secur/i,
  /sign[\s\-_]*in|signin|signed[\s\-_]*in/i,
  /log[\s\-_]*in|login|logged[\s\-_]*in/i,
  /password|passcode/i,
  /verif/i,
  /two[\s\-_]*step|two[\s\-_]*factor|2[\s\-_]*step|\b2fa\b|\bmfa\b/i,
  /device/i,
  /recover/i,
  /account/i,
  /suspicious|unusual|unrecogni[sz]e/i,
  /fraud/i,
  /unauthori[sz]ed/i,
  /was this you/i,
  /wasn't you|was not you/i,
  /didn't sign in|did not sign in/i
];

/**
 * True when the subject or body reads like a security or sign-in notice. Real alerts often
 * carry an unsubscribe header or footer, so the bulk shortcut must never fire on them.
 */
function looksLikeSecurityOrSignInAlert(subject: string, body: string): boolean {
  const text = normalizeForSecurityVeto(`${subject}\n${body}`);
  return SECURITY_VETO_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Decide whether a `maybe_owed` answer is really worth the reasoning-tier second pass (#2341).
 *
 * Only one thing is resolved at the cheap tier: bulk mail from a sender the user does not know,
 * where the cheap model already called the message junk (noise). Such an advert no longer pays
 * for the closer look and is left out. A first-pass fyi answer always keeps the closer look,
 * because the prompt sends security and sign-in notices to fyi and many of those carry an
 * unsubscribe mark.
 *
 * Anything that reads like a security or sign-in notice also keeps `maybe_owed`, whatever the
 * category is: a rule that recognizes "no failure" from wording drops real account-takeover
 * alerts, and a wasted model call is far cheaper than a lost one. That veto only ever decides
 * "take the closer look", so an advert that trips it just keeps today's behaviour. Ordinary
 * mail from a known sender keeps its closer look too, where `maybe_owed` plus fyi is the
 * expected unsure answer the prompt asks for.
 */
export function resolveMaybeOwedGate(
  category: string | undefined,
  context: MaybeOwedGateContext
): ResolvedMaybeOwedGate {
  if (category !== undefined && OBLIGATION_CATEGORIES.has(category)) return "maybe_owed";
  if (looksLikeSecurityOrSignInAlert(context.subject ?? "", context.body ?? "")) {
    return "maybe_owed";
  }
  if (context.bulk && !context.knownSender && category === "noise") return "nothing";
  return "maybe_owed";
}

/** The message text the veto reads. Kept separate so no body text is ever stored or logged. */
export interface GateMessageText {
  readonly subject: string;
  readonly body: string;
}

/**
 * Apply the first-pass gate to a sanitized result (spec 2026-09-04-email-chief-of-staff §3.1):
 * `nothing` keeps no summary and a bare noise verdict, `worth_knowing` keeps the summary under an
 * fyi verdict, `maybe_owed` flags the message for the thread judgement. Runs after every other
 * guard so a deterministic fallback summary cannot sneak back in for mail the gate said to leave
 * alone, and passes a `maybe_owed` answer through resolveMaybeOwedGate first.
 *
 * Lives beside the extraction, not inside it, so the extraction file stays under the source-line
 * limit; it reads the result, the known-sender flag and the message text for the veto.
 */
export function applyGate(
  result: EmailExtractResult,
  knownSender: boolean,
  source?: GateMessageText
): EmailExtractResult {
  const { gate, signals } = result;
  if (gate === undefined) return result;
  const resolved =
    gate === "maybe_owed"
      ? resolveMaybeOwedGate(signals.actionability?.category, {
          bulk: signals.bulk === true,
          knownSender,
          subject: source?.subject,
          body: source?.body
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
