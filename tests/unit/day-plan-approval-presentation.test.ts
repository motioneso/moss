import { beforeEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type BriefingRun, type DataContextDb, type Task } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import type { DayPlanDto } from "@moss/shared";
import {
  createDayPlanPresentation,
  saveDayPlanPresentation,
  dayPlanDraftPresentation,
  setDayPlanApprovalDependencies
} from "../../packages/calendar/src/day-plan-approval-presentation.js";

const ctx = { actorUserId: "owner", requestId: "request", chatSessionId: "session" } as ToolContext;
const db = { [dataContextBrand]: true, db: {} } as DataContextDb;
const plan: DayPlanDto = {
  id: "plan-id",
  localDay: "2026-10-08",
  timeZone: "UTC",
  revision: 3,
  sourceRunId: null,
  eveningIntent: null,
  blocks: []
};
const task = { id: "task-id", owner_user_id: "owner", title: "Actual task title" } as Task;
const getById = vi.fn();
const findTask = vi.fn();
const findRun = vi.fn();
beforeEach(() => {
  getById.mockReset().mockResolvedValue(plan);
  findTask.mockReset().mockResolvedValue(task);
  findRun.mockReset().mockResolvedValue({
    id: "run-id",
    owner_user_id: "owner",
    briefing_type: "morning",
    created_at: new Date("2026-10-07T08:00:00Z")
  } as BriefingRun);
  setDayPlanApprovalDependencies({ dayPlanRepository: { getById }, findTask, findRun });
});
const route = (body: unknown) => ({ params: { id: "plan-id" }, target: null, body });

describe("day-plan human disclosure", () => {
  it("resolves briefing provenance and never displays its ID", async () => {
    const view = await createDayPlanPresentation(
      db,
      route({ date: "2026-10-08", timeZone: "UTC", sourceRunId: "run-id" }),
      ctx
    );
    expect(view?.target).toBe("Day plan · 2026-10-08 · UTC");
    expect(view?.fields).toContainEqual({
      label: "Briefing",
      value: "Morning · 2026-10-07T08:00:00.000Z"
    });
    expect(JSON.stringify(view)).not.toContain("run-id");
  });
  it("fully represents nested tasks, corrections and commitments through owner-scoped names", async () => {
    const view = await saveDayPlanPresentation(
      db,
      route({
        date: plan.localDay,
        timeZone: plan.timeZone,
        expectedRevision: 3,
        eveningIntent: {
          priorityTaskIds: ["task-id"],
          capacity: "light",
          notes: "Keep all\nthese words",
          corrections: [{ taskId: "task-id", note: "Actually Friday", source: "actor" }],
          commitments: [{ taskId: "task-id", decision: "defer" }]
        },
        blocks: [
          {
            kind: "focus",
            taskId: "task-id",
            title: "Full title",
            pendingChange: { kind: "add", startsAt: "2026-10-08T10:00:00Z", durationMinutes: 30 }
          }
        ]
      }),
      ctx
    );
    expect(view?.fields).toContainEqual({ label: "Priority task 1", value: task.title });
    expect(view?.fields).toContainEqual({ label: "Correction 1: note", value: "Actually Friday" });
    expect(view?.fields).toContainEqual({ label: "Commitment 1: decision", value: "Defer" });
    expect(view?.fields).toContainEqual({ label: "Block 1: task", value: task.title });
    expect(view?.fields).toContainEqual({ label: "Block 1: minutes", value: "30" });
    expect(JSON.stringify(view)).not.toContain("task-id");
    expect(findTask).toHaveBeenCalledWith(db, "task-id");
  });
  it("keeps exact proposed titles separate from resolved task titles in the chat draft", async () => {
    const view = await dayPlanDraftPresentation(
      db,
      {
        planId: plan.id,
        expectedRevision: 3,
        additions: [{ taskId: task.id, title: "Different proposed title" }]
      },
      ctx
    );
    expect(view?.fields).toContainEqual({ label: "New task 1: task", value: task.title });
    expect(view?.fields).toContainEqual({
      label: "New task 1: title",
      value: "Different proposed title"
    });
    expect(JSON.stringify(view)).not.toContain(plan.id);
  });
  it("rejects missing targets, foreign task references and unknown nested fields", async () => {
    getById.mockResolvedValueOnce(undefined);
    expect(
      await dayPlanDraftPresentation(db, { planId: plan.id, expectedRevision: 3 }, ctx)
    ).toBeNull();
    findTask.mockResolvedValueOnce({ ...task, owner_user_id: "another owner" });
    expect(
      await dayPlanDraftPresentation(
        db,
        { planId: plan.id, expectedRevision: 3, additions: [{ taskId: task.id }] },
        ctx
      )
    ).toBeNull();
    expect(
      await dayPlanDraftPresentation(
        db,
        {
          planId: plan.id,
          expectedRevision: 3,
          eveningIntent: {
            corrections: [{ taskId: task.id, note: "note", source: "actor", hidden: "value" }]
          }
        },
        ctx
      )
    ).toBeNull();
    expect(
      await createDayPlanPresentation(
        db,
        { ...route({ date: plan.localDay, timeZone: "UTC" }), query: { hidden: "value" } },
        ctx
      )
    ).toBeNull();
  });
  it("versions authoritative changes without putting IDs in displayed values", async () => {
    const input = { planId: plan.id, expectedRevision: 3, additions: [{ taskId: task.id }] };
    const first = await dayPlanDraftPresentation(db, input, ctx);
    findTask.mockResolvedValue({ ...task, title: "Changed title" });
    const next = await dayPlanDraftPresentation(db, input, ctx);
    expect(first?.version).not.toBe(next?.version);
  });
});
