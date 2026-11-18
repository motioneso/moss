/** Pure helpers for the Briefings screens. No DOM, so they run under `node --test`. */

export const MORNING_NEWS_TOOL = "news.topHeadlinesToday";
export const MORNING_SPORTS_TOOL = "sports.followedFactsToday";
export const EVENING_SECTION_NAMES = [
  "What got done",
  "What slipped",
  "Carrying forward",
  "Needs your attention",
  "Tomorrow",
  "News & sports"
];

// ---- Settings ----

export function findDefinition(definitions, briefingType) {
  return definitions.find((definition) => definition.briefingType === briefingType);
}

export function defaultTime(briefingType) {
  return briefingType === "evening" ? "19:00" : "07:00";
}

export function targetTimeFor(definition, briefingType) {
  const raw = definition?.scheduleMetadata?.targetTime;
  return typeof raw === "string" && raw.length > 0 ? raw : defaultTime(briefingType);
}

export function toggleToolName(stored, toolName) {
  return stored.includes(toolName) ? stored.filter((n) => n !== toolName) : [...stored, toolName];
}

export function createRequest({ briefingType, enabled, targetTime, timezone }) {
  return {
    title: briefingType === "evening" ? "Evening review" : "Morning briefing",
    briefingType,
    cadence: "daily",
    enabled: enabled ?? true,
    scheduleMetadata: {
      targetTime: targetTime ?? defaultTime(briefingType),
      timezone: timezone ?? "America/Los_Angeles"
    }
  };
}

export function updateRequest(definition, patch) {
  const body = {};
  if (patch.enabled !== undefined) body.enabled = patch.enabled;
  if (patch.targetTime !== undefined) {
    body.scheduleMetadata = { ...definition.scheduleMetadata, targetTime: patch.targetTime };
  }
  if (patch.selectedToolNames !== undefined) body.selectedToolNames = patch.selectedToolNames;
  return body;
}

const MODULE_LABEL = {
  calendar: "Calendar",
  email: "Email",
  tasks: "Tasks",
  commitments: "Commitments",
  chat: "Chat",
  news: "News",
  sports: "Sports",
  weather: "Weather",
  goals: "Goals",
  notes: "Notes"
};

/** Module names behind the stored read tools, never the raw tool names. */
export function sourceLabels(toolNames) {
  const labels = new Set();
  for (const name of toolNames) {
    const prefix = String(name).split(".")[0];
    if (prefix) labels.add(MODULE_LABEL[prefix] ?? prefix[0].toUpperCase() + prefix.slice(1));
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

export function sourceListDescription(labels) {
  if (labels.length === 0) {
    return "No read-only sources configured yet. Briefings need at least one.";
  }
  const headline = `${labels.length} read-only source${labels.length === 1 ? "" : "s"} available for scheduled synthesis`;
  return `${headline}: ${labels.join(", ")}.`;
}

// ---- Report text ----

const OPENING_LABEL_LINE =
  /^\s*(?:#{1,6}[ \t]+)?(?:\*\*|__)?(?:headline|lead)(?:\*\*|__)?[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*\r?\n/i;
const OPENING_LABEL =
  /^\s*(?:\*\*|__)?(?:headline|lead)[ \t]*(?:(?:\*\*|__)[ \t]*:|:[ \t]*(?:\*\*|__)?)[ \t]*/i;

export function stripOpeningLabel(text) {
  return text.replace(OPENING_LABEL_LINE, "").replace(OPENING_LABEL, "").trim();
}

export function plainText(text) {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1");
}

function splitFirstSentence(text) {
  const ownLine = text.trim().match(/^([^\n]+)\r?\n\s*\n([\s\S]*)$/);
  const firstLine = ownLine?.[1]?.trim() ?? "";
  const rest = (ownLine?.[2] ?? "").trim();
  if (
    ownLine &&
    firstLine.length <= 140 &&
    !/^#{1,6}\s/.test(firstLine) &&
    rest !== "" &&
    !/^(#{1,6}\s|\*\*[^*\n]+\*\*\s*(\n|$))/.test(rest)
  ) {
    return { headline: firstLine, rest };
  }
  const match = text.match(/^(.*?[.!?])(\s+|$)([\s\S]*)$/);
  if (match) return { headline: (match[1] ?? "").trim(), rest: (match[3] ?? "").trim() };
  const line = text.match(/^(.*?)(\r?\n|$)([\s\S]*)$/);
  if (line && (line[1] ?? "").trim()) {
    return { headline: (line[1] ?? "").trim(), rest: (line[3] ?? "").trim() };
  }
  return { headline: text.trim(), rest: "" };
}

/** The first sentence or short first line as a headline, and the rest of the report. */
export function splitHeadline(text) {
  const split = splitFirstSentence(stripOpeningLabel(text));
  return { headline: plainText(split.headline), rest: stripOpeningLabel(split.rest) };
}

// ---- Sources ----

const SOURCE_LABEL = {
  email: "Email",
  calendar: "Calendar",
  calendar_today: "Today's schedule",
  weather: "Weather",
  calendar_tomorrow: "Tonight and tomorrow",
  email_today: "Today's email",
  morning_plan: "This morning's plan",
  tasks_reconciliation: "Task review",
  vault: "Notes",
  tasks: "Tasks",
  commitments: "Commitments",
  chats: "Chats",
  goals: "Goals",
  news: "News",
  sports: "Sports",
  day_plan: "Day plan"
};
export const sourceLabel = (source) => SOURCE_LABEL[source] ?? source;

const STALE_MS = 24 * 3600 * 1000;
const EMAIL_DELAY_MS = 3600 * 1000;

export function parseFreshness(sourceMetadata) {
  const ts = sourceMetadata?.sourceTimestamps;
  if (!ts || typeof ts !== "object" || Array.isArray(ts)) return null;
  if (ts.version !== 1 || typeof ts.capturedAt !== "string" || !Array.isArray(ts.sources)) {
    return null;
  }
  return ts;
}

export function formatAge(entry, capturedAt) {
  if (entry.freshnessKind === "realtime") return "live";
  if (!entry.asOf) return "unknown";
  const ageMs = new Date(capturedAt).getTime() - new Date(entry.asOf).getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

export function staleNames(freshness, exclude = []) {
  return freshness.sources
    .filter(
      (entry) =>
        !exclude.includes(entry.source) &&
        entry.freshnessKind !== "realtime" &&
        entry.asOf &&
        new Date(freshness.capturedAt).getTime() - new Date(entry.asOf).getTime() > STALE_MS
    )
    .map((entry) => sourceLabel(entry.source));
}

export function delayedEmail(freshness) {
  if (!freshness) return null;
  const email = freshness.sources.find((entry) => entry.source === "email");
  if (!email || email.freshnessKind === "realtime" || !email.asOf) return null;
  const captured = Date.parse(freshness.capturedAt);
  const asOf = Date.parse(email.asOf);
  if (!Number.isFinite(captured) || !Number.isFinite(asOf)) return null;
  return captured - asOf > EMAIL_DELAY_MS ? email : null;
}

export function readGaps(sourceMetadata) {
  const gaps = sourceMetadata?.gaps;
  if (!Array.isArray(gaps)) return [];
  return gaps.flatMap((gap) =>
    gap && typeof gap.source === "string" && typeof gap.reason === "string"
      ? [{ source: gap.source, reason: gap.reason }]
      : []
  );
}

export function readEditorial(sourceMetadata, key) {
  const block = sourceMetadata?.editorial?.[key];
  return block && typeof block === "object" && Array.isArray(block.stories) ? block : null;
}

const plural = (n, one, many) => (n === 1 ? one : (many ?? `${one}s`));
function countLine(n, one, tail, many) {
  if (!(n > 0)) return null;
  const noun = plural(n, one, many);
  return tail ? `${n} ${noun} ${tail}` : `${n} ${noun}`;
}
const count = (meta, key) => (Number.isFinite(meta?.[key]) && meta[key] > 0 ? meta[key] : 0);

/** One honest line per source for "What informed this briefing?". */
export function contributionFor(source, meta) {
  const blocked = readGaps(meta).some((g) => g.source === source && g.reason !== "truncated");
  if (blocked) return null;
  if (source === "calendar")
    return countLine(count(meta, "calendarTodayCount"), "event", "on today's schedule");
  if (source === "email" || source === "email_today") {
    return countLine(count(meta, "emailMessageCount"), "email", "read");
  }
  if (source === "weather") return "today's forecast";
  const lines = meta?.sectionLines?.[source];
  if (!(Number.isFinite(lines) && lines >= 0)) return null;
  if (lines === 0) return null;
  switch (source) {
    case "tasks":
      return countLine(lines, "task");
    case "commitments":
      return countLine(lines, "commitment");
    case "chats":
      return countLine(lines, "turn", "from today's chats");
    case "vault":
      return countLine(lines, "saved note");
    case "goals":
      return countLine(lines, "tracked goal");
    case "news":
      return countLine(lines, "top story", undefined, "top stories");
    case "sports":
      return countLine(lines, "sports update");
    case "calendar_today":
      return countLine(lines, "event", "in today's timeline");
    case "calendar_tomorrow":
      return countLine(lines, "event", "tonight or tomorrow");
    case "tasks_reconciliation":
      return countLine(lines, "task", "reviewed");
    case "morning_plan":
      return countLine(lines, "item", "from this morning's plan");
    default:
      return null;
  }
}

// ---- Dates ----

export function sameLocalDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function timeText(iso, locale) {
  return new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

export function monthDay(iso, locale) {
  return new Date(iso).toLocaleDateString(locale, { month: "long", day: "numeric" });
}

export function preparedAt(iso, locale) {
  return `Prepared at ${timeText(iso, locale)}`;
}

export function receivedLabel(iso, now, locale) {
  if (sameLocalDay(iso, now)) return timeText(iso, locale);
  const day = new Date(iso).toLocaleDateString(locale, { weekday: "short" });
  return `${day} ${timeText(iso, locale)}`;
}

export function sinceLabel(since, now, locale) {
  return since === null || since === undefined
    ? "today"
    : `since ${receivedLabel(since, now, locale)}`;
}

export function updatedAge(computedAt, now) {
  const stamp = Date.parse(computedAt);
  if (Number.isNaN(stamp)) return "unknown";
  const ageMs = Math.max(0, now - stamp);
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

export function actionMeta(row, now, locale) {
  const due = row.dueAt
    ? `Due ${new Date(row.dueAt).toLocaleDateString(locale, { month: "short", day: "numeric" })}`
    : null;
  const back =
    row.resurfaceReason === "due_tomorrow"
      ? "Back — due tomorrow"
      : row.resurfaceReason === "relevant_context"
        ? "Back — related to active work"
        : null;
  return [row.sourceLabel, due, `Updated ${updatedAge(row.computedAt, now)}`, back]
    .filter((part) => part !== null)
    .join(" · ");
}

// ---- Sports copy ----

export function finalsLines(games) {
  return games
    .filter((g) => g.phase === "final")
    .slice(0, 2)
    .map((g) => ({
      away: g.awayShort,
      awayScore: g.awayScore,
      home: g.homeShort,
      homeScore: g.homeScore
    }));
}

export function tonightLine(games, locale) {
  const tonight = games.filter((g) => g.phase === "tonight");
  if (tonight.length === 0) return null;
  return {
    heading: "Tonight",
    paragraph: tonight
      .map((g) => `${g.awayShort} at ${g.homeShort}, ${timeText(g.startsAt, locale)}`)
      .join("; ")
  };
}

/** The reply prompt the chat opens with, naming the email only by its cached id. */
export function replyPrompt(cacheMessageId) {
  return `Draft a reply to the cached email ${cacheMessageId} using email.draftReply.`;
}
