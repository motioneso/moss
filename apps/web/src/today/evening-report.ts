import { EVENING_SECTION_HEADERS } from "@moss/shared";

import { plainBriefingText } from "./briefing-markdown.js";

/** The evening report cut into the pieces Today shows. Each field is plain
    text for one slot; an empty string means the slot shows nothing. */
export interface EveningReportParts {
  /** Opening verdict before the first section header. */
  readonly verdict: string;
  /** Prose of the "What got done" section, without its list items. */
  readonly recap: string;
  /** Prose of the "Carrying forward" section, without its list items. */
  readonly openLoops: string;
}

const KNOWN_HEADERS = new Map(
  Object.values(EVENING_SECTION_HEADERS).map((header) => [header.toLowerCase(), header])
);

/** Section name for a header line, or null for a body line. A markdown
    heading of any name ends the previous section. A bold line counts when it
    names an evening section. A bare line counts only when it names one and
    starts a paragraph, so a lone "Tomorrow" inside prose stays prose. */
function headerName(line: string, startsParagraph: boolean): string | null {
  const trimmed = line.trim();
  const markdown = /^#{1,6}\s+(.*)$/.exec(trimmed);
  const bold = /^(\*\*|__)(.+?):?\1:?$/.exec(trimmed);
  const bare = (markdown?.[1] ?? bold?.[2] ?? trimmed).replace(/:$/, "").trim();
  const known = KNOWN_HEADERS.get(bare.toLowerCase());
  if (known && (markdown || bold || startsParagraph)) return known;
  return markdown ? bare : null;
}

/** First paragraph that is prose, not a list. The list items are shown as
    rows elsewhere on Today, so repeating them here would duplicate them. */
function leadProse(lines: readonly string[]): string {
  const paragraphs = lines.join("\n").split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const prose = paragraph
      .split("\n")
      .filter((line) => line.trim() !== "" && !/^\s*([-*+]|\d+[.)])\s/.test(line));
    if (prose.length > 0) return plainBriefingText(prose.join(" ")).replace(/\s+/g, " ").trim();
  }
  return "";
}

export function splitEveningReport(text: string): EveningReportParts {
  const verdict: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string[] = verdict;
  let previous = "";
  for (const line of text.split(/\r?\n/)) {
    const name = headerName(line, previous.trim() === "");
    previous = line;
    if (name === null) {
      current.push(line);
      continue;
    }
    current = [];
    if (!sections.has(name)) sections.set(name, current);
  }
  return {
    verdict: verdict.join("\n").trim(),
    recap: leadProse(sections.get(EVENING_SECTION_HEADERS.whatGotDone) ?? []),
    openLoops: leadProse(sections.get(EVENING_SECTION_HEADERS.carryingForward) ?? [])
  };
}
