/**
 * Recognizing bulk mail — anything sent to a list rather than to this person.
 *
 * This is a hint for the model, never a filter. Bulk mail is NOT skipped before the model call:
 * a rent reminder, a loan statement and a bank alert all routinely carry an unsubscribe link,
 * and dropping them would hide exactly the mail that matters. All this does is tell the model
 * that the message went to a list, so "act now" wording in a sales mail stops reading as a real
 * obligation.
 *
 * Only the yes/no answer is ever kept. The unsubscribe address itself is never stored, never
 * logged and never put in the prompt.
 */

export interface BulkMailInput {
  /**
   * Whether the message carried a List-Unsubscribe header. Gmail already returns every header
   * with the message, and IMAP parses them, so this costs no extra fetch. Undefined means the
   * provider did not tell us, which is not the same as "no header".
   */
  readonly hasListUnsubscribe?: boolean;
  readonly body: string;
}

/**
 * The word on its own, so "unsubscribed", "unsubscribe_link" and a mid-word match in a tracking
 * URL do not all count the same way. The word boundary either side is deliberate: a body that
 * merely contains the letters inside a longer token is not evidence of a mailing list.
 */
const UNSUBSCRIBE_WORD = /\bunsubscribe\b/i;

/**
 * True when the message looks like it was sent to a mailing list. The header is the reliable
 * signal; the body word is the fallback for providers or messages that do not carry one.
 */
export function looksLikeBulkMail(message: BulkMailInput): boolean {
  if (message.hasListUnsubscribe === true) return true;
  return UNSUBSCRIBE_WORD.test(message.body);
}
