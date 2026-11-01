// external-modules/meals/src/lists/view.ts
//
// Builds ShoppingListView from the stored list and the plan's meal labels. Pure.
import type { ListLineView, PantryMode, ShoppingListView } from "../contracts.js";
import { SECTION_ORDER, type StoredLine } from "../domain/list.js";
import type { StoredList } from "../store/list-port.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon dinner" for a slot on a plan date. */
export function mealLabel(date: string, slotName: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${slotName}`;
}

function lineView(line: StoredLine, labels: ReadonlyMap<string, string>): ListLineView {
  return {
    lineId: line.lineId,
    name: line.name,
    quantity: line.quantity,
    unit: line.unit,
    purchase: line.purchase,
    section: line.section,
    manual: line.manual,
    coveredByPantry: line.coveredByPantry,
    notInPlan: line.notInPlan,
    convertedFrom: line.convertedFrom,
    sources: line.sourceMealIds.flatMap((mealId) => {
      const label = labels.get(mealId);
      return label === undefined ? [] : [{ mealId, label }];
    }),
    checkedAt: line.checkedAt,
    boughtAt: line.boughtAt
  };
}

export function listView(
  stored: StoredList,
  pantryMode: PantryMode,
  labels: ReadonlyMap<string, string>
): ShoppingListView {
  const lines = [...stored.lines].sort(
    (a, b) =>
      SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) ||
      a.name.localeCompare(b.name)
  );
  return {
    listId: stored.listId,
    planId: stored.planId,
    pantryMode,
    lines: lines.map((line) => lineView(line, labels))
  };
}
