import type { ModuleVisualTemplate } from "@moss/module-sdk/visual-template";
import { isValidTimeZone, localDay, tryCopyVisualSnapshot } from "@moss/shared";
import {
  TASK_SUMMARY_LIMIT,
  TASK_SUMMARY_SCOPES,
  type TaskSummary,
  type TaskSummaryItem,
  type TaskSummaryScope,
  type SummaryStatus,
  type TaskDueState
} from "./types.js";

export const summaryScopeLabels: Record<TaskSummaryScope, string> = {
  today: "Open tasks due today or earlier, plus undated tasks",
  overdue: "Overdue open tasks",
  upcoming: "Open tasks due after today",
  undated: "Open tasks without a due date",
  completed: "Completed tasks",
  all: "All persisted task states"
};
export function taskDueState(
  status: SummaryStatus,
  dueAt: string | null,
  day: string,
  zone: string
): TaskDueState {
  if (status !== "todo") return "inactive";
  if (dueAt === null) return "undated";
  const dueDay = localDay(dueAt, zone);
  return dueDay < day ? "overdue" : dueDay === day ? "today" : "upcoming";
}
export function taskMatchesScope(item: TaskSummaryItem, scope: TaskSummaryScope): boolean {
  if (scope === "all") return true;
  if (scope === "completed") return item.status === "done";
  if (item.status !== "todo") return false;
  return scope === "today" ? item.dueState !== "upcoming" : item.dueState === scope;
}
export function taskSummaryCoverage(v: TaskSummary): string {
  return `${summaryScopeLabels[v.scope]}. ${v.truncated ? `Partial: first ${TASK_SUMMARY_LIMIT} matching tasks; more exist.` : `${v.items.length} matching persisted tasks in this scope.`} Includes owned and explicitly shared tasks visible to you. Recurring tasks show persisted occurrences only; future occurrences are not generated. Reminders are not included. Due labels use local calendar days; original date-only intent is not retained in task storage.`;
}
const text = (v: unknown, max = 500): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const instant = (v: unknown): v is string =>
  text(v, 30) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(v);
export function readTaskSummarySnapshot(value: unknown): TaskSummary | null {
  const copied = tryCopyVisualSnapshot(value);
  if (!copied.ok) return null;
  const s = copied.snapshot,
    v = s.fields;
  if (
    s.kind !== "tasks.summary" ||
    s.origin !== "source" ||
    s.source.id !== "tasks" ||
    s.source.label !== "Tasks" ||
    Object.keys(v).length !== 6 ||
    !TASK_SUMMARY_SCOPES.includes(v.scope as TaskSummaryScope) ||
    !text(v.timeZone, 100) ||
    !isValidTimeZone(v.timeZone) ||
    !instant(v.retrievedAt) ||
    s.retrievedAt !== v.retrievedAt ||
    v.localDate !== localDay(v.retrievedAt, v.timeZone) ||
    typeof v.truncated !== "boolean" ||
    !Array.isArray(v.items) ||
    v.items.length > TASK_SUMMARY_LIMIT ||
    (v.truncated && v.items.length !== TASK_SUMMARY_LIMIT)
  )
    return null;
  const ids = new Set<string>();
  for (const item of v.items) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).length !== 9 ||
      !uuid(item.id) ||
      ids.has(item.id) ||
      !text(item.title) ||
      !["todo", "suggested", "done", "archived"].includes(String(item.status)) ||
      !(
        item.priority === null ||
        (typeof item.priority === "number" &&
          Number.isInteger(item.priority) &&
          item.priority >= 1 &&
          item.priority <= 5)
      ) ||
      !(item.dueAt === null || instant(item.dueAt)) ||
      !(item.completedAt === null || instant(item.completedAt)) ||
      !instant(item.updatedAt) ||
      typeof item.recurring !== "boolean"
    )
      return null;
    const row = item as unknown as TaskSummaryItem;
    if (
      row.dueState !== taskDueState(row.status, row.dueAt, String(v.localDate), v.timeZone) ||
      !taskMatchesScope(row, v.scope as TaskSummaryScope)
    )
      return null;
    ids.add(row.id);
  }
  const result = v as unknown as TaskSummary;
  return s.coverage === taskSummaryCoverage(result) ? result : null;
}
export function taskSummaryItemText(item: TaskSummaryItem, timeZone: string): string {
  const states: Record<SummaryStatus, string> = {
    todo: "Open",
    done: "Completed",
    suggested: "Suggested",
    archived: "Archived"
  };
  const due = item.dueAt
    ? `Due ${localDay(item.dueAt, timeZone)}${item.dueState === "overdue" ? " · Overdue" : item.dueState === "today" ? " · Due today" : ""}`
    : "No due date";
  return `${states[item.status]} · ${due}${item.priority === null ? "" : ` · Priority ${item.priority}/5`}${item.recurring ? " · Recurring (persisted occurrence)" : ""}${item.completedAt ? ` · Completed at ${item.completedAt}` : ""}`;
}
export function formatTaskSummarySnapshot(value: unknown): string {
  const v = readTaskSummarySnapshot(value);
  if (!v) return "";
  return `${summaryScopeLabels[v.scope]} · ${v.localDate} · ${v.timeZone}. ${v.items.map((item) => `${item.title} [${item.id}]: ${taskSummaryItemText(item, v.timeZone)}; stored due timestamp ${item.dueAt ?? "none"}; updated ${item.updatedAt}`).join(". ")}${v.items.length ? ". " : ""}Tasks; retrieved ${v.retrievedAt}. ${taskSummaryCoverage(v)}`;
}
export const taskSummaryTemplate: ModuleVisualTemplate = Object.freeze({
  kind: "tasks.summary",
  snapshotKind: "tasks.summary",
  validate: (v: unknown) => readTaskSummarySnapshot(v) !== null,
  format: formatTaskSummarySnapshot
});
export default [taskSummaryTemplate];
