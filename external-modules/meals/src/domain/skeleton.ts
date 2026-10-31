// external-modules/meals/src/domain/skeleton.ts
//
// The shape of a plan before any recipe is written: which meals each day has, who eats each one,
// and whether it is shared. S2 adds planSkeleton(kitchen, { startDate, days }).
import type { Sharing } from "../contracts.js";

export interface SkeletonMeal {
  readonly slotName: string;
  readonly slotPosition: number;
  readonly sharing: Sharing;
  readonly eaterIds: readonly string[];
}

export interface SkeletonDay {
  readonly date: string;
  readonly meals: readonly SkeletonMeal[];
}
