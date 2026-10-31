import type { CategoryTarget, TargetProgress } from "../domain/targets";
import { WEEKDAYS, type WeeklyTargetPeriod } from "../domain/weekly-targets";
import { formatCents, monthLabel } from "./format";
export function targetKindLabel(target: Pick<CategoryTarget, "kind" | "dueDate">): string {
  return target.kind === "refill"
    ? "Monthly refill · includes carried money"
    : target.kind === "weekly"
      ? "Weekly contribution"
      : target.kind === "monthly"
        ? "Monthly contribution"
        : target.kind === "balance"
          ? `Balance by ${target.dueDate}`
          : "Removed target";
}
export function weeklyPeriodLabel(
  period: WeeklyTargetPeriod,
  currency: string,
  month: string
): string {
  return `${period.occurrences} ${WEEKDAYS[period.weekday]}s · ${formatCents(period.totalCents, currency)} for ${monthLabel(month)}`;
}
export function targetDescription(target: TargetProgress, currency: string, month: string): string {
  const basis = target.weekly
    ? `${targetKindLabel(target)} · ${formatCents(target.amountCents, currency)} every ${WEEKDAYS[target.weekly.weekday]} · ${weeklyPeriodLabel(target.weekly, currency, month)}`
    : `${targetKindLabel(target)} · ${formatCents(target.amountCents, currency)}`;
  const progress =
    target.status === "reached"
      ? "Target reached"
      : `${formatCents(target.remainingCents, currency)} remaining${target.status === "overdue" ? " · overdue" : ""}${target.kind === "balance" ? ` · ${formatCents(target.suggestedCents, currency)} additional suggested` : ""}`;
  return `${basis} · ${progress}`;
}
