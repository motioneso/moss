import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocaleSettingsDto, TaskDto } from "@moss/shared";
import { isAtRisk, isDoneToday, matchesFocus } from "../../apps/web/src/tasks/focus.js";
import { dueInfo } from "../../apps/web/src/tasks/task-list-view.js";
import { deriveTaskFilters } from "../../apps/web/src/tasks/task-view-model.js";

/**
 * #601 regression: day-classification (Overdue/Today/At-risk/Done-today) must bucket in
 * the user's *persisted* timezone, not the ambient browser zone. We pin "now" and compare
 * two zones whose calendar date diverges for the same instant:
 *   - UTC                  → 2026-06-30
 *   - Pacific/Kiritimati (UTC+14) → 2026-07-01  (one day ahead)
 * A label/bucket that flips between these two for the SAME instant proves the classifier
 * is zone-driven. Before the fix both rendered in the ambient zone and could not diverge.
 */
const NOW = "2026-06-30T11:00:00.000Z";
const UTC = "UTC";
const KIRITIMATI = "Pacific/Kiritimati"; // UTC+14

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("#601 day-classification buckets in the user's persisted timezone", () => {
  describe("stat tiles (focus.ts)", () => {
    it("isDoneToday: a 05:00Z completion is 'today' in UTC but 'yesterday' in UTC+14", () => {
      const done = task("d", { status: "done", completedAt: "2026-06-30T05:00:00.000Z" });
      expect(isDoneToday(done, UTC)).toBe(true);
      expect(isDoneToday(done, KIRITIMATI)).toBe(false);
    });

    it("isAtRisk: a due date 3 days out in UTC is only 2 days out (at risk) in UTC+14", () => {
      const due = task("a", { status: "todo", dueAt: "2026-07-03T05:00:00.000Z" });
      expect(isAtRisk(due, UTC)).toBe(false);
      expect(isAtRisk(due, KIRITIMATI)).toBe(true);
      // matchesFocus delegates to isAtRisk, so the Tasks `?focus=atrisk` preset agrees.
      expect(matchesFocus(due, "atrisk", UTC)).toBe(false);
      expect(matchesFocus(due, "atrisk", KIRITIMATI)).toBe(true);
    });
  });

  describe("per-row inclusion (deriveTaskFilters focus filter)", () => {
    it("the at-risk focus filter includes a task only in the zone where it is at risk", () => {
      const due = task("a", { status: "todo", dueAt: "2026-07-03T05:00:00.000Z" });
      const base = {
        tasks: [due],
        lists: [],
        statusFilter: "todo" as const,
        focus: "atrisk" as const,
        listStates: {},
        tagFilter: [],
        search: ""
      };

      expect(deriveTaskFilters({ ...base, timeZone: UTC }).visibleTasks).toEqual([]);
      expect(
        deriveTaskFilters({ ...base, timeZone: KIRITIMATI }).visibleTasks.map((t) => t.id)
      ).toEqual(["a"]);
    });
  });

  describe("per-row badge (dueInfo)", () => {
    it("the same 05:00Z due instant reads 'Today' in UTC but 'Overdue' in UTC+14", () => {
      const due = task("b", { status: "todo", dueAt: "2026-06-30T05:00:00.000Z" });
      expect(dueInfo(due, locale(UTC))?.label).toBe("Today");
      expect(dueInfo(due, locale(KIRITIMATI))?.label).toBe("Overdue");
    });

    it("a future due date crosses the at-risk threshold a day earlier in UTC+14", () => {
      const due = task("c", { status: "todo", dueAt: "2026-07-03T05:00:00.000Z" });
      expect(dueInfo(due, locale(UTC))?.drift).toBeNull();
      expect(dueInfo(due, locale(KIRITIMATI))?.drift).toBe("atrisk");
    });
  });
});

describe("#1115 one overdue indicator (icon/text badge vs. drift pill)", () => {
  it("suppresses the icon/text badge for a non-done overdue task — the drift pill already reads Overdue", () => {
    const due = task("d", { status: "todo", dueAt: "2026-06-29T05:00:00.000Z" });
    const info = dueInfo(due, locale(UTC));
    expect(info?.drift).toBe("overdue");
    expect(info?.showBadge).toBe(false);
  });

  it("keeps the icon/text badge for a done overdue task — no drift pill renders, so it's the only indicator", () => {
    const done = task("e", {
      status: "done",
      dueAt: "2026-06-29T05:00:00.000Z",
      completedAt: "2026-06-29T12:00:00.000Z"
    });
    const info = dueInfo(done, locale(UTC));
    expect(info?.drift).toBeNull();
    expect(info?.showBadge).toBe(true);
  });

  it("leaves the badge visible for Today and future/at-risk rows, which have no drift pill overlap", () => {
    const today = task("f", { status: "todo", dueAt: "2026-06-30T05:00:00.000Z" });
    expect(dueInfo(today, locale(UTC))?.showBadge).toBe(true);

    const atRisk = task("g", { status: "todo", dueAt: "2026-07-01T05:00:00.000Z" });
    expect(dueInfo(atRisk, locale(UTC))?.drift).toBe("atrisk");
    expect(dueInfo(atRisk, locale(UTC))?.showBadge).toBe(true);
  });
});

const OWNER_ID = "11111111-1111-1111-1111-111111111111";

function locale(timezone: string): LocaleSettingsDto {
  return { timezone, region: "en-US", dateFormat: "24" };
}

function task(id: string, overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id,
    ownerUserId: OWNER_ID,
    listId: "work",
    parentTaskId: null,
    title: id,
    description: null,
    status: overrides.status ?? "todo",
    priority: overrides.priority ?? null,
    position: 0,
    dueAt: overrides.dueAt ?? null,
    doAt: null,
    effort: null,
    source: "manual",
    sourceRef: null,
    completedAt: overrides.completedAt ?? null,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    tags: [],
    suggestionMetadata: null
  };
}
