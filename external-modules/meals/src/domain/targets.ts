// external-modules/meals/src/domain/targets.ts
//
// Calorie split, portions and calorie fit. Pure functions over records.

import type { CalorieFit, MemberView } from "../contracts.js";

const ON_TARGET_SHARE = 0.15;
const MIN_PORTION = 0.5;
const MAX_PORTION = 2;

/** An even split of the member's daily target over their meal pattern. */
export function mealShareKcal(member: MemberView, slotName: string): number | null {
  if (member.calorieTarget === null) return null;
  if (!member.mealPattern.includes(slotName)) return null;
  return Math.round(member.calorieTarget / member.mealPattern.length);
}

/** Servings that bring one eater nearest their share, in halves from 0.5 to 2. */
export function portionFor(shareKcal: number | null, kcalPerServing: number | null): number {
  if (shareKcal === null || kcalPerServing === null || kcalPerServing <= 0) return 1;
  const halves = Math.round((shareKcal / kcalPerServing) * 2) / 2;
  return Math.min(MAX_PORTION, Math.max(MIN_PORTION, halves));
}

export function calorieFit(targetKcal: number, estimatedKcal: number): CalorieFit {
  const differenceKcal = Math.round(estimatedKcal - targetKcal);
  const tolerance = targetKcal * ON_TARGET_SHARE;
  const band = Math.abs(differenceKcal) <= tolerance ? "on" : differenceKcal > 0 ? "over" : "under";
  return { targetKcal, estimatedKcal, band, differenceKcal };
}
