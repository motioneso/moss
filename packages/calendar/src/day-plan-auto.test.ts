import { describe, expect, it, vi } from "vitest";

import { HttpError } from "@moss/module-sdk";
import type { DataContextDb } from "@moss/db";

import { dayPlanAutoBatchKey, dayPlanAutoBlockId, reserveAutoPlanBlocks } from "./day-plan-auto.js";

const scopedDb = {} as DataContextDb;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

function stubRepository(
  overrides: {
    readonly reserveApplyBatch?: (
      scopedDb: unknown,
      input: Record<string, unknown>
    ) => Promise<{ id: string }>;
  } = {}
) {
  return {
    getForDay: async () => undefined,
    createForDay: async (db: unknown, input: Record<string, unknown>) => ({
      id: "plan-1",
      localDay: input["localDay"],
      timeZone: input["timeZone"],
      revision: 1,
      sourceRunId: null,
      blocks: [],
      eveningIntent: null
    }),
    appendBlocks: async (
      db: unknown,
      input: {
        planId: string;
        blocks: { id?: string; kind: string; taskId: string | null; title: string | null }[];
      }
    ) => ({
      id: input.planId,
      localDay: "2026-09-14",
      timeZone: "America/Los_Angeles",
      revision: 2,
      sourceRunId: null,
      blocks: input.blocks.map((block, index) => ({
        id: block.id ?? `block-${index}`,
        kind: "focus",
        taskId: block.taskId,
        title: block.title,
        position: index,
        actualPlacement: null,
        pendingChange: null
      })),
      eveningIntent: null
    }),
    reserveApplyBatch: async (_scopedDb: unknown, _input: Record<string, unknown>) => ({
      id: "operation-1"
    }),
    ...overrides
  } as unknown as Parameters<typeof reserveAutoPlanBlocks>[0];
}

const SIGNAL = {
  type: "prep_needed",
  summary: "Prep for planning",
  suggestedActions: ["create_task", "block_time"],
  startsAt: "2026-09-14T16:00:00.000Z",
  endsAt: "2026-09-14T17:00:00.000Z",
  followThrough: {
    targetRef: "calendar:prep_needed:abc",
    taskId: "task-1",
    intents: [
      { kind: "create_task", targetRef: "calendar:prep_needed:abc", title: "Prep for planning" },
      {
        kind: "block_time",
        targetRef: "calendar:prep_needed:abc",
        title: "Prep for planning",
        window: {
          start: "2026-09-14T15:00:00.000Z",
          end: "2026-09-14T16:00:00.000Z",
          durationMinutes: 60
        }
      }
    ]
  }
} as const;

describe("day-plan auto effects", () => {
  it("keys batches by run and ids blocks deterministically", () => {
    expect(dayPlanAutoBatchKey("run-1")).toBe("day-plan-auto:run-1");
    const first = dayPlanAutoBlockId("def-1", "2026-09-14", "calendar:prep_needed:abc");
    expect(first).toMatch(UUID_RE);
    expect(dayPlanAutoBlockId("def-1", "2026-09-14", "calendar:prep_needed:abc")).toBe(first);
    expect(dayPlanAutoBlockId("def-1", "2026-09-14", "other")).not.toBe(first);
  });

  it("returns null when no signal carries an automatic effect", async () => {
    const reserveApplyBatch = vi.fn(
      async (_scopedDb: unknown, _input: Record<string, unknown>) => ({ id: "operation-1" })
    );
    const repository = stubRepository({ reserveApplyBatch });
    const result = await reserveAutoPlanBlocks(repository, scopedDb, {
      runId: "run-1",
      definitionId: "def-1",
      localDay: "2026-09-14",
      timeZone: "America/Los_Angeles",
      signals: [
        { summary: "Off", suggestedActions: [] },
        { summary: "Suggest", suggestedActions: ["suggest_task"] }
      ]
    });
    expect(result).toBeNull();
    expect(repository.reserveApplyBatch).not.toHaveBeenCalled();
  });

  it("reserves the new blocks by selected id", async () => {
    const reserveApplyBatch = vi.fn(
      async (_scopedDb: unknown, _input: Record<string, unknown>) => ({ id: "operation-1" })
    );
    const repository = stubRepository({ reserveApplyBatch });
    const result = await reserveAutoPlanBlocks(repository, scopedDb, {
      runId: "run-1",
      definitionId: "def-1",
      localDay: "2026-09-14",
      timeZone: "America/Los_Angeles",
      signals: [{ ...SIGNAL }]
    });
    expect(result?.operationId).toBe("operation-1");
    expect(result?.batchKey).toBe("day-plan-auto:run-1");
    expect(result?.autoBlockIds).toHaveLength(1);
    expect(reserveApplyBatch).toHaveBeenCalledOnce();
    expect(reserveApplyBatch.mock.calls[0]?.[1]).toMatchObject({
      expectedRevision: 2,
      idempotencyKey: "day-plan-auto:run-1",
      selectedBlockIds: result?.autoBlockIds
    });
  });

  it("appends suggest proposals with no reservation", async () => {
    const reserveApplyBatch = vi.fn();
    const repository = stubRepository({ reserveApplyBatch });
    const result = await reserveAutoPlanBlocks(repository, scopedDb, {
      runId: "run-1",
      definitionId: "def-1",
      localDay: "2026-09-14",
      timeZone: "America/Los_Angeles",
      signals: [
        {
          type: "travel_transition_pressure",
          summary: "Buffer",
          suggestedActions: ["suggest_time_block"],
          startsAt: "2026-09-14T16:00:00.000Z",
          endsAt: "2026-09-14T17:00:00.000Z"
        }
      ]
    });
    expect(result?.operationId).toBeNull();
    expect(result?.suggestBlockIds).toHaveLength(1);
    expect(reserveApplyBatch).not.toHaveBeenCalled();
  });

  it("marks a revision race without throwing", async () => {
    const repository = stubRepository({
      reserveApplyBatch: async () => {
        throw new HttpError(409, "day plan changed since it was read");
      }
    });
    const result = await reserveAutoPlanBlocks(repository, scopedDb, {
      runId: "run-1",
      definitionId: "def-1",
      localDay: "2026-09-14",
      timeZone: "America/Los_Angeles",
      signals: [{ ...SIGNAL }]
    });
    expect(result?.operationId).toBeNull();
    expect(result?.revisionRace).toBe(true);
  });
});
