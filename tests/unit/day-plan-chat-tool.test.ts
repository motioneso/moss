import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { HttpError, type ToolContext } from "@moss/module-sdk";
import type { DayPlanRepository } from "@moss/calendar";
import type { DayPlanBlockDto, DayPlanDto } from "@moss/shared";

import {
  createDayPlanDraftExecute,
  DAY_PLAN_DRAFT_TOOL_NAME
} from "../../packages/calendar/src/day-plan-chat-tool.js";
import {
  emptyEveningIntent,
  mergeEveningIntent,
  normalizeBlockInput
} from "../../packages/calendar/src/day-plan-model.js";
import { calendarModuleManifest } from "../../packages/calendar/src/manifest.js";

const TZ = "America/Los_Angeles";
const PLAN_ID = "plan-chat-tool";
const TASK_A = "task-a";
const TASK_B = "task-b";
const FOREIGN_TASK = "task-foreign";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;

function ctx(): ToolContext {
  return {
    actorUserId: "actor-a",
    requestId: "chat:t21",
    chatSessionId: "session-1",
    localTimezone: TZ
  };
}

function tomorrowIn(tz: string): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1, 12)).toISOString().slice(0, 10);
}

function block(id: string, taskId: string | null): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId,
    title: null,
    position: 0,
    actualPlacement: null,
    pendingChange: null
  };
}

function storedPlan(overrides: Partial<DayPlanDto> = {}): DayPlanDto {
  return {
    id: PLAN_ID,
    localDay: tomorrowIn(TZ),
    timeZone: TZ,
    revision: 4,
    sourceRunId: null,
    blocks: [block("block-a", TASK_A)],
    eveningIntent: {
      priorityTaskIds: [],
      capacity: "light",
      notes: "Leave room for follow-up",
      corrections: [],
      commitments: []
    },
    ...overrides
  };
}

function fakeRepository(initial: DayPlanDto, owned: readonly string[] = [TASK_A, TASK_B]) {
  let stored = initial;
  const ownedSet = new Set(owned);
  const getById = vi.fn(async (_db: DataContextDb, planId: string) => {
    if (planId !== stored.id) return undefined;
    return stored;
  });
  const saveDraft = vi.fn(
    async (
      _db: DataContextDb,
      input: Parameters<DayPlanRepository["saveDraft"]>[1]
    ): Promise<DayPlanDto> => {
      if (input.expectedRevision !== stored.revision) {
        throw new HttpError(409, "day plan changed since it was read");
      }
      const merged = mergeEveningIntent(stored.eveningIntent, input.eveningIntent);
      const normalized = (input.blocks ?? []).map(normalizeBlockInput);
      for (const entry of normalized) {
        if (entry.taskId !== null && !ownedSet.has(entry.taskId)) {
          throw new HttpError(404, "day plan block task is not available");
        }
      }
      if (merged) {
        for (const taskId of merged.priorityTaskIds) {
          if (!ownedSet.has(taskId))
            throw new HttpError(404, "day plan priority task is not available");
        }
      }
      let fresh = 0;
      const blocks: DayPlanBlockDto[] = normalized.map((entry, index) => ({
        id: entry.id ?? `block-new-${fresh++}`,
        kind: entry.kind,
        taskId: entry.taskId,
        title: entry.title,
        position: index,
        actualPlacement: null,
        pendingChange: entry.pendingChange
      }));
      stored = {
        ...stored,
        revision: stored.revision + 1,
        eveningIntent: merged ?? emptyEveningIntent(),
        blocks
      };
      return stored;
    }
  );
  const repository = { getById, saveDraft } as unknown as DayPlanRepository;
  return { repository, getById, saveDraft, read: () => stored };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error.statusCode;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("calendar.dayPlanDraft", () => {
  it("saves an intent patch plus an untimed addition and reports saved for review", async () => {
    const { repository, saveDraft, read } = fakeRepository(storedPlan());
    const execute = createDayPlanDraftExecute(repository);
    const result = await execute(
      scopedDb,
      {
        planId: PLAN_ID,
        expectedRevision: 4,
        eveningIntent: { capacity: "full", notes: "Leave by four" },
        additions: [{ taskId: TASK_B }]
      },
      ctx()
    );
    expect(saveDraft).toHaveBeenCalledTimes(1);
    const message = String(result.data.message ?? "");
    expect(message).toContain("saved for review");
    expect(message).not.toContain("on the calendar");
    expect(result.data.revision).toBe(5);
    const saved = read();
    expect(saved.eveningIntent?.capacity).toBe("full");
    expect(saved.eveningIntent?.notes).toBe("Leave by four");
    const added = saved.blocks.find((entry) => entry.taskId === TASK_B);
    expect(added).toBeDefined();
    expect(added?.pendingChange).toBeNull();
    expect(added?.actualPlacement).toBeNull();
    expect(saved.blocks.find((entry) => entry.taskId === TASK_A)?.id).toBe("block-a");
  });

  it("keeps omitted intent fields and clears the intent on explicit null", async () => {
    const { repository, read } = fakeRepository(storedPlan());
    const execute = createDayPlanDraftExecute(repository);
    await execute(
      scopedDb,
      { planId: PLAN_ID, expectedRevision: 4, eveningIntent: { notes: "New note" } },
      ctx()
    );
    expect(read().eveningIntent?.capacity).toBe("light");
    expect(read().eveningIntent?.notes).toBe("New note");
    await execute(scopedDb, { planId: PLAN_ID, expectedRevision: 5, eveningIntent: null }, ctx());
    expect(read().eveningIntent).toEqual(emptyEveningIntent());
  });

  it("refuses an addition for a task that already has a block, without writing", async () => {
    const { repository, saveDraft } = fakeRepository(storedPlan());
    const execute = createDayPlanDraftExecute(repository);
    const status = await statusOf(
      execute(
        scopedDb,
        { planId: PLAN_ID, expectedRevision: 4, additions: [{ taskId: TASK_A }] },
        ctx()
      )
    );
    expect(status).toBe(400);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("rejects times, moves, removals and placement in the input", async () => {
    const cases: Record<string, unknown>[] = [
      {
        planId: PLAN_ID,
        expectedRevision: 4,
        additions: [{ taskId: TASK_B, startsAt: "2026-09-12T16:00:00.000Z" }]
      },
      {
        planId: PLAN_ID,
        expectedRevision: 4,
        additions: [
          {
            taskId: TASK_B,
            pendingChange: {
              kind: "add",
              startsAt: "2026-09-12T16:00:00.000Z",
              durationMinutes: 30
            }
          }
        ]
      },
      { planId: PLAN_ID, expectedRevision: 4, pendingChange: { kind: "remove" } },
      { planId: PLAN_ID, expectedRevision: 4, blocks: [] },
      { planId: PLAN_ID, expectedRevision: 4, additions: [{ taskId: TASK_B, durationMinutes: 30 }] }
    ];
    for (const input of cases) {
      const { repository, saveDraft } = fakeRepository(storedPlan());
      const status = await statusOf(createDayPlanDraftExecute(repository)(scopedDb, input, ctx()));
      expect(status).toBe(400);
      expect(saveDraft).not.toHaveBeenCalled();
    }
  });

  it("returns not found for a foreign plan id", async () => {
    const { repository, saveDraft } = fakeRepository(storedPlan());
    const status = await statusOf(
      createDayPlanDraftExecute(repository)(
        scopedDb,
        { planId: "plan-elsewhere", expectedRevision: 1 },
        ctx()
      )
    );
    expect(status).toBe(404);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("returns the draft conflict on a stale revision without writing", async () => {
    const { repository, read } = fakeRepository(storedPlan());
    const before = read().revision;
    const status = await statusOf(
      createDayPlanDraftExecute(repository)(
        scopedDb,
        { planId: PLAN_ID, expectedRevision: before - 1, eveningIntent: { capacity: "full" } },
        ctx()
      )
    );
    expect(status).toBe(409);
    expect(read().revision).toBe(before);
  });

  it("rejects a plan outside the actor's current or next local day", async () => {
    const { repository, saveDraft } = fakeRepository(storedPlan({ localDay: "2020-01-01" }));
    const status = await statusOf(
      createDayPlanDraftExecute(repository)(
        scopedDb,
        { planId: PLAN_ID, expectedRevision: 4 },
        ctx()
      )
    );
    expect(status).toBe(400);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("validates every task id against the actor's tasks", async () => {
    const { repository, read } = fakeRepository(storedPlan());
    const before = read().revision;
    const status = await statusOf(
      createDayPlanDraftExecute(repository)(
        scopedDb,
        {
          planId: PLAN_ID,
          expectedRevision: 4,
          eveningIntent: { priorityTaskIds: [FOREIGN_TASK] }
        },
        ctx()
      )
    );
    expect(status).toBe(404);
    expect(read().revision).toBe(before);
  });

  it("registers under the calendar module's tool naming", () => {
    expect(DAY_PLAN_DRAFT_TOOL_NAME).toBe("calendar.dayPlanDraft");
    const entry = (calendarModuleManifest.assistantTools ?? []).find(
      (tool) => tool.name === "calendar.dayPlanDraft"
    );
    expect(entry).toBeDefined();
    expect(entry?.permissionId).toBe("calendar.manage");
    expect(typeof entry?.execute).toBe("function");
  });

  it("has no code path to preview, apply, confirm or retry", async () => {
    const source = await readFile(
      new URL("../../packages/calendar/src/day-plan-chat-tool.ts", import.meta.url),
      "utf8"
    );
    for (const forbidden of [
      "day-plan-apply",
      "day-plan-execute",
      "day-plan-routes",
      "day-plan-change",
      "calendar-write-service",
      "requiresServices"
    ]) {
      expect(source, `expected no reference to ${forbidden}`).not.toContain(forbidden);
    }
    expect(source).not.toContain("on the calendar");
  });
});
