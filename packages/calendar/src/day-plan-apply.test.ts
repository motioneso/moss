import { describe, expect, it } from "vitest";

import {
  applyIntentsEqual,
  applySelectionsEqual,
  normalizeApplyIntent,
  pendingChangesEqual,
  resolveApplySelection,
  type DayPlanApplyResolvableBlock
} from "./day-plan-apply.js";
import { DayPlanValidationError } from "./day-plan-model.js";

const ADD_A: DayPlanApplyResolvableBlock = {
  id: "block-a",
  position: 0,
  pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 30 }
};
const MOVE_B: DayPlanApplyResolvableBlock = {
  id: "block-b",
  position: 1,
  pendingChange: { kind: "move", startsAt: "2026-09-12T17:00:00.000Z", durationMinutes: 45 }
};
const REMOVE_C: DayPlanApplyResolvableBlock = {
  id: "block-c",
  position: 2,
  pendingChange: { kind: "remove" }
};
const PLAIN_D: DayPlanApplyResolvableBlock = { id: "block-d", position: 3, pendingChange: null };

describe("apply selection", () => {
  it("resolves the explicit selection plus every pending addition in plan order", () => {
    const selection = resolveApplySelection([ADD_A, MOVE_B, REMOVE_C, PLAIN_D], ["block-c"]);
    expect(selection.map((entry) => entry.blockId)).toEqual(["block-a", "block-c"]);
    expect(selection[0]).toEqual({
      blockId: "block-a",
      kind: "add",
      startsAt: "2026-09-12T16:00:00.000Z",
      durationMinutes: 30
    });
    expect(selection[1]).toEqual({
      blockId: "block-c",
      kind: "remove",
      startsAt: null,
      durationMinutes: null
    });
  });

  it("treats an omitted selection as all eligible additions", () => {
    const selection = resolveApplySelection([ADD_A, MOVE_B, REMOVE_C, PLAIN_D]);
    expect(selection.map((entry) => entry.blockId)).toEqual(["block-a"]);
  });

  it("dedupes repeats and ignores blank ids", () => {
    const selection = resolveApplySelection([ADD_A, PLAIN_D], ["block-a", " block-a ", "  "]);
    expect(selection.map((entry) => entry.blockId)).toEqual(["block-a"]);
  });

  it("rejects ids outside the plan", () => {
    expect(() => resolveApplySelection([ADD_A], ["missing"])).toThrow(DayPlanValidationError);
    expect(() => resolveApplySelection([ADD_A], ["missing"])).toThrow(
      "selected change missing is not part of this plan"
    );
  });

  it("rejects selected blocks without a pending change", () => {
    expect(() => resolveApplySelection([ADD_A, PLAIN_D], ["block-d"])).toThrow(
      "selected change block-d has no pending change"
    );
  });

  it("compares snapshots entry by entry", () => {
    const base = resolveApplySelection([ADD_A, MOVE_B], ["block-b"]);
    expect(applySelectionsEqual(base, resolveApplySelection([ADD_A, MOVE_B], ["block-b"]))).toBe(
      true
    );
    const moved = resolveApplySelection([ADD_A, { ...MOVE_B, position: -1 }], ["block-b"]);
    expect(applySelectionsEqual(base, moved)).toBe(false);
    const changed = [{ ...base[1]!, durationMinutes: 60 }];
    expect(applySelectionsEqual([base[0]!], changed)).toBe(false);
    expect(applySelectionsEqual(base, [base[0]!])).toBe(false);
  });
});

describe("apply intent", () => {
  it("normalizes selections to a sorted id set", () => {
    expect(normalizeApplyIntent(["b", " a ", "b", "  ", "a"])).toEqual(["a", "b"]);
    expect(normalizeApplyIntent(undefined)).toEqual([]);
    expect(normalizeApplyIntent([])).toEqual([]);
  });

  it("compares normalized intents", () => {
    expect(applyIntentsEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(applyIntentsEqual(["b", "a"], ["a", "b"])).toBe(false);
    expect(applyIntentsEqual(["a"], ["a", "b"])).toBe(false);
  });
});

describe("pending change equality", () => {
  it("compares timing-bearing changes field by field", () => {
    const add = { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 30 };
    expect(pendingChangesEqual(add, { ...add })).toBe(true);
    expect(pendingChangesEqual(add, { ...add, durationMinutes: 45 })).toBe(false);
    expect(
      pendingChangesEqual(add, { kind: "move", startsAt: add.startsAt, durationMinutes: 30 })
    ).toBe(false);
    expect(pendingChangesEqual({ kind: "remove" }, { kind: "remove" })).toBe(true);
    expect(pendingChangesEqual(add, { kind: "remove" })).toBe(false);
    expect(pendingChangesEqual(null, null)).toBe(true);
    expect(pendingChangesEqual(add, null)).toBe(false);
  });
});
