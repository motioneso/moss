/**
 * Recognizing an email that hands over a sign-in code.
 *
 * This file holds the deterministic rules only: the wording lists, the number shapes, and the
 * decision they add up to. Calling the model and reading its answer live in email-extract.ts.
 */

/**
 * A message is treated as a machine-issued sign-in code only when all three of the signals
 * below hold at once. Each one on its own is common in ordinary mail — a friend sends a door
 * code, a shop mails a discount code — and earlier keyword-only versions of this check hid
 * real messages because of that. Adding more keywords makes it worse, not better; the strength
 * here comes from requiring the combination.
 *
 *   1. the subject names a sign-in, login, account-verification, one-time, two-step or security
 *      code and is worded as a delivery — not as an announcement about codes in general, not as
 *      a reply or a forward, and not as someone asking about a code or reporting a problem with
 *      one. Real sign-in mail from Google, Apple, Microsoft, banks and shops names that kind of
 *      code in the subject; door codes, vouchers, tracking numbers and policy notices do not,
 *      so the body on its own never qualifies. The subject alone is not treated as handing a
 *      code over, only as naming one,
 *   2. the subject or the opening of the body actually hands a short code over: the code stands
 *      on its own as one unbroken run of characters, and it follows wording such as "code is",
 *      "code:", "enter" or "use", or is named as the code straight afterwards, or sits alone on
 *      a line under a sentence naming it. A number introduced as a case, ticket, reference,
 *      order or telephone line does not count, and a telephone number written in groups or with
 *      the area code in brackets is blanked out before the search,
 *   3. nothing anywhere in the subject or the whole body points at a door, a stay, an order,
 *      a delivery, a booking or a money-off code, which would explain the number another way.
 *
 * The sender address is deliberately not one of the signals. A live run over a real inbox found
 * genuine sign-in code mail arriving from ordinary-looking mailboxes — login@, ordercs@,
 * hello@ — so any list of machine-sounding mailbox names would keep missing real senders.
 */

/**
 * Phrases that name a temporary sign-in secret. Each one must both say "code", "passcode" or
 * "password" AND tie it to signing in, logging in, verifying an account, or two-step
 * verification. A bare "passcode", "temporary code" or "confirmation code" is deliberately
 * absent: a hotel mails a door passcode and an airline mails a booking confirmation code, and
 * those are messages a person wants to see.
 */
const SIGN_IN_CODE_PHRASES = [
  "verification code",
  "verification passcode",
  "one-time code",
  "one time code",
  "onetime code",
  "one-time passcode",
  "one time passcode",
  "onetime passcode",
  "one-time password",
  "one time password",
  "onetime password",
  "single-use code",
  "single use code",
  "single-use passcode",
  "single use passcode",
  "login code",
  "log-in code",
  "log in code",
  "signin code",
  "sign-in code",
  "sign in code",
  "login passcode",
  "sign-in passcode",
  "sign in passcode",
  "authentication code",
  "authentication passcode",
  "security code",
  "two-factor code",
  "two factor code",
  "two-step code",
  "two step code",
  "2fa code"
] as const;

/** The abbreviation only counts as a whole word: "hotpot" and "adopts" must not match. */
const OTP_WORD = /\botp\b/;

/**
 * Words that mean a short number in the message belongs to something other than signing in:
 * a physical lock, a stay, an order, a delivery, a booking or a money-off code. If one of them
 * appears anywhere in the subject or the whole body, the message is never treated as a sign-in
 * code email, however its subject is worded. A reviewer can move wording to another line, so
 * the whole message is read, not one line of it.
 */
const NOT_A_SIGN_IN_MESSAGE =
  /\b(?:door|doors|apartment|apartments|apt|flat|room|rooms|gate|gates|lock|locks|keypad|garage|entry|entrance|building|locker|stay|stays|check[\s-]?in|check[\s-]?out|checkout|order|orders|tracking|parcel|package|delivery|deliveries|shipment|shipping|courier|booking|bookings|reservation|reservations|voucher|vouchers|coupon|coupons|discount|discounts|promo|promotion|promotions)\b/;

/**
 * A short code standing on its own: four to eight digits, or six to eight letters and digits
 * mixed. It must not be glued to other letters or digits, so an order number inside a longer
 * reference or a price will not pass on their own.
 */
const STANDALONE_CANDIDATE =
  /(?<![a-z0-9])(?:\d{4,8}|(?=[a-z0-9]{6,8}(?![a-z0-9]))(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,8})(?![a-z0-9])/g;

/** Four digits that read as a calendar year are a date, not a secret. */
const READS_AS_A_YEAR = /^(?:19|20)\d{2}$/;

/**
 * A telephone number written the way people write them: three or more digit groups separated
 * by spaces, dots or hyphens, such as a support line printed in the footer. Those digits are
 * cleared out before the message is searched for a code, so "call 0800 123 4567" can never be
 * mistaken for a sign-in code. A real code is one unbroken run of characters.
 */
const TELEPHONE_STYLE = /(?<![a-z0-9])\+?\d[\d.-]*(?:[\s.-]\d[\d.-]*){2,}(?![a-z0-9])/g;

/**
 * The same thing with the area code in brackets, which is how North American numbers are
 * usually written: "(415) 555-4829", "(415) 555 4829", "(+44) 20 7946 0958". Without this the
 * last four digits stand alone and read as a code.
 */
const TELEPHONE_WITH_BRACKETED_AREA_CODE =
  /(?<![a-z0-9])\(\s*\+?\d{1,5}\s*\)[\s.-]*\d[\d\s.-]*\d(?![a-z0-9])/g;

/**
 * Wording that shows the subject line is handing over a code right now, rather than talking
 * about codes in general: "your ... code", "code is", "code:", "is your", "use code", or a
 * short code printed in the subject itself.
 */
const SUBJECT_DELIVERS_A_CODE = [
  /\byour\b[^\n]{0,24}?\b(?:code|passcode|password|otp)\b/,
  /\b(?:code|passcode|password)\b\s*(?:is\b|:)/,
  /\bis your\b/,
  /\buse (?:this )?code\b/
] as const;

/**
 * Wording that shows the subject line is about codes in general - a policy, a change of
 * process, an announcement - rather than carrying one. These messages are ordinary mail and
 * must reach the normal analysis.
 */
const SUBJECT_IS_ABOUT_CODES_IN_GENERAL =
  /\b(?:policy|policies|update|updates|updated|updating|change|changes|changed|changing|deliver|delivers|delivered|delivering|announcement|announcing|notice|reminder|terms)\b/;

/**
 * A subject that replies to or forwards an earlier message. A machine sending a code starts a
 * new message; a person answering one keeps the thread. The reply carries the original wording
 * without handing over anything, so it is a conversation and must reach the normal analysis.
 */
const SUBJECT_IS_A_REPLY_OR_FORWARD =
  /^\s*(?:\[[^\]\n]{0,32}\]\s*)*(?:re|fwd?|fw|rv|aw|tr)\s*(?:\[\d{1,3}\])?\s*:/;

/**
 * A subject that talks about a code rather than carrying one: someone asking about it, needing
 * help with it, or reporting a problem. Ordinary human mail, however the body reads.
 */
const SUBJECT_DISCUSSES_A_CODE =
  /\b(?:about|regarding|question|questions|query|queries|help|problem|problems|issue|issues|trouble|advice)\b/;

/** How much of the body is searched for the code itself. Excluded wording is looked for in
 * the whole body, however long it is. */
const OTP_CHECK_BODY_CHARS = 500;

/**
 * The message fields a caller passes in. `ParsedEmail` satisfies it structurally. The sender is
 * accepted so callers can hand over a whole message, but the check never reads it.
 */
export interface OneTimeCodeEmailInput {
  readonly from: string;
  readonly subject: string;
  readonly body: string;
}

/** Any of the words that name a temporary secret, used when reading the text around a number. */
const NAMES_A_CODE = /\b(?:code|passcode|password|otp)\b/;

/** True when the text names a sign-in, verification or two-step code specifically. */
function namesASignInCode(text: string): boolean {
  return SIGN_IN_CODE_PHRASES.some((phrase) => text.includes(phrase)) || OTP_WORD.test(text);
}

/**
 * Wording immediately before a number that hands it over, read on that number's own line only:
 * "your code is 482910", "verification code: 482910", "Enter 482910", "Please use 482910 to sign
 * in". The instruction has to open its sentence, so "when I enter 482910, the site says it has
 * expired" is a person asking for help and not a delivery.
 */
const HANDS_THE_CODE_OVER_BEFORE_IT = [
  /\b(?:code|passcode|password|otp)\b[^\n]{0,16}?(?:\bis\b|:)[\s:]*$/,
  /(?:^|[.!?]\s+)(?:please\s+)?(?:enter|use|using|type)\b[^\n]{0,32}$/
] as const;

/** Wording immediately after a number that names it as the code: "482910 is your Google code". */
const HANDS_THE_CODE_OVER_AFTER_IT =
  /^[^\n]{0,4}?\bis\b[^\n]{0,40}?\b(?:code|passcode|password|otp)\b/;

/**
 * Words that explain a nearby number as something other than a sign-in code: a support case, a
 * ticket, a reference, an order, a telephone line, or a number a website has refused.
 */
const THE_NUMBER_BELONGS_TO_SOMETHING_ELSE =
  /\b(?:reject|rejects|rejected|rejecting|refuse|refuses|refused|error|errors|case|ticket|tickets|reference|ref|order|orders|call|calls|calling|phone|dial|desk|extension|invoice|statement)\b[^\n]{0,16}$/;

/** How much of the text either side of a number is read to decide what the number is. The text
 * before it never runs back past the start of that number's own line. */
const CODE_CONTEXT_CHARS = 64;

/** Blank out anything shaped like a telephone number, keeping the length of the text the same. */
function withoutTelephoneNumbers(text: string): string {
  TELEPHONE_WITH_BRACKETED_AREA_CODE.lastIndex = 0;
  TELEPHONE_STYLE.lastIndex = 0;
  return text
    .replace(TELEPHONE_WITH_BRACKETED_AREA_CODE, (run) => " ".repeat(run.length))
    .replace(TELEPHONE_STYLE, (run) => " ".repeat(run.length));
}

/**
 * True when the text holds a short code that is not a year, is not glued to other characters,
 * and is not part of a telephone number. Telephone-style runs of digits are blanked out first,
 * so a support number in the footer never counts as a code.
 */
function hasDeliverableCode(text: string): boolean {
  const searchable = withoutTelephoneNumbers(text);
  STANDALONE_CANDIDATE.lastIndex = 0;
  for (const match of searchable.matchAll(STANDALONE_CANDIDATE)) {
    if (!READS_AS_A_YEAR.test(match[0])) return true;
  }
  return false;
}

/**
 * True when the number sits alone on its own line and the line above it names a sign-in,
 * verification or two-step code, which is how many services lay a code out: "Here is your
 * verification code" and then the digits. A line that merely says "code" - "I cannot sign in
 * with this code:" - is someone asking for help, not a service handing one over.
 */
function standsAloneUnderWordingThatNamesACode(
  text: string,
  start: number,
  candidate: string
): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineBreak = text.indexOf("\n", start);
  const lineEnd = lineBreak === -1 ? text.length : lineBreak;
  if (text.slice(lineStart, lineEnd).trim() !== candidate) return false;
  const earlierLines = text
    .slice(0, lineStart)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lineAbove = earlierLines[earlierLines.length - 1];
  return lineAbove !== undefined && NAMES_A_CODE.test(lineAbove) && namesASignInCode(lineAbove);
}

/**
 * True when the text does not merely contain a short number, but actually hands it over as the
 * code: the number follows wording like "code is", "code:", "enter" or "use", or is named as
 * the code straight afterwards, or stands alone on a line under a sentence naming the code. A
 * number introduced as a case, ticket, reference, order or telephone line never counts, so a
 * support reply quoting a case number and a request for help with a refused code both come
 * through as ordinary mail.
 */
function handsOverACode(text: string): boolean {
  const searchable = withoutTelephoneNumbers(text);
  STANDALONE_CANDIDATE.lastIndex = 0;
  for (const match of searchable.matchAll(STANDALONE_CANDIDATE)) {
    const candidate = match[0];
    if (READS_AS_A_YEAR.test(candidate)) continue;
    const start = match.index ?? 0;
    const lineStart = searchable.lastIndexOf("\n", start - 1) + 1;
    const before = searchable.slice(Math.max(lineStart, start - CODE_CONTEXT_CHARS), start);
    if (THE_NUMBER_BELONGS_TO_SOMETHING_ELSE.test(before)) continue;
    const afterStart = start + candidate.length;
    const after = searchable.slice(afterStart, afterStart + CODE_CONTEXT_CHARS);
    if (HANDS_THE_CODE_OVER_BEFORE_IT.some((pattern) => pattern.test(before))) return true;
    if (HANDS_THE_CODE_OVER_AFTER_IT.test(after)) return true;
    if (standsAloneUnderWordingThatNamesACode(searchable, start, candidate)) return true;
  }
  return false;
}

/**
 * True when the subject line itself hands over a sign-in, verification or two-step code. It
 * must name that kind of code, word the line as a delivery ("your security code",
 * "774411 is your log-in code"), and not read as an announcement about codes in general
 * ("Security code policy update"), which is ordinary mail.
 */
function subjectNamesASignInCode(subject: string): boolean {
  const namesTheKindOfCode =
    SIGN_IN_CODE_PHRASES.some((phrase) => subject.includes(phrase)) || OTP_WORD.test(subject);
  if (!namesTheKindOfCode) return false;
  if (SUBJECT_IS_ABOUT_CODES_IN_GENERAL.test(subject)) return false;
  if (SUBJECT_IS_A_REPLY_OR_FORWARD.test(subject)) return false;
  if (SUBJECT_DISCUSSES_A_CODE.test(subject)) return false;
  return (
    SUBJECT_DELIVERS_A_CODE.some((pattern) => pattern.test(subject)) || hasDeliverableCode(subject)
  );
}

/**
 * Deterministic pre-check, run before any model call. It is true only when the subject itself
 * announces a sign-in code, a short code that is not a year is present, and nothing in the
 * whole message points at a door, a stay, an order, a delivery, a booking or a money-off code.
 * That is why "your apartment check-in instructions" and "your discount voucher" come through
 * even when they carry a one-time passcode, and why "we are changing how security codes are
 * delivered in 2026" comes through as well: it carries only a year.
 * Never logs the sender, subject or body it inspects — callers must not either.
 */
export function looksLikeOneTimeCodeEmail(message: OneTimeCodeEmailInput): boolean {
  const subject = message.subject.toLowerCase();
  if (!subjectNamesASignInCode(subject)) return false;
  const body = message.body.toLowerCase();
  if (NOT_A_SIGN_IN_MESSAGE.test(`${subject}\n${body}`)) return false;
  return handsOverACode(`${subject}\n${body.slice(0, OTP_CHECK_BODY_CHARS)}`);
}

/**
 * What to do with a message before any model call.
 *
 *  - "hands-over-a-code": the strict rule above fired. Set the message aside with no model call
 *    at all, exactly as before.
 *  - "unclear": the subject names a sign-in, verification or two-step code, but the strict rule
 *    did not fire. The message still goes through the ordinary analysis every other email gets,
 *    and the model is asked whether it really hands a code over.
 *  - "ordinary": nothing about the subject suggests a sign-in code. Handled as before.
 *
 * Never logs the sender, subject or body it inspects - callers must not either.
 */
export type SignInCodeDecision = "hands-over-a-code" | "unclear" | "ordinary";

export function signInCodeDecision(message: OneTimeCodeEmailInput): SignInCodeDecision {
  if (looksLikeOneTimeCodeEmail(message)) return "hands-over-a-code";
  const subject = message.subject.toLowerCase();
  const namesTheKindOfCode =
    SIGN_IN_CODE_PHRASES.some((phrase) => subject.includes(phrase)) || OTP_WORD.test(subject);
  return namesTheKindOfCode ? "unclear" : "ordinary";
}
