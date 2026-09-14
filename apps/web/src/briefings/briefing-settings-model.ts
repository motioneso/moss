import type {
  AiAssistantToolDto,
  BriefingDefinitionDto,
  BriefingType,
  CreateBriefingDefinitionRequest,
  UpdateBriefingDefinitionRequest
} from "@moss/shared";

export function findDefinition(
  definitions: readonly BriefingDefinitionDto[],
  briefingType: BriefingType
): BriefingDefinitionDto | undefined {
  return definitions.find((definition) => definition.briefingType === briefingType);
}

export function defaultScheduleMetadataFor(
  briefingType: BriefingType,
  timezone?: string
): {
  readonly targetTime: string;
  readonly timezone: string;
} {
  return {
    targetTime: briefingType === "evening" ? "19:00" : "07:00",
    timezone: timezone ?? "America/Los_Angeles"
  };
}

export function targetTimeFor(definition: BriefingDefinitionDto | undefined, type: BriefingType) {
  const raw = definition?.scheduleMetadata.targetTime;
  return typeof raw === "string" && raw.length > 0
    ? raw
    : defaultScheduleMetadataFor(type).targetTime;
}

export function readToolNames(tools: readonly AiAssistantToolDto[]): readonly string[] {
  return tools
    .filter((tool) => tool.risk === "read")
    .map((tool) => tool.name)
    .sort();
}

/**
 * Human-readable, deduplicated module labels for the read-only tools available to briefings
 * (e.g. "Calendar", "Email", "Tasks"). Derived from `AiAssistantToolDto.moduleName`, which is
 * the module's own display name — never the raw function/method-style `tool.name` (e.g.
 * `calendar.listVisibleEvents`). This is presentation-only: it does not change which tool IDs
 * are selected/stored for briefing creation (see `readToolNames`).
 */
export function readSourceLabels(tools: readonly AiAssistantToolDto[]): readonly string[] {
  const labels = new Set(
    tools.filter((tool) => tool.risk === "read").map((tool) => tool.moduleName)
  );
  return Array.from(labels).sort((a, b) => a.localeCompare(b));
}

/**
 * Renders the Sources card copy from human-readable module labels (e.g. "Calendar", "Email") —
 * never from raw assistant tool/function names such as `calendar.listVisibleEvents`. Callers
 * must pass labels already produced by `readSourceLabels`, not `readToolNames`.
 */
export function sourceListDescription(labels: readonly string[]): string {
  if (labels.length === 0) {
    return "No read-only sources configured yet. Briefings need at least one.";
  }
  const headline = `${labels.length} read-only source${labels.length === 1 ? "" : "s"} available for scheduled synthesis`;
  return `${headline}: ${labels.join(", ")}.`;
}

export const MORNING_NEWS_TOOL = "news.topHeadlinesToday";
export const MORNING_SPORTS_TOOL = "sports.followedFactsToday";

/** Toggle one tool name in a stored selection, keeping the rest in order. */
export function toggleToolName(stored: readonly string[], toolName: string): string[] {
  return stored.includes(toolName)
    ? stored.filter((name) => name !== toolName)
    : [...stored, toolName];
}

export function createDefinitionRequest(input: {
  readonly briefingType: BriefingType;
  readonly enabled?: boolean;
  readonly targetTime?: string;
  readonly selectedToolNames?: readonly string[];
  readonly timezone?: string;
}): CreateBriefingDefinitionRequest {
  const defaults = defaultScheduleMetadataFor(input.briefingType, input.timezone);
  return {
    title: input.briefingType === "evening" ? "Evening review" : "Morning briefing",
    briefingType: input.briefingType,
    cadence: "daily",
    enabled: input.enabled ?? true,
    scheduleMetadata: { ...defaults, targetTime: input.targetTime ?? defaults.targetTime },
    // Omitted (not undefined-valued) so the server default rule applies.
    ...(input.selectedToolNames !== undefined ? { selectedToolNames: input.selectedToolNames } : {})
  };
}

export function updateDefinitionRequest(
  definition: BriefingDefinitionDto,
  patch: {
    readonly enabled?: boolean;
    readonly targetTime?: string;
    readonly selectedToolNames?: readonly string[];
  }
): UpdateBriefingDefinitionRequest {
  return {
    enabled: patch.enabled,
    scheduleMetadata:
      patch.targetTime === undefined
        ? undefined
        : { ...definition.scheduleMetadata, targetTime: patch.targetTime },
    // Only the inclusion switches pass a list; time and enabled edits omit it
    // so the stored list is kept.
    ...(patch.selectedToolNames !== undefined ? { selectedToolNames: patch.selectedToolNames } : {})
  };
}
