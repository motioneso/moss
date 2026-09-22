/**
 * Recognizing a sign-in or security notice that reports no failure.
 *
 * These messages tell the user something happened, not that something went wrong: a new sign-in
 * from another location, a password that was changed, two-step verification that was turned on.
 * The first-pass gate already lists them under "worth knowing", but the cheap model sometimes
 * answers "might owe someone something" anyway and sends them to the reasoning-tier second pass,
 * where they are always judged as owing nothing. This rule decides the same thing
 * deterministically and is applied after the gate, so the model call can never overrule it.
 *
 * A notice that reports a failure (a sign-in attempt that failed, an account locked or
 * suspended, a breach or fraud alert) is deliberately NOT matched: those can be something the
 * user needs to act on and must still reach the closer look.
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
  "password reset",
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
 * Wording that shows something actually failed or needs urgent action. If any of it appears
 * anywhere in the message, the notice is about a problem, not an FYI, and must not be waved off.
 */
const REPORTS_A_FAILURE =
  /\b(?:fail(?:ed|ure|ures|ing)?|unable|unsuccessful|unsuccessfully|declin(?:e|ed|es)|problem|error(?:s)?|blocked|suspend(?:ed|ing)?|lock(?:ed)? out|account lock(?:ed)?|compromis(?:e|ed)|breach(?:ed)?|fraud(?:ulent)?|unauthori[sz]ed|rejected|denied|couldn'?t|could not|did not|didn'?t|not successful)\b/;

/**
 * True when the message is a sign-in or security notice that reports no failure. Never logs the
 * subject or body it inspects - callers must not either.
 */
export function looksLikeNoFailureSecurityNotice(message: SecurityNoticeInput): boolean {
  const subject = message.subject.toLowerCase();
  if (!SECURITY_NOTICE_PHRASES.some((phrase) => subject.includes(phrase))) return false;
  return !REPORTS_A_FAILURE.test(`${subject}\n${message.body.toLowerCase()}`);
}

/** What a `maybe_owed` first-pass answer is allowed to become after the deterministic checks. */
export type ResolvedMaybeOwedGate = "maybe_owed" | "worth_knowing" | "nothing";

/**
 * Decide whether a `maybe_owed` answer is really worth the reasoning-tier second pass.
 *
 * The cheap model is allowed to be unsure, so a message whose category is still an obligation
 * shape (needs_reply, needs_action, time_sensitive_info, waiting_on_someone, or an unknown the
 * model could not settle) keeps `maybe_owed`. When the model's own answer is that the message
 * asks nothing (noise or fyi), or the message is a no-failure sign-in notice, there is nothing
 * for the closer look to decide, so it is resolved here at the cheap tier instead (#2341).
 */
export function resolveMaybeOwedGate(
  message: SecurityNoticeInput,
  category: string | undefined
): ResolvedMaybeOwedGate {
  if (looksLikeNoFailureSecurityNotice(message)) return "worth_knowing";
  if (category === "noise") return "nothing";
  if (category === "fyi") return "worth_knowing";
  return "maybe_owed";
}
