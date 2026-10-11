/**
 * #2956 (slice D): the Activity page filter bar state. The filter choice saves per user in
 * local storage under a key carrying the user id, storing UNTICKED models so a model added
 * later shows by default. Unknown saved values are dropped on load.
 */

export type ActivityDateRange = "today" | "7d" | "30d" | "90d";

/** Module filter value for the admin-only ownerless-lines option. */
export const SYSTEM_MODULE_FILTER = "system";

/** Model-filter key for tool rows, which ran with no model. */
export const NO_MODEL_FILTER_KEY = "no-model";

export interface ActivityFilters {
  readonly range: ActivityDateRange;
  /** "" shows every module; "system" shows ownerless lines for admins. */
  readonly module: string;
  /** Model names (or NO_MODEL_FILTER_KEY) hidden from the list. */
  readonly untickedModels: readonly string[];
}

export const DEFAULT_ACTIVITY_FILTERS: ActivityFilters = {
  range: "30d",
  module: "",
  untickedModels: []
};

const RANGES: readonly ActivityDateRange[] = ["today", "7d", "30d", "90d"];

export interface ActivityFilterStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

const STORAGE_PREFIX = "jarvis.settings:v1:activity-filters";

export function storageKeyForActivityFilters(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

export function saveActivityFilters(
  storage: ActivityFilterStorage | null,
  userId: string,
  filters: ActivityFilters
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKeyForActivityFilters(userId), JSON.stringify(filters));
  } catch {
    // Storage may be disabled; filters remain usable as in-memory state.
  }
}

/**
 * Restore saved filters, dropping anything the current data no longer names: unticked
 * models outside knownModels, a module outside knownModules, or a range outside the bar.
 */
export function loadActivityFilters(
  storage: ActivityFilterStorage | null,
  userId: string,
  knownModels: readonly string[],
  knownModules: readonly string[]
): ActivityFilters {
  if (!storage) return DEFAULT_ACTIVITY_FILTERS;
  let raw: string | null;
  try {
    raw = storage.getItem(storageKeyForActivityFilters(userId));
  } catch {
    return DEFAULT_ACTIVITY_FILTERS;
  }
  if (!raw) return DEFAULT_ACTIVITY_FILTERS;
  let saved: Partial<ActivityFilters>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_ACTIVITY_FILTERS;
    saved = parsed as Partial<ActivityFilters>;
  } catch {
    return DEFAULT_ACTIVITY_FILTERS;
  }
  const range: ActivityDateRange = RANGES.includes(saved.range as ActivityDateRange)
    ? (saved.range as ActivityDateRange)
    : DEFAULT_ACTIVITY_FILTERS.range;
  const module =
    typeof saved.module === "string" &&
    (saved.module === "" ||
      saved.module === SYSTEM_MODULE_FILTER ||
      knownModules.includes(saved.module))
      ? saved.module
      : DEFAULT_ACTIVITY_FILTERS.module;
  const untickedModels = Array.isArray(saved.untickedModels)
    ? saved.untickedModels.filter(
        (name): name is string =>
          typeof name === "string" && (name === NO_MODEL_FILTER_KEY || knownModels.includes(name))
      )
    : DEFAULT_ACTIVITY_FILTERS.untickedModels;
  return { range, module, untickedModels };
}

/** Reset filters shows whenever any filter differs from the default. */
export function isDefaultActivityFilters(filters: ActivityFilters): boolean {
  return (
    filters.range === DEFAULT_ACTIVITY_FILTERS.range &&
    filters.module === DEFAULT_ACTIVITY_FILTERS.module &&
    filters.untickedModels.length === 0
  );
}

/** The Models button reads "Models: all" or "Models: X of Y"; the count includes No model. */
export function modelsButtonLabel(tickedCount: number, totalCount: number): string {
  if (tickedCount >= totalCount) return "Models: all";
  return `Models: ${tickedCount} of ${totalCount}`;
}

/**
 * Which module a line belongs to for the module filter, by action code. Null when no
 * module owns the line (reachability probes) or the service is not mapped yet: those
 * lines show unfiltered only.
 */
export function lineActivityModule(actionCode: string | null): string | null {
  if (!actionCode) return null;
  if (actionCode === "chat.answer" || actionCode === "chat.tool_check") return "ai";
  if (actionCode.startsWith("embed.")) return "memory";
  if (actionCode === "transcribe.meeting") return "meetings";
  if (actionCode === "transcribe.voice_note") return "ai";
  if (actionCode === "module.build") return "workshop";
  if (actionCode === "probe.reachable") return null;
  if (actionCode === "task.commitment-extract") return "jarvis.commitments";
  if (actionCode === "task.memory-extract") return "memory";
  if (actionCode === "task.task-search") return "tasks";
  if (actionCode.startsWith("structured.")) {
    const service = actionCode.slice("structured.".length);
    switch (service) {
      case "briefings":
        return "briefings";
      case "news":
        return "news";
      case "sports":
        return "sports";
      case "workshop":
        return "workshop";
      case "web-research":
        return "web";
      case "moss.workshop-build-plan":
        return "ai";
      default:
        break;
    }
    if (service.startsWith("connectors.")) return "connectors";
    if (service.startsWith("commitments.")) return "jarvis.commitments";
    return null;
  }
  return null;
}

/** A tool row hides under the model filter only when "No model" is unticked. */
export function toolRowHiddenByModelFilter(untickedModels: readonly string[]): boolean {
  return untickedModels.includes(NO_MODEL_FILTER_KEY);
}
