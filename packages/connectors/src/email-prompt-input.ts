import { localDay, resolveEffectiveLocale, type LocaleSettingsDto } from "@moss/shared";

import { looksLikeBulkMail } from "./email-bulk-rule.js";
import type { EmailExtractDeps, ParsedEmail } from "./email-extract.js";

/** The bare, lower-cased address from a From header such as `Sarah Kim <Sarah@Kim.Example>`. */
export function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

const KNOWN_SENDER_LINE =
  "Sender: someone this user already deals with (in their People or previously replied to). Lean toward maybe_owed, but it is not proof.";

/** The person's locale for the prompt's dates; the default locale when the deps carry none. */
export async function emailPromptLocale(
  deps: Pick<EmailExtractDeps, "locale">
): Promise<LocaleSettingsDto> {
  return deps.locale ? await deps.locale() : resolveEffectiveLocale(undefined);
}

/**
 * The email as the model sees it. The two date lines are load-bearing: without them the model has
 * no idea when the message arrived or what day it is, so it anchors a due date to whatever date the
 * body mentions. That is how a request to suggest interview times came back due on the date of the
 * interview window rather than the day the reply was owed (#2271 round 3). Dates only, no times -
 * enough to settle "tomorrow" or "within a day", and nothing extra to leak back into a stored field.
 * Both dates are the person's own day, not the server's or UTC's.
 */
export function promptInput(
  parsed: ParsedEmail,
  knownSender: boolean,
  locale: LocaleSettingsDto,
  now: Date = new Date()
): string {
  const header = [`Subject: ${parsed.subject}`, `From: ${parsed.from}`];
  if (knownSender) header.push(KNOWN_SENDER_LINE);
  const received = new Date(parsed.receivedAt);
  if (!Number.isNaN(received.getTime())) {
    header.push(`Received: ${localDay(received, locale.timezone)}`);
  }
  header.push(`Today: ${localDay(now, locale.timezone)}`);
  if (looksLikeBulkMail(parsed)) header.push("Bulk mail: yes (carries an unsubscribe link)");
  return [...header, "", parsed.body].join("\n");
}
