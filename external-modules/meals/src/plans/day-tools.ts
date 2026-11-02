// external-modules/meals/src/plans/day-tools.ts
//
// The meals.day.edit tool handler. It arranges one day: a plain-text slot, a One-off meal for
// one member, a cook-time limit, and a Shared or Solo override that lasts for that day only.

import type { PlanDayView, Sharing } from "../contracts.js";
import type { DayRow } from "../store/plan-port.js";
import type { PlanDeps } from "./deps.js";
import { enqueueDay, findDay, planGet, PlanInputError, requireString } from "./tools.js";

type Input = Readonly<Record<string, unknown>>;

async function dayView(deps: PlanDeps, planId: string, dayId: string): Promise<PlanDayView> {
  const plan = await planGet(deps, { planId });
  const day = plan.days.find((entry) => entry.dayId === dayId);
  if (day === undefined) throw new PlanInputError("That day is not in this plan");
  return day;
}

async function resolveDay(deps: PlanDeps, input: Input): Promise<DayRow> {
  const dayId = input["dayId"];
  if (typeof dayId === "string") {
    const day = await deps.store.getDay(dayId);
    if (day === null) throw new PlanInputError("No day with that id");
    return day;
  }
  const planId = requireString(input, "planId", 64);
  const days = await deps.store.listDays(planId);
  if (days.length === 0) throw new PlanInputError("No plan with that id");
  return findDay(days, input);
}

function requireSlotName(input: Input): string {
  return requireString(input, "slotName", 40);
}

async function setText(deps: PlanDeps, input: Input): Promise<PlanDayView> {
  const mealId = requireString(input, "mealId", 64);
  const text = requireString(input, "text", 200);
  const meal = await deps.store.getMeal(mealId);
  if (meal === null) throw new PlanInputError("No meal with that id");
  if (meal.cookedAt !== null) throw new PlanInputError("A cooked meal cannot become text");
  if (!(await deps.store.setMealText(mealId, text))) {
    throw new PlanInputError("Wait for this meal to finish writing before changing it to text");
  }
  await deps.onPlanChange?.(meal.planId, "written");
  return dayView(deps, meal.planId, meal.dayId);
}

async function clearText(deps: PlanDeps, input: Input): Promise<PlanDayView> {
  const mealId = requireString(input, "mealId", 64);
  const meal = await deps.store.getMeal(mealId);
  if (meal === null) throw new PlanInputError("No meal with that id");
  if (meal.kind !== "text") throw new PlanInputError("That meal is not a text slot");
  if (!(await deps.store.clearMealText(mealId))) {
    throw new PlanInputError("That text slot cannot be cleared");
  }
  // The slot is a recipe meal again, waiting to be written.
  await enqueueDay(deps, meal.planId, meal.dayId);
  return dayView(deps, meal.planId, meal.dayId);
}

async function addOneOff(deps: PlanDeps, input: Input): Promise<PlanDayView> {
  const day = await resolveDay(deps, input);
  const slotName = requireSlotName(input);
  const memberId = requireString(input, "memberId", 64);
  const kitchen = await deps.kitchen();
  if (!kitchen.members.some((person) => person.memberId === memberId)) {
    throw new PlanInputError("That person is not in the household");
  }
  const plan = await deps.store.getPlan(day.planId);
  if (plan === null) throw new PlanInputError("No plan with that id");
  const meals = await deps.store.listDayMeals(day.dayId);
  const slotPosition =
    meals.find((entry) => entry.slotName === slotName)?.slotPosition ??
    meals.reduce((max, entry) => Math.max(max, entry.slotPosition), -1) + 1;
  const added = await deps.store.addOneOffMeal({
    mealId: deps.newId(),
    kitchenId: plan.kitchenId,
    dayId: day.dayId,
    slotName,
    slotPosition,
    memberId
  });
  if (!added) throw new PlanInputError("That day is not in this plan");
  await enqueueDay(deps, day.planId, day.dayId);
  return dayView(deps, day.planId, day.dayId);
}

async function setCookLimit(deps: PlanDeps, input: Input): Promise<PlanDayView> {
  const day = await resolveDay(deps, input);
  const raw = input["minutes"];
  if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 5 || raw > 240)) {
    throw new PlanInputError("minutes must be a whole number from 5 to 240, or null to clear");
  }
  if (!(await deps.store.setDayCookLimit(day.dayId, raw))) {
    throw new PlanInputError("No day with that id");
  }
  return dayView(deps, day.planId, day.dayId);
}

async function setSharing(deps: PlanDeps, input: Input): Promise<PlanDayView> {
  const day = await resolveDay(deps, input);
  const slotName = requireSlotName(input);
  const sharing = input["sharing"];
  if (sharing !== "shared" && sharing !== "solo") {
    throw new PlanInputError("sharing must be shared or solo");
  }
  const meals = (await deps.store.listDayMeals(day.dayId)).filter(
    (meal) => meal.slotName === slotName
  );
  if (meals.length === 0) throw new PlanInputError("No meals in that slot that day");
  if (meals.some((meal) => meal.cookedAt !== null)) {
    throw new PlanInputError("A cooked meal's sharing cannot change");
  }
  if (meals.some((meal) => meal.status === "writing")) {
    throw new PlanInputError("Wait for that slot to finish writing before changing its sharing");
  }
  await deps.store.setDaySharing(day.dayId, slotName, sharing as Sharing);
  if (sharing === "solo") {
    for (const meal of meals) {
      if (meal.sharing !== "shared" || meal.eaters.length === 0) continue;
      const copies = meal.eaters.slice(1).map((eater) => ({
        mealId: deps.newId(),
        memberId: eater.memberId
      }));
      if (!(await deps.store.splitMeal({ mealId: meal.mealId, copies }))) {
        throw new PlanInputError("That slot's sharing cannot change");
      }
    }
  } else if (meals.some((meal) => meal.sharing === "solo")) {
    const eaters = new Map<string, (typeof meals)[number]["eaters"][number]>();
    for (const meal of meals) {
      for (const eater of meal.eaters) {
        if (!eaters.has(eater.memberId)) eaters.set(eater.memberId, eater);
      }
    }
    const kept = await deps.store.mergeSlotMeals({
      dayId: day.dayId,
      slotName,
      keepMealId: meals[0]!.mealId,
      eaters: [...eaters.values()]
    });
    if (!kept) throw new PlanInputError("That slot's sharing cannot change");
  }
  await deps.onPlanChange?.(day.planId, "written");
  return dayView(deps, day.planId, day.dayId);
}

export async function dayEdit(deps: PlanDeps, input: Input): Promise<PlanDayView> {
  const action = input["action"];
  if (action === "set_text") return setText(deps, input);
  if (action === "clear_text") return clearText(deps, input);
  if (action === "add_one_off") return addOneOff(deps, input);
  if (action === "set_cook_limit") return setCookLimit(deps, input);
  if (action === "set_sharing") return setSharing(deps, input);
  throw new PlanInputError(
    "action must be set_text, clear_text, add_one_off, set_cook_limit or set_sharing"
  );
}
