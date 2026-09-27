import { isNewsBriefingEvidence, isSportsBriefingEvidence, readPlanContext } from "@moss/shared";

// One honest line per source for the morning report's "What informed this
// briefing?" block. Every line comes from counts already saved on the run, so
// it names quantities, never topics. Null means the source contributed nothing
// usable and the row shows no contribution line.
export function contributionFor(
  source: string,
  sourceMetadata: Record<string, unknown>
): string | null {
  if (isGapListed(sourceMetadata, source)) return null;
  switch (source) {
    case "calendar":
      return (
        countLine(countOf(sourceMetadata, "calendarEventCount"), "event", "on today's schedule") ??
        countLine(arrayLength(sourceMetadata, "calendarSignals"), "event", "on today's schedule")
      );
    case "email":
      return (
        countLine(arrayLength(sourceMetadata, "emailSignals"), "actionable message") ??
        countLine(countOf(sourceMetadata, "emailMessageCount"), "message", "read")
      );
    case "tasks":
      return countLine(countOf(sourceMetadata, "taskCount"), "open task");
    case "commitments":
      return countLine(countOf(sourceMetadata, "commitmentCount"), "open commitment");
    case "chats":
      return countLine(countOf(sourceMetadata, "chatTurnCount"), "turn", "from today's chats");
    case "vault":
      return countLine(countOf(sourceMetadata, "vaultCount"), "saved note");
    case "goals":
      return countLine(countOf(sourceMetadata, "goalsCount"), "tracked goal");
    case "news": {
      const editorial = sourceMetadata.editorial;
      const stories =
        editorial && typeof editorial === "object" && !Array.isArray(editorial)
          ? (editorial as Record<string, unknown>).news
          : null;
      const count = isNewsBriefingEvidence(stories) ? stories.stories.length : 0;
      return countLine(count, "top story", undefined, "top stories");
    }
    case "sports": {
      const editorial = sourceMetadata.editorial;
      const block =
        editorial && typeof editorial === "object" && !Array.isArray(editorial)
          ? (editorial as Record<string, unknown>).sports
          : null;
      if (!isSportsBriefingEvidence(block)) return null;
      const parts = [
        countLine(block.games.length, "game"),
        countLine(block.stories.length, "story", undefined, "stories")
      ].filter((part): part is string => part !== null);
      return parts.length > 0 ? parts.join(" and ") : null;
    }
    case "day_plan": {
      const plan = readPlanContext({ planContext: sourceMetadata.planSnapshot });
      if (!plan || (plan.blocks.length === 0 && plan.eveningIntent == null)) return null;
      return countLine(plan.blocks.length, "time block", "from last evening");
    }
    default:
      return null;
  }
}

function isGapListed(sourceMetadata: Record<string, unknown>, source: string): boolean {
  const gaps = sourceMetadata.gaps;
  if (!Array.isArray(gaps)) return false;
  return gaps.some(
    (gap) =>
      gap !== null &&
      typeof gap === "object" &&
      !Array.isArray(gap) &&
      (gap as Record<string, unknown>).source === source
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
