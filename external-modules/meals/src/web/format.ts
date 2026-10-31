// external-modules/meals/src/web/format.ts
import type { MemberView, SlotRuleView } from "../contracts";

const SLOT_ORDER = ["breakfast", "lunch", "dinner"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
