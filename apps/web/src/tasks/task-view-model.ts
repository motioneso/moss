import {
  localDay,
  quadrantOf,
  type TaskDto,
  type TaskListDto,
  type TaskQuadrant,
  type TaskSearchIntent
} from "@moss/shared";

import { matchesFocus, type TaskFocus } from "./focus.js";

export const statusFilters = ["all", "todo", "suggested", "done", "archived"] as const;
export type StatusFilter = (typeof statusFilters)[number];
export type ListState = "included" | "solo" | "excluded";

export interface TaskFilterInput {
  readonly tasks: readonly TaskDto[];
  readonly lists: readonly TaskListDto[];
  readonly statusFilter: StatusFilter;
  readonly focus: TaskFocus | null;
  readonly listStates: Readonly<Record<string, ListState>>;
  readonly tagFilter: readonly string[];
  readonly search: string;
  readonly searchIntent?: TaskSearchIntent | null;
  /** Persisted user IANA timezone for the date-based focus filters (#579). */
  readonly timeZone?: string;
}

export interface TaskFilterResult {
  readonly visibleTasks: readonly TaskDto[];
  readonly allTags: readonly string[];
  readonly soloIds: readonly string[];
  readonly listCounts: Record<string, number>;
  readonly listCountTotal: number;
}

type QuadrantTaskGroups = Record<TaskQuadrant, TaskDto[]>;

export function deriveTaskFilters(input: TaskFilterInput): TaskFilterResult {
  // An interpreted query owns the literal text: text null means no residual text search.
  const needle = (input.searchIntent ? (input.searchIntent.text ?? "") : input.search)
    .trim()
    .toLowerCase();
  const tagSet = new Set(input.tagFilter);
  const soloIds = input.lists
    .filter((list) => input.listStates[list.id] === "solo")
    .map((list) => list.id);
  const soloSet = new Set(soloIds);
  const anySolo = soloSet.size > 0;
  const allTags = new Set<string>();
  const listCounts = Object.fromEntries(input.lists.map((list) => [list.id, 0]));
  const visibleTasks: TaskDto[] = [];

  for (const task of input.tasks) {
    for (const tag of task.tags) allTags.add(tag.name);
    if (task.parentTaskId !== null) continue;

    const matchesStatusOrFocus = input.focus
      ? matchesFocus(task, input.focus, input.timeZone)
      : input.statusFilter === "all" || task.status === input.statusFilter;
    if (!matchesStatusOrFocus) continue;

    const matchesTags = tagSet.size === 0 || task.tags.some((tag) => tagSet.has(tag.name));
    if (!matchesTags) continue;

    if (Object.hasOwn(listCounts, task.listId)) {
      listCounts[task.listId] = (listCounts[task.listId] ?? 0) + 1;
    }

    const listState = input.listStates[task.listId] ?? "included";
    if (listState === "excluded") continue;
    if (anySolo && !soloSet.has(task.listId)) continue;
    if (needle && !matchesSearch(task, needle)) continue;
    if (input.searchIntent && !matchesSearchIntent(task, input.searchIntent, input.timeZone)) {
      continue;
    }

    visibleTasks.push(task);
  }

  return {
    visibleTasks,
    allTags: [...allTags].sort((left, right) => left.localeCompare(right)),
    soloIds,
    listCounts,
    listCountTotal: Object.values(listCounts).reduce((sum, count) => sum + count, 0)
  };
}

export function groupTasksByQuadrant(tasks: readonly TaskDto[]): QuadrantTaskGroups {
  const groups: QuadrantTaskGroups = {
    do: [],
    schedule: [],
    delegate: [],
    eliminate: []
  };

  for (const task of tasks) {
    groups[quadrantOf(task)].push(task);
  }

  for (const group of Object.values(groups)) {
    group.sort(byDueThenTitle);
  }

  return groups;
}

function matchesSearch(task: TaskDto, needle: string): boolean {
  return (
    task.title.toLowerCase().includes(needle) ||
    (task.description?.toLowerCase().includes(needle) ?? false)
  );
}

function matchesSearchIntent(task: TaskDto, intent: TaskSearchIntent, timeZone?: string): boolean {
  if (intent.status && task.status !== intent.status) return false;
  if (intent.effort && task.effort !== intent.effort) return false;
  if (intent.priority !== null && task.priority !== intent.priority) return false;
  if (intent.quadrant && quadrantOf(task) !== intent.quadrant) return false;
  if (intent.listIds.length > 0 && !intent.listIds.includes(task.listId)) return false;
  if (intent.tagNames.length > 0) {
    const taskTags = new Set(task.tags.map((tag) => tag.name.toLowerCase()));
    if (!intent.tagNames.every((tag) => taskTags.has(tag.toLowerCase()))) return false;
  }
  if (!matchesDueIntent(task, intent.due, timeZone)) return false;
  return true;
}

function matchesDueIntent(task: TaskDto, due: TaskSearchIntent["due"], timeZone?: string): boolean {
  if (!due) return true;
  if (due.kind === "none") return task.dueAt === null;
  if (!task.dueAt) return false;

  const today = localDay(new Date(), timeZone);
  const dueKey = localDay(task.dueAt, timeZone);
  if (due.kind === "overdue") return dueKey < today;
  if (due.kind === "today") return dueKey === today;
  if (due.kind === "this_week") return dueKey >= today && dueKey <= addDaysKey(today, 6);
  return (
    (due.dueAfter === null || dueKey >= due.dueAfter) &&
    (due.dueBefore === null || dueKey <= due.dueBefore)
  );
}

function addDaysKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function byDueThenTitle(left: TaskDto, right: TaskDto): number {
  const leftDueAt = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const rightDueAt = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  return leftDueAt - rightDueAt || left.title.localeCompare(right.title);
}

/** Which primary choice the current filter state equals, or "custom" for anything else. */
export function primaryListSelection(
  listStates: Readonly<Record<string, ListState>>
):
  | { readonly kind: "all" }
  | { readonly kind: "one"; readonly id: string }
  | { readonly kind: "custom" } {
  const changed = Object.entries(listStates).filter(([, state]) => state !== "included");
  if (changed.length === 0) return { kind: "all" };
  const [only] = changed;
  if (changed.length === 1 && only && only[1] === "solo") return { kind: "one", id: only[0] };
  return { kind: "custom" };
}
