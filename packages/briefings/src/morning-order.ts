// Deterministic tidy of the morning briefing text after the model writes it (#2775).
//
// Cheap models ignore the clock-order and no-filler rules in the prompt, so this step
// enforces them. It only acts when sure; anything unclear is left exactly as written.

const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i;
const TAIL_HEADING = /\b(news|sports?)\b/i;

// Words that may surround a restated event title without adding information.
const FILLER = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "has",
  "have",
  "been",
  "scheduled",
  "planned",
  "booked",
  "today",
  "this",
  "morning",
  "afternoon",
  "evening",
  "at",
  "on",
  "for",
  "you",
  "your",
  "there",
  "s",
  "and",
  "to",
  "from",
  "until",
  "am",
  "pm"
]);

interface Section {
  readonly heading: string;
  readonly body: string;
  readonly raw: string;
}

function minutesOf(section: Section): number | null {
  const match = TIME.exec(`${section.heading}\n${section.body}`);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = match[3]!.toUpperCase() === "PM";
  return ((hour % 12) + (pm ? 12 : 0)) * 60 + minute;
}

function onlyRestatesTitle(section: Section, titles: readonly string[]): boolean {
  const body = section.body.trim();
  if (body === "" || /\n|^[-*]\s/.test(body)) return false;
  if ((body.match(/[.!?](\s|$)/g) ?? []).length > 1) return false;
  let rest = body.toLowerCase();
  let matched = false;
  for (const title of titles) {
    const needle = title.trim().toLowerCase();
    if (needle !== "" && rest.includes(needle)) {
      rest = rest.split(needle).join(" ");
      matched = true;
    }
  }
  if (!matched) return false;
  const words = rest
    .replace(TIME, " ")
    .replace(/\d{1,2}(:\d{2})?/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  return words.every((word) => FILLER.has(word));
}

/**
 * Puts timed sections in clock order, leaves untimed sections after them and News/Sports
 * last, and drops a section whose body only restates an event title. Text with no `##`
 * sections is returned unchanged.
 */
export function tidyMorningSections(text: string, eventTitles: readonly string[]): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("## "));
  if (first === -1) return text;

  const preamble = lines.slice(0, first).join("\n");
  const sections: Section[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    sections.push({
      heading: current[0]!,
      body: current.slice(1).join("\n"),
      raw: current.join("\n").replace(/\s+$/, "")
    });
    current = [];
  };
  for (const line of lines.slice(first)) {
    if (line.startsWith("## ")) flush();
    current.push(line);
  }
  flush();

  const kept = sections.filter((section) => !onlyRestatesTitle(section, eventTitles));
  const tail = kept.filter((section) => TAIL_HEADING.test(section.heading));
  const main = kept.filter((section) => !TAIL_HEADING.test(section.heading));
  const timed = main
    .map((section, index) => ({ section, index, at: minutesOf(section) }))
    .filter((entry) => entry.at !== null)
    .sort((a, b) => a.at! - b.at! || a.index - b.index)
    .map((entry) => entry.section);
  const untimed = main.filter((section) => minutesOf(section) === null);

  const ordered = [...timed, ...untimed, ...tail].map((section) => section.raw).join("\n\n");
  return preamble === "" ? ordered : `${preamble.replace(/\s+$/, "")}\n\n${ordered}`;
}
