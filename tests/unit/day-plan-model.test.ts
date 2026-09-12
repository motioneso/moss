import { describe, expect, it } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";

import {
  DayPlanValidationError,
  DayPlanRepository,
  emptyEveningIntent,
  mergeEveningIntent,
  normalizeActualPlacement,
  normalizeBlockInput,
  normalizeEveningIntent,
  normalizeIdempotencyKey,
  normalizeLocalDay,
  normalizeOperationKind,
  normalizeOperationOutcome,
  normalizePendingChange,
  normalizeTimeZone
} from "@moss/calendar";
import { DAY_PLAN_BLOCK_KINDS } from "@moss/shared";

describe("day plan storage model", () => {
  it("accepts a proposed move without accepting actual placement", () => {
    const block = normalizeBlockInput(
      {
        kind: "focus",
        taskId: null,
        title: "Write the draft",
        pendingChange: { kind: "move", startsAt: "2026-09-12T17:00:00Z", durationMinutes: 60 }
      },
      0
    );
    expect("actualPlacement" in block).toBe(false);
    expect(block.pendingChange).toEqual({
      kind: "move",
      startsAt: "2026-09-12T17:00:00Z",
      durationMinutes: 60
    });
  });

  it("rejects an attempted actual placement overwrite", () => {
    expect(() =>
      normalizeBlockInput(
        {
          kind: "meeting",
          taskId: null,
          title: null,
          actualPlacement: {
            startsAt: "2026-09-12T16:00:00Z",
            durationMinutes: 30,
            calendarEventRef: "evt-1"
          }
        } as never,
        0
      )
    ).toThrow(DayPlanValidationError);
    for (const actualPlacement of [null, undefined]) {
      expect(() =>
        normalizeBlockInput(
          { kind: "focus", taskId: null, title: null, actualPlacement } as never,
          0
        )
      ).toThrow(DayPlanValidationError);
    }
  });

  it("preserves the existing block vocabulary", () => {
    expect(DAY_PLAN_BLOCK_KINDS).toEqual([
      "focus",
      "meeting",
      "prep",
      "break",
      "personal",
      "unscheduled"
    ]);
    for (const kind of DAY_PLAN_BLOCK_KINDS) {
      expect(normalizeBlockInput({ kind, taskId: null, title: null }, 0).kind).toBe(kind);
    }
  });

  it("validates calendar dates and UTC instants without Date rollover", () => {
    expect(normalizeLocalDay("2028-02-29")).toBe("2028-02-29");
    expect(normalizeLocalDay("0001-01-01")).toBe("0001-01-01");
    for (const value of [null, 20260912, "2026-02-29", "2026-04-31"]) {
      expect(() => normalizeLocalDay(value)).toThrow(DayPlanValidationError);
    }
    expect(() => normalizeTimeZone(null)).toThrow(DayPlanValidationError);
    for (const startsAt of [
      "2026-02-30T16:00:00Z",
      "2026-09-12T24:00:00Z",
      "2026-09-12",
      "September 12, 2026",
      "2026-09-12T16:00:00"
    ]) {
      expect(() => normalizePendingChange({ kind: "add", startsAt, durationMinutes: 30 })).toThrow(
        DayPlanValidationError
      );
    }
    for (const startsAt of ["2026-09-12T16:00:00Z", "2026-09-12T16:00:00.123Z"]) {
      expect(normalizePendingChange({ kind: "add", startsAt, durationMinutes: 30 })).toMatchObject({
        startsAt
      });
    }
  });

  it("rejects missing or invalid revisions before accessing storage", async () => {
    const repository = new DayPlanRepository({ findTask: async () => undefined });
    const scopedDb = { [dataContextBrand]: true, db: {} } as DataContextDb;
    for (const expectedRevision of [undefined, null, 0, -1, 1.5, "1", Number.NaN]) {
      await expect(
        repository.saveDraft(scopedDb, {
          planId: "plan-1",
          localDay: "2026-09-12",
          timeZone: "UTC",
          expectedRevision
        } as never)
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        repository.reserveOperation(scopedDb, {
          planId: "plan-1",
          kind: "add",
          idempotencyKey: "op-1",
          expectedRevision
        } as never)
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("rejects bad day, zone, duration and pending kinds", () => {
    expect(() => normalizeLocalDay("2026-13-40")).toThrow(DayPlanValidationError);
    expect(() => normalizeLocalDay("2026-02-31")).toThrow(DayPlanValidationError);
    expect(() => normalizeTimeZone("Not/AZone")).toThrow(DayPlanValidationError);
    expect(() =>
      normalizeBlockInput(
        {
          kind: "focus",
          taskId: null,
          title: null,
          pendingChange: { kind: "move", startsAt: "x", durationMinutes: 3 }
        },
        0
      )
    ).toThrow(DayPlanValidationError);
    expect(() => normalizePendingChange({ kind: "teleport" })).toThrow(DayPlanValidationError);
    expect(() =>
      normalizePendingChange({ kind: "move", startsAt: "not-a-timestamp", durationMinutes: 30 })
    ).toThrow(DayPlanValidationError);
    expect(() => normalizeActualPlacement({ durationMinutes: 3 })).toThrow(DayPlanValidationError);
  });

  it("merges intent patches by omission, clearing and reset", () => {
    const base = {
      ...emptyEveningIntent(),
      capacity: "light" as const,
      notes: "keep it small",
      priorityTaskIds: ["task-1"]
    };
    // Omitted fields stay.
    const kept = mergeEveningIntent(base, { notes: "new note" });
    expect(kept?.capacity).toBe("light");
    expect(kept?.notes).toBe("new note");
    expect(kept?.priorityTaskIds).toEqual(["task-1"]);
    // Explicit null clears; explicit [] clears the list.
    const cleared = mergeEveningIntent(base, { notes: null, priorityTaskIds: [] });
    expect(cleared?.notes).toBeNull();
    expect(cleared?.priorityTaskIds).toEqual([]);
    expect(cleared?.capacity).toBe("light");
    // A null patch resets the whole intent.
    expect(mergeEveningIntent(base, null)).toEqual(emptyEveningIntent());
    // An omitted patch keeps the stored intent untouched.
    expect(mergeEveningIntent(base, undefined)).toBe(base);
  });

  it("validates corrections, commitments and capacity", () => {
    for (const value of ["intent", [], 42]) {
      expect(() => normalizeEveningIntent(value)).toThrow(DayPlanValidationError);
    }
    expect(() => normalizeEveningIntent({ capacity: "endless" as never })).toThrow(
      DayPlanValidationError
    );
    expect(() =>
      normalizeEveningIntent({ corrections: [{ note: "", source: "actor" }] as never })
    ).toThrow(DayPlanValidationError);
    expect(() =>
      normalizeEveningIntent({ commitments: [{ taskId: "t-1", decision: "maybe" }] as never })
    ).toThrow(DayPlanValidationError);
    const intent = normalizeEveningIntent({
      priorityTaskIds: ["t-1"],
      capacity: "normal",
      corrections: [{ taskId: null, note: "moved", source: "planner" }],
      commitments: [{ taskId: "t-1", decision: "commit" }]
    });
    expect(intent?.commitments).toEqual([{ taskId: "t-1", decision: "commit" }]);
  });

  it("validates operation kind, outcome and idempotency key", () => {
    expect(normalizeOperationKind("move")).toBe("move");
    expect(normalizeOperationOutcome("pending")).toBe("pending");
    expect(normalizeIdempotencyKey("  op-1 ")).toBe("op-1");
    expect(() => normalizeOperationKind("apply")).toThrow(DayPlanValidationError);
    expect(() => normalizeIdempotencyKey("")).toThrow(DayPlanValidationError);
  });
});
