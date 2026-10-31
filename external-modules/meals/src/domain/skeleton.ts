// external-modules/meals/src/domain/skeleton.ts
//
// The plan skeleton: which meals each day holds, who eats each one, and whether it is shared.
// Pure TypeScript over the Kitchen view. The model never decides any of this.

import type { KitchenView, Sharing } from "../contracts.js";

export interface SkeletonMeal {
  readonly slotName: string;
  /** Index of the slot in the day. Solo meals of one slot share it. */
  readonly slotPosition: number;
  readonly sharing: Sharing;
  readonly eaterIds: readonly string[];
}

export interface SkeletonDay {
  /** ISO calendar date, YYYY-MM-DD. */
  readonly date: string;
  readonly meals: readonly SkeletonMeal[];
}

export const MAX_PLAN_DAYS = 28;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Parses a calendar date to UTC midnight. Throws on a date that does not exist. */
export function parseIsoDate(date: string): number {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError("date must be YYYY-MM-DD");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1) {
    throw new RangeError("date does not exist");
  }
  return time;
}

export function addDays(date: string, days: number): string {
  return new Date(parseIsoDate(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday, 1 = Monday to 7 = Sunday. */
export function isoWeekday(date: string): number {
  const day = new Date(parseIsoDate(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function planSkeleton(
  kitchen: KitchenView,
  input: { startDate: string; days: number }
): readonly SkeletonDay[] {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_PLAN_DAYS) {
    throw new RangeError(`days must be 1 to ${MAX_PLAN_DAYS}`);
  }
  parseIsoDate(input.startDate);

  // Slots in the order members first name them.
  const slots: string[] = [];
  for (const member of kitchen.members) {
    for (const slot of member.mealPattern) if (!slots.includes(slot)) slots.push(slot);
  }
  const soloDays = new Map(kitchen.slotRules.map((rule) => [rule.slotName, rule.soloWeekdays]));

  return Array.from({ length: input.days }, (_, offset) => {
    const date = addDays(input.startDate, offset);
    const weekday = isoWeekday(date);
    const meals = slots.flatMap((slotName, slotPosition): SkeletonMeal[] => {
      const eaterIds = kitchen.members
        .filter((member) => member.mealPattern.includes(slotName))
        .map((member) => member.memberId);
      if (soloDays.get(slotName)?.includes(weekday)) {
        return eaterIds.map((id) => ({ slotName, slotPosition, sharing: "solo", eaterIds: [id] }));
      }
      return [{ slotName, slotPosition, sharing: "shared", eaterIds }];
    });
    return { date, meals };
  });
}
