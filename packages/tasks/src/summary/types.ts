export const TASK_SUMMARY_LIMIT = 12;
export const TASK_SUMMARY_SCOPES = [
  "today",
  "overdue",
  "upcoming",
  "undated",
  "completed",
  "all"
] as const;
export type TaskSummaryScope = (typeof TASK_SUMMARY_SCOPES)[number];
export type SummaryStatus = "todo" | "suggested" | "done" | "archived";
export type TaskDueState = "overdue" | "today" | "upcoming" | "undated" | "inactive";
export interface TaskSummaryItem {
  readonly id: string;
  readonly title: string;
  readonly status: SummaryStatus;
  readonly priority: number | null;
  readonly dueAt: string | null;
  readonly dueState: TaskDueState;
  readonly completedAt: string | null;
  readonly updatedAt: string;
  readonly recurring: boolean;
}
export interface TaskSummary {
  readonly scope: TaskSummaryScope;
  readonly timeZone: string;
  readonly localDate: string;
  readonly retrievedAt: string;
  readonly truncated: boolean;
  readonly items: readonly TaskSummaryItem[];
}
