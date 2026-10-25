export const REMINDER_SUMMARY_LIMIT = 12;
export const REMINDER_SUMMARY_SCOPES = ["upcoming", "delivered", "ended", "all"] as const;
export type ReminderSummaryScope = (typeof REMINDER_SUMMARY_SCOPES)[number];
export const REMINDER_SUMMARY_STATES = [
  "queued",
  "paused",
  "delivered",
  "failed",
  "cancelled",
  "expired"
] as const;
export type ReminderSummaryState = (typeof REMINDER_SUMMARY_STATES)[number];
export const REMINDER_SUMMARY_CONTEXT_STATES = ["pending", "dismissed", "acknowledged"] as const;
export type ReminderSummaryContextState = (typeof REMINDER_SUMMARY_CONTEXT_STATES)[number];
export type ReminderSummaryRepeat =
  | { readonly kind: "daily" | "weekly" }
  | { readonly kind: "interval"; readonly seconds: number };

export interface ReminderSummaryItem {
  readonly id: string;
  readonly text: string;
  readonly state: ReminderSummaryState;
  readonly contextState: ReminderSummaryContextState;
  readonly timing: "relative" | "local_clock";
  readonly dueAt: string;
  readonly dueLocalDay: string;
  readonly deadlineAt: string | null;
  readonly repeat: ReminderSummaryRepeat | null;
  /** Null means the Main chat. */
  readonly destinationTitle: string | null;
  readonly deliveredAt: string | null;
  readonly late: boolean | null;
  readonly createdAt: string;
}
export interface ReminderSummary {
  readonly scope: ReminderSummaryScope;
  readonly timeZone: string;
  readonly localDate: string;
  readonly retrievedAt: string;
  readonly truncated: boolean;
  readonly items: readonly ReminderSummaryItem[];
}
