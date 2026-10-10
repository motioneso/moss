// #3309: bounded recognizer for one explicit relative reminder in a raw Main chat request.
// It reads only the user's own words. No model output, retrieval or tool result reaches it.

export const REMINDER_MIN_DELAY_SECONDS = 1;
export const REMINDER_MAX_DELAY_SECONDS = 2_592_000;
export const REMINDER_MAX_TEXT_LENGTH = 500;

const MAX_REQUEST_LENGTH = 700;

export type ReminderUnsupportedReason =
  | "needs_relative_duration"
  | "out_of_range"
  | "text_length"
  | "clock_or_recurrence"
  | "ambiguous";

export type ReminderRecognition =
  | { kind: "none" }
  | { kind: "unsupported"; reason: ReminderUnsupportedReason }
  | { kind: "request"; delaySeconds: number; text: string };

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86_400,
  day: 86_400,
  days: 86_400
};

const UNIT = "(s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|d|days?)";
const DURATION = `(\\d{1,8}) ?${UNIT}`;
const JOINER = "(?: ?(?:,|:|to|that|about))?";

const LEADING_FILLER =
  /^(?:(?:hey|hi|ok|okay)(?: moss)?[, ]+|moss[, ]+|please[, ]+|(?:can|could|would|will) you(?: please)?[, ]+)+/;
const TRAILING_FILLER = /(?:[, ]+(?:please|thanks|thank you))+$/;

const TRIGGER = /^(?:remind me|set (?:a|me a) reminder)\b/;

const FORMS: readonly RegExp[] = [
  new RegExp(`^remind me in ${DURATION}${JOINER} (.+)$`),
  new RegExp(`^remind me (?:to|that|about) (.+) in ${DURATION}$`),
  new RegExp(`^set (?:a|me a) reminder (?:for|in) ${DURATION}${JOINER} (.+)$`),
  new RegExp(`^set (?:a|me a) reminder (?:to|that|about) (.+) in ${DURATION}$`)
];

const DURATION_FIRST = new Set([0, 2]);

const SECOND_DURATION = new RegExp(`\\b(?:in|after|within) ${DURATION}\\b`);

// Hedges inside the reminder text, after a duration matched: "or so", "-ish", "or maybe 10".
// "order 2 or 3 pizzas" stays plain text because the alternative is not a time.
const OR_HEDGE = "or (?:maybe |perhaps |possibly |probably |even )?(?:in |after )?";
const TEXT_HEDGES: readonly RegExp[] = [
  /\bor so\b/,
  /\bish\b/,
  new RegExp(`\\b${OR_HEDGE}\\d+(?: ?${UNIT})?$`),
  new RegExp(`\\b${OR_HEDGE}\\d+ ?${UNIT}\\b`),
  new RegExp(`\\b${OR_HEDGE}(?:an? |half an? )?(?:second|minute|hour|day)s?\\b`),
  new RegExp(`\\b${OR_HEDGE}(?:later|sooner|earlier)\\b`)
];

// Hedges anywhere in a request that names a duration but fits no form: "in 5 or 10 minutes".
const ANY_DURATION = new RegExp(`\\b\\d{1,8}(?: ?-?ish)? ?${UNIT}\\b`);
const ANY_HEDGE =
  /\bor\b|\bmaybe\b|\bperhaps\b|\bish\b|\b(?:about|around|roughly|approximately|like) \d|\d ?(?:-|to) ?\d/;

// A request with no form match is still a reminder request when it says what to do or when.
// Anything else ("remind me the name of that restaurant") is ordinary chat for the model.
const TASK_LEAD = /^(?:to|that)\b/;
const RECALL_LEAD = /^(?:what|how|who|whom|whose|where|when|why|which|whether|if|again)\b/;
const TIME_CUE =
  /\b(?:in|after|within|for) (?:\d|an?\b|half\b|a few\b|a couple\b|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty)|\b(?:later|soon|tomorrow|tonight|next|every|each|daily|weekly|monthly|hourly)\b|\b(?:at|by|before|until) \d|\b\d{1,2}(?::\d{2}) ?(?:am|pm)?\b|\b\d{1,2} ?(?:am|pm)\b/;
const CLOCK_OR_RECURRENCE =
  /\b(?:every|each|daily|weekly|monthly|hourly|tomorrow|tonight)\b|\b(?:at|by|before|until) \d{1,2}(?::\d{2})? ?(?:am|pm)?\b|\b\d{1,2}(?::\d{2}) ?(?:am|pm)?\b|\b\d{1,2} ?(?:am|pm)\b/;

export function recognizeRelativeReminder(raw: string): ReminderRecognition {
  if (raw.length > MAX_REQUEST_LENGTH) {
    return TRIGGER.test(normalize(raw.slice(0, 120)))
      ? { kind: "unsupported", reason: "text_length" }
      : { kind: "none" };
  }

  const request = normalize(raw);
  if (!TRIGGER.test(request)) return { kind: "none" };

  for (const [index, form] of FORMS.entries()) {
    const match = form.exec(request);
    if (!match) continue;

    const [amount, unit, text] = DURATION_FIRST.has(index)
      ? [match[1], match[2], match[3]]
      : [match[2], match[3], match[1]];
    if (amount === undefined || unit === undefined || text === undefined) continue;
    return buildRequest(Number(amount), unit, text, raw);
  }

  return fallback(request);
}

function fallback(request: string): ReminderRecognition {
  if (ANY_DURATION.test(request) && ANY_HEDGE.test(request)) {
    return { kind: "unsupported", reason: "ambiguous" };
  }
  if (request.startsWith("set ")) return { kind: "unsupported", reason: "needs_relative_duration" };

  const rest = request.replace(/^remind me\b[ ,:;]*/, "");
  if (TASK_LEAD.test(rest)) return { kind: "unsupported", reason: "needs_relative_duration" };
  if (RECALL_LEAD.test(rest)) return { kind: "none" };
  return TIME_CUE.test(rest)
    ? { kind: "unsupported", reason: "needs_relative_duration" }
    : { kind: "none" };
}

function buildRequest(
  amount: number,
  unit: string,
  normalizedText: string,
  raw: string
): ReminderRecognition {
  const delaySeconds = amount * (UNIT_SECONDS[unit] ?? 0);
  if (
    !Number.isSafeInteger(delaySeconds) ||
    delaySeconds < REMINDER_MIN_DELAY_SECONDS ||
    delaySeconds > REMINDER_MAX_DELAY_SECONDS
  ) {
    return { kind: "unsupported", reason: "out_of_range" };
  }
  if (normalizedText.includes("?") || CLOCK_OR_RECURRENCE.test(normalizedText)) {
    return { kind: "unsupported", reason: "clock_or_recurrence" };
  }
  if (
    SECOND_DURATION.test(normalizedText) ||
    TEXT_HEDGES.some((hedge) => hedge.test(normalizedText))
  ) {
    return { kind: "unsupported", reason: "ambiguous" };
  }

  const text = originalCaseText(raw, normalizedText);
  if (text.length < 1 || text.length > REMINDER_MAX_TEXT_LENGTH) {
    return { kind: "unsupported", reason: "text_length" };
  }
  return { kind: "request", delaySeconds, text };
}

function normalize(raw: string): string {
  let text = raw.toLowerCase().replace(/\s+/g, " ").trim();
  text = text.replace(/[.!?]+$/, "").trim();
  text = text.replace(LEADING_FILLER, "");
  text = text
    .replace(TRAILING_FILLER, "")
    .replace(/[.!?]+$/, "")
    .trim();
  return text;
}

// The saved text keeps the user's own capitalisation. Normalisation only lowercases and
// collapses whitespace, so the text is found again in the whitespace-collapsed original.
function originalCaseText(raw: string, normalizedText: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.toLowerCase().length !== collapsed.length) return normalizedText;
  const start = collapsed.toLowerCase().lastIndexOf(normalizedText);
  const text = start >= 0 ? collapsed.slice(start, start + normalizedText.length) : normalizedText;
  return text.trim();
}
