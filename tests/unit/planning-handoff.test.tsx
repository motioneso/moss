// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DayPlanBlockDto, DayPlanDto, TaskDto } from "@moss/shared";
import type { EveningPlanningController } from "../../apps/web/src/today/evening-planning-controller.js";
import { EveningHandoffStep } from "../../apps/web/src/today/evening-planning-finished.js";

import { saveStatusLine } from "../../apps/web/src/today/evening-planning-model.js";

const TMO = "2026-09-11";
function block(id: string, overrides: Partial<DayPlanBlockDto>): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId: null,
    title: null,
    position: 0,
    actualPlacement: null,
    pendingChange: null,
    ...overrides
  };
}
function tomorrowPlan(): DayPlanDto {
  return {
    id: "plan-tomorrow",
    localDay: TMO,
    timeZone: "America/Los_Angeles",
    revision: 4,
    sourceRunId: null,
    eveningIntent: null,
    blocks: []
  };
}
function taskDtos(): TaskDto[] {
  return [{ id: "t1", title: "Write the launch brief", status: "todo" } as TaskDto];
}

it.each([
  "Saved. Applied 0; 1 failed; 0 pending.",
  "Saved. Applied 1; 0 failed; 1 pending.",
  "Saved. Applied 0; 0 failed; 0 pending; 1 need checking.",
  "Confirm the calendar changes to finish saving.",
  "The calendar refused the batch: conflict"
])("morning handoff reports the saved outcome: %s", (status) => {
  const saved = tomorrowPlan();
  saved.blocks = [
    block("saved-priority", {
      taskId: "t1",
      pendingChange: { kind: "add", startsAt: `${TMO}T16:00:00Z`, durationMinutes: 30 }
    })
  ];
  const evening = {
    plan: saved,
    activeCapacity: "normal",
    activePriority: ["t1"],
    proposals: [],
    policyMode: "auto",
    status
  } as unknown as EveningPlanningController;
  const markup = renderToString(
    createElement(EveningHandoffStep, { evening, tasks: taskDtos(), dateLabel: "Tomorrow" })
  );
  expect(markup).toContain("write the launch brief");
  expect(markup).toContain(status);
  expect(markup).not.toContain("Task blocks are scheduled.");
  expect(markup).not.toContain("No task blocks were added.");
});

describe("saveStatusLine", () => {
  const line = (overrides: object) =>
    saveStatusLine({
      mode: "suggest",
      saved: true,
      applied: 0,
      failed: 0,
      pending: 0,
      unknown: 0,
      notApplied: 0,
      deniedReason: null,
      needsConfirm: false,
      ...overrides
    });
  it("names each outcome without claiming readiness early", () => {
    expect(line({ saved: false })).toBe("Not saved yet.");
    expect(line({})).toBe("Saved. The blocks are proposed for the morning.");
    expect(line({ mode: "off" })).toContain("nothing was written");
    expect(line({ mode: "auto", applied: 1 })).toBe("Tomorrow is ready.");
    expect(line({ mode: "auto", pending: 1 })).toContain("1 pending");
    expect(line({ mode: "auto", unknown: 1 })).toContain("1 need checking");
    expect(line({ mode: "auto", applied: 1, notApplied: 2 })).toBe(
      "Saved. Applied 1; 0 failed; 0 pending; 2 not applied."
    );
    expect(line({ mode: "auto", deniedReason: "busy" })).toContain("busy");
    expect(line({ mode: "auto", needsConfirm: true })).toContain("Confirm");
  });
});
