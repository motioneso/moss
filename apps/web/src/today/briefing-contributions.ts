import { isNewsBriefingEvidence, isSportsBriefingEvidence, readPlanContext } from "@moss/shared";

// One honest line per source for the morning report's "What informed this
// briefing?" block. What each number measures: lines the section gave the
// synthesis prompt for THIS report (saved as sectionLines), never the raw
// holdings behind a section. Runs saved before sectionLines fall back to the
// closest saved figure with neutral nouns. A source the section flags empty
// or failed shows no line either way, so the row always agrees with the gap
// note; a truncated source still names the lines the report got.
export function contributionFor(
  source: string,
  sourceMetadata: Record<string, unknown>
): string | null {
  if (hasBlockingGap(sourceMetadata, source)) return null;
  if (source === "day_plan") {
    const lines = sectionLineCount(sourceMetadata, source);
    if (lines !== undefined && lines === 0) return null;
    return dayPlanBlocks(sourceMetadata);
  }
  const lines = sectionLineCount(sourceMetadata, source);
  if (lines !== undefined) {
    if (lines === 0) return null;
    return lineFor(source, lines);
  }
  return legacyLineFor(source, sourceMetadata);
}

function lineFor(source: string, lines: number): string | null {
  switch (source) {
    case "calendar":
      return countLine(lines, "event", "on today's schedule");
    case "email":
      return countLine(lines, "actionable message");
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
    default:
      return null;
  }
}

// Runs saved before sectionLines: closest saved figure, neutral nouns, never
// the raw 48-hour calendar event count or the unfiltered email message count.
function legacyLineFor(source: string, sourceMetadata: Record<string, unknown>): string | null {
  switch (source) {
    case "calendar":
      return countLine(
        arrayLength(sourceMetadata, "calendarSignals"),
        "event",
        "on today's schedule"
      );
    case "email":
      return countLine(arrayLength(sourceMetadata, "emailSignals"), "actionable message");
    case "tasks":
      return countLine(countOf(sourceMetadata, "taskCount"), "task");
    case "commitments":
      return countLine(countOf(sourceMetadata, "commitmentCount"), "commitment");
    case "chats":
      return countLine(countOf(sourceMetadata, "chatTurnCount"), "turn", "from today's chats");
    case "vault":
      return countLine(countOf(sourceMetadata, "vaultCount"), "saved note");
    case "goals":
      return countLine(countOf(sourceMetadata, "goalsCount"), "tracked goal");
    case "news": {
      const stories = newsStories(sourceMetadata);
      return stories === null ? null : countLine(stories, "top story", undefined, "top stories");
    }
    case "sports": {
      const evidence = sportsEvidence(sourceMetadata);
      if (!evidence) return null;
      const parts = [
        countLine(evidence.games, "game"),
        countLine(evidence.stories, "story", undefined, "stories")
      ].filter((part): part is string => part !== null);
      return parts.length > 0 ? parts.join(" and ") : null;
    }
    default:
      return null;
  }
}

// The day plan names saved evening blocks.
function dayPlanBlocks(sourceMetadata: Record<string, unknown>): string | null {
  const plan = readPlanContext({ planContext: sourceMetadata.planSnapshot });
  if (!plan || plan.blocks.length === 0) return null;
  return countLine(plan.blocks.length, "time block", "from last evening");
}

function sectionLineCount(
  sourceMetadata: Record<string, unknown>,
  source: string
): number | undefined {
  const sectionLines = sourceMetadata.sectionLines;
  if (!sectionLines || typeof sectionLines !== "object" || Array.isArray(sectionLines)) {
    return undefined;
  }
  const value = (sectionLines as Record<string, unknown>)[source];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function newsStories(sourceMetadata: Record<string, unknown>): number | null {
  const editorial = sourceMetadata.editorial;
  const block =
    editorial && typeof editorial === "object" && !Array.isArray(editorial)
      ? (editorial as Record<string, unknown>).news
      : null;
  return isNewsBriefingEvidence(block) ? block.stories.length : null;
}

function sportsEvidence(
  sourceMetadata: Record<string, unknown>
): { games: number; stories: number } | null {
  const editorial = sourceMetadata.editorial;
  const block =
    editorial && typeof editorial === "object" && !Array.isArray(editorial)
      ? (editorial as Record<string, unknown>).sports
      : null;
  if (!isSportsBriefingEvidence(block)) return null;
  return { games: block.games.length, stories: block.stories.length };
}

// Every gap except truncation blocks the line: "empty" and failure reasons
// mean the report got nothing usable from this source, and the row must agree
// with the gap note. A truncated source still gave the report its capped
// lines, so the line names those.
function hasBlockingGap(sourceMetadata: Record<string, unknown>, source: string): boolean {
  const gaps = sourceMetadata.gaps;
  if (!Array.isArray(gaps)) return false;
  return gaps.some(
    (gap) =>
      gap !== null &&
      typeof gap === "object" &&
      !Array.isArray(gap) &&
      (gap as Record<string, unknown>).source === source &&
      (gap as Record<string, unknown>).reason !== "truncated"
  );
}

function countOf(sourceMetadata: Record<string, unknown>, key: string): number {
  const value = sourceMetadata[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function arrayLength(sourceMetadata: Record<string, unknown>, key: string): number {
  const value = sourceMetadata[key];
  return Array.isArray(value) ? value.length : 0;
}

function plural(count: number, singular: string, pluralForm?: string): string {
  if (count === 1) return singular;
  return pluralForm ?? `${singular}s`;
}

function countLine(
  count: number,
  singular: string,
  tail?: string,
  pluralForm?: string
): string | null {
  if (count <= 0) return null;
  const noun = plural(count, singular, pluralForm);
  return tail ? `${count} ${noun} ${tail}` : `${count} ${noun}`;
}
