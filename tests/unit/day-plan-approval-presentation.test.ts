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
  it("lists every omitted draft block, including empty replacement and same-title new blocks", async () => {
    getById.mockResolvedValue({
      ...plan,
      blocks: [
        { id: "retained-id", title: "Keep this", taskId: null, kind: "personal" },
        {
          id: "removed-id",
          title: "Full omitted title\nincluding detail",
          taskId: null,
          kind: "break"
        },
        { id: "task-block-id", title: null, taskId: task.id, kind: "focus" }
      ]
    });
    const base = { date: plan.localDay, timeZone: plan.timeZone, expectedRevision: 3 };
    const view = await saveDayPlanPresentation(
      db,
      route({
        ...base,
        blocks: [{ id: "retained-id", title: "Keep this", taskId: null, kind: "personal" }]
      }),
      ctx
    );
    expect(view?.fields).toContainEqual({
      label: "Draft changes",
      value: "Replace the current list; omitted blocks are removed from this draft only"
    });
    expect(view?.fields.filter((field) => field.label.startsWith("Removed block"))).toEqual([
      { label: "Removed block 1", value: "Full omitted title\nincluding detail" },
      { label: "Removed block 2", value: task.title }
    ]);
    const empty = await saveDayPlanPresentation(db, route({ ...base, blocks: [] }), ctx);
    expect(empty?.fields.filter((field) => field.label.startsWith("Removed block"))).toHaveLength(
      3
    );
    const sameTitle = await saveDayPlanPresentation(
      db,
      route({ ...base, blocks: [{ title: "Keep this", taskId: null, kind: "personal" }] }),
      ctx
    );
    expect(sameTitle?.fields).toContainEqual({ label: "Removed block 1", value: "Keep this" });
    const unchanged = await saveDayPlanPresentation(db, route(base), ctx);
    expect(unchanged?.fields.some((field) => field.label.startsWith("Removed block"))).toBe(false);
    expect(JSON.stringify(view)).not.toContain("removed-id");
    const additions = await dayPlanDraftPresentation(
      db,
      { planId: plan.id, expectedRevision: 3, additions: [] },
      ctx
    );
    expect(additions?.fields.some((field) => field.label.startsWith("Removed block"))).toBe(false);
  });
  it("returns corrective validation for omitted placed blocks instead of promising removal", async () => {
    getById.mockResolvedValue({
      ...plan,
      blocks: [
        {
          id: "placed-id",
          title: "Already on calendar",
          taskId: null,
          kind: "personal",
          actualPlacement: { startsAt: "2026-10-08T10:00:00Z", durationMinutes: 30 }
        }
      ]
    });
    await expect(
      saveDayPlanPresentation(
        db,
        route({ date: plan.localDay, timeZone: plan.timeZone, expectedRevision: 3, blocks: [] }),
        ctx
      )
    ).rejects.toThrow(
      "Placed calendar blocks must be kept in the draft with a pending removal; omitting them cannot save the plan."
    );
  });
  it("names omitted blocks honestly when linked task details are unavailable", async () => {
    const body = { date: plan.localDay, timeZone: plan.timeZone, expectedRevision: 3, blocks: [] };
    getById.mockResolvedValue({
      ...plan,
      blocks: [{ id: "unnamed-id", title: null, taskId: null, kind: "break" }]
    });
    expect((await saveDayPlanPresentation(db, route(body), ctx))?.fields).toContainEqual({
      label: "Removed block 1",
      value: "Break block 1"
    });
    getById.mockResolvedValue({
      ...plan,
      blocks: [{ id: "linked-id", title: null, taskId: "foreign-task", kind: "focus" }]
    });
    findTask.mockResolvedValue({ ...task, owner_user_id: "other" });
    const unavailable = await saveDayPlanPresentation(db, route(body), ctx);
    expect(unavailable?.fields).toContainEqual({
      label: "Removed block 1",
      value: "Focus block 1"
    });
    expect(JSON.stringify(unavailable?.fields)).not.toContain(task.title);
    findTask.mockResolvedValue(undefined);
    const deleted = await saveDayPlanPresentation(db, route(body), ctx);
    expect(deleted).toEqual(unavailable);
    expect(deleted?.fields).toContainEqual({
      label: "Draft changes",
      value: "Replace the current list; omitted blocks are removed from this draft only"
    });
    expect(deleted?.fields).toContainEqual({ label: "Draft blocks", value: "None" });
    expect(deleted?.fields.filter((field) => field.label === "Draft blocks")).toHaveLength(1);
    getById.mockResolvedValue({
      ...plan,
      blocks: [{ id: "replacement-block-id", title: null, taskId: "foreign-task", kind: "focus" }]
    });
    const replacement = await saveDayPlanPresentation(db, route(body), ctx);
    expect(replacement?.fields).toEqual(deleted?.fields);
    expect(replacement?.version).not.toBe(deleted?.version);
    expect(JSON.stringify(replacement?.fields)).not.toContain("replacement-block-id");
  });
  it("versions authoritative changes without putting IDs in displayed values", async () => {
    const input = { planId: plan.id, expectedRevision: 3, additions: [{ taskId: task.id }] };
    const first = await dayPlanDraftPresentation(db, input, ctx);
    findTask.mockResolvedValue({ ...task, title: "Changed title" });
    const next = await dayPlanDraftPresentation(db, input, ctx);
    expect(first?.version).not.toBe(next?.version);
  });
});
