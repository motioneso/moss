/**
 * Recognizing a sign-in or security notice that reports no failure.
 *
 * These messages tell the user something happened, not that something went wrong: a new sign-in
 * from another location, a password that was changed, two-step verification that was turned on.
 * The first-pass gate already lists them under "asks nothing", but the cheap model sometimes
 * answers "might owe someone something" anyway and sends them to the reasoning-tier second pass,
 * where they are always judged as owing nothing. This rule decides the same thing
 * deterministically and can drop such a notice without that call.
 *
 * A notice that reports a failure or asks the user to secure the account (a sign-in attempt that
 * failed, an account locked or suspended, a breach, fraud, an unusual or suspicious sign-in, a
 * "was this you?" prompt) is deliberately NOT matched: those can be something the user needs to
 * act on and must still reach the closer look.
 *
 * Only a yes/no answer is kept. No subject, body or address is ever logged or stored.
 */

export interface SecurityNoticeInput {
  readonly subject: string;
  readonly body: string;
}

/**
 * Wording that names a sign-in or security event rather than an obligation. Read on the subject
 * only: these notices lead with the event, and a passing mention in the body (a marketing footer
 * with a "security" link) must not qualify.
 */
const SECURITY_NOTICE_PHRASES = [
  "new sign-in",
  "new sign in",
  "sign-in from",
  "sign in from",
  "new login",
  "login from",
  "new device",
  "device signed in",
  "signed in on",
  "signed in from",
  "sign-in on",
  "password was changed",
  "password was reset",
  "password was updated",
  "password changed",
  "password updated",
  "security alert",
  "security notice",
  "two-step verification",
  "two factor authentication",
  "two-factor authentication",
  "2-step verification",
  "2fa was",
  "recovery email",
  "recovery phone",
  "passkey was",
  "new passkey",
  "app password was",
  "new app password",
  "trusted device"
] as const;

/**
 * Wording that shows something actually failed or that the user is being asked to act. If any of
 * it appears anywhere in the message, the notice is about a problem, not an FYI, and must reach
 * the closer look. `was this you` and `secure your account` cover the common alert that reports
 * an unusual location without using the word "failed".
 */
const REPORTS_A_FAILURE =
  /\b(?:fail(?:ed|ure|ures|ing)?|unable|unsuccessful|unsuccessfully|declin(?:e|ed|es)|problem|error(?:s)?|blocked|suspend(?:ed|ing)?|lock(?:ed)? out|account lock(?:ed)?|compromis(?:e|ed)|breach(?:ed)?|fraud(?:ulent)?|unauthori[sz]ed|rejected|denied|prevented|couldn'?t|could not|did not|didn'?t|not successful|suspicious|unusual|unrecogni[sz]ed|was this you|wasn'?t you|not you|secure your account|someone (?:else )?(?:tried|requested|has your password))\b/;

/** Most mail clients render U+2018/U+2019, so the apostrophe words only match once normalised. */
function straightenApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019]/g, "'");
}

/**
 * True when the message is a sign-in or security notice that reports no failure. Never logs the
 * subject or body it inspects - callers must not either.
 */
export function looksLikeNoFailureSecurityNotice(message: SecurityNoticeInput): boolean {
  const subject = straightenApostrophes(message.subject.toLowerCase());
  if (!SECURITY_NOTICE_PHRASES.some((phrase) => subject.includes(phrase))) return false;
  const text = `${subject}\n${straightenApostrophes(message.body.toLowerCase())}`;
  return !REPORTS_A_FAILURE.test(text);
}

/** What a `maybe_owed` first-pass answer is allowed to become after the deterministic checks. */
export type ResolvedMaybeOwedGate = "maybe_owed" | "worth_knowing" | "nothing";

/** The signals the shortcut needs from the sanitized result: list mail and a known sender. */
export interface MaybeOwedGateContext {
  readonly bulk: boolean;
  readonly knownSender: boolean;
}

/**
 * An answer that names a real obligation is never overridden: the closer look exists for exactly
 * those messages, whatever else the notice rule or the bulk flag says.
 */
const OBLIGATION_CATEGORIES = new Set([
  "needs_reply",
  "needs_action",
  "time_sensitive_info",
  "waiting_on_someone"
]);

/**
 * Decide whether a `maybe_owed` answer is really worth the reasoning-tier second pass.
 *
 * The cheap model is allowed to be unsure, so an answer that names an obligation keeps
 * `maybe_owed` untouched. Otherwise:
 *
 * - A no-failure sign-in or security notice resolves to `nothing`: the gate already lists those
 *   as asking nothing, and the issue asks that they be treated like sign-in codes.
 * - Bulk mail from a sender the user does not know resolves by the model's own verdict (noise to
 *   `nothing`, fyi to `worth_knowing`). The shortcut is deliberately limited to bulk mail: for
 *   ordinary mail from a known sender, `maybe_owed` plus `fyi` is the expected unsure answer, and
 *   the prompt's known-sender lean must be allowed to reach the closer look.
 * - Anything else keeps `maybe_owed`.
 */
export function resolveMaybeOwedGate(
  message: SecurityNoticeInput,
  category: string | undefined,
  context: MaybeOwedGateContext
): ResolvedMaybeOwedGate {
  if (category !== undefined && OBLIGATION_CATEGORIES.has(category)) return "maybe_owed";
  if (looksLikeNoFailureSecurityNotice(message)) return "nothing";
  if (context.bulk && !context.knownSender && (category === "noise" || category === "fyi")) {
    return category === "noise" ? "nothing" : "worth_knowing";
  }
  return "maybe_owed";
}
