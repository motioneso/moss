import type {
  CreateTaskRequest,
  RecurrenceSpecDto,
  TaskApiStatus,
  TaskDto,
  TaskEffort,
  UpdateTaskRequest
} from "@moss/shared";

import { fromDateInputValue, toDateInputValue } from "./task-format.js";

export type Repeat = "never" | "daily" | "weekly" | "monthly";

export interface TaskDetailsFormState {
  readonly title: string;
  readonly description: string;
  readonly status: TaskApiStatus;
  readonly listId: string;
  readonly priority: string;
  readonly dueAt: string;
  readonly doAt: string;
  readonly effort: "" | TaskEffort;
  readonly repeat: Repeat;
  /** The stored schedule the form was seeded from; kept so an unchanged repeat is not rewritten. */
  readonly recurrence: RecurrenceSpecDto | null;
}

export function blankTaskDetailsForm(defaultListId = "", defaultTitle = ""): TaskDetailsFormState {
  return {
    title: defaultTitle,
    description: "",
    status: "todo",
    listId: defaultListId,
    priority: "",
    dueAt: "",
    doAt: "",
    effort: "",
    repeat: "never",
    recurrence: null
  };
}

// #877 finding 3: `timeZone` must be the caller's persisted locale (from
// `useUserLocale()`), threaded through explicitly rather than left to
// toDateInputValue's ambient fallback — see task-format.ts for why bucketing
// by UTC could disagree with the list-view day label for a dueAt/doAt instant
// near local midnight.
export function formFromTask(task: TaskDto, timeZone: string): TaskDetailsFormState {
  return {
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    listId: task.listId,
    priority: task.priority === null ? "" : String(task.priority),
    dueAt: toDateInputValue(task.dueAt, timeZone),
    doAt: toDateInputValue(task.doAt, timeZone),
    effort: task.effort ?? "",
    repeat: task.recurrence?.freq ?? "never",
    recurrence: task.recurrence ?? null
  };
}

export function buildTaskFields(
  form: TaskDetailsFormState,
  defaultListId?: string
): CreateTaskRequest & UpdateTaskRequest {
  const dueAt = fromDateInputValue(form.dueAt);

  return {
    title: form.title.trim() || "Untitled task",
    description: form.description || null,
    status: form.status,
    priority: form.priority ? Number(form.priority) : null,
    dueAt,
    doAt: fromDateInputValue(form.doAt),
    effort: form.effort || null,
    listId: form.listId || defaultListId || undefined,
    recurrence:
      form.repeat === "never"
        ? null
        : form.recurrence?.freq === form.repeat
          ? form.recurrence
          : {
              freq: form.repeat,
              interval: 1,
              occurrence_date: recurrenceOccurrenceDate(dueAt)
            }
  };
}

function recurrenceOccurrenceDate(dueAt: string | null): string {
  return (dueAt ?? new Date().toISOString()).slice(0, 10);
}

export function normalizeTagName(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

export function cleanSubtasks(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}
