// external-modules/meals/src/web/format.ts
import type { MemberView, SlotRuleView } from "../contracts";
import { formatNumber } from "../domain/units";

const SLOT_ORDER = ["breakfast", "lunch", "dinner"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

/** Today in the browser's own calendar, as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function parts(iso: string): { year: number; month: number; day: number; weekday: number } {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

export const weekdayName = (iso: string) => WEEKDAY_NAMES[parts(iso).weekday]!;

/** "Monday, Nov 2" */
export function dayTitle(iso: string): string {
  const { month, day } = parts(iso);
  return `${weekdayName(iso)}, ${MONTHS[month - 1]} ${day}`;
}

/** "Nov 2 to 8", or "Nov 28 to Dec 4" across a month. One day reads "Nov 2". */
export function dateRange(first: string, last: string): string {
  const a = parts(first);
  const b = parts(last);
  const start = `${MONTHS[a.month - 1]} ${a.day}`;
  if (first === last) return start;
  return a.month === b.month
    ? `${start} to ${b.day}`
    : `${start} to ${MONTHS[b.month - 1]} ${b.day}`;
}

export const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export function joinTitled(words: readonly string[]): string {
  return words.map(titleCase).join(", ");
}

export function dailyTarget(member: MemberView): string | null {
  const { calorieTarget, macroTargets } = member;
  const macros = [
    macroTargets.proteinG !== null ? `${macroTargets.proteinG} g protein` : null,
    macroTargets.carbG !== null ? `${macroTargets.carbG} g carbs` : null,
    macroTargets.fatG !== null ? `${macroTargets.fatG} g fat` : null
  ].filter((part): part is string => part !== null);
  const parts = [
    calorieTarget !== null ? `${calorieTarget.toLocaleString("en-US")} kcal` : null,
    ...macros
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Every slot any member eats, breakfast, lunch and dinner first. */
export function slotsEaten(members: readonly MemberView[]): string[] {
  const all = new Set(members.flatMap((member) => member.mealPattern));
  const known = SLOT_ORDER.filter((slot) => all.has(slot));
  const extra = [...all].filter((slot) => !SLOT_ORDER.includes(slot)).sort();
  return [...known, ...extra];
}

export function sharingRule(rule: SlotRuleView | undefined): string {
  const days = rule?.soloWeekdays ?? [];
  const key = days.join(",");
  if (key === "") return "Shared every day";
  if (key === "1,2,3,4,5,6,7") return "Solo every day";
  if (key === "1,2,3,4,5") return "Solo on weekdays, shared at weekends";
  if (key === "6,7") return "Solo at weekends, shared on weekdays";
  return `Solo on ${days.map((day) => WEEKDAYS[day - 1]).join(", ")}`;
}

/** "500 ml", "2 cloves", or just "6" for a plain count. */
export function amountText(quantity: number, unit: string | null): string {
  const number = formatNumber(quantity, false);
  return unit ? `${number} ${unit}` : number;
}

/** A typed amount such as "2 l" or "6". Null when it does not start with a number. */
export function parseAmount(text: string): { quantity: number; unit: string | null } | null {
  const match = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(text.trim());
  if (match === null) return null;
  const quantity = Number(match[1]);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const unit = (match[2] ?? "").trim();
  return { quantity, unit: unit === "" ? null : unit };
}
