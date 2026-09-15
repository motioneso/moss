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

  it("links one legacy event as a placed block with no reservation", async () => {
    const reserveApplyBatch = vi.fn();
    const appendBlocks = vi.fn(
      async (
        _db: unknown,
        input: {
          blocks: {
            id?: string;
            pendingChange?: unknown;
            actualPlacement?: unknown;
          }[];
        }
      ) => ({
        id: input.blocks.length > 0 ? "plan-1" : "plan-1",
        localDay: "2026-09-14",
        timeZone: "America/Los_Angeles",
        revision: 2,
        sourceRunId: null,
        blocks: []
      })
    );
    const repository = stubRepository({ reserveApplyBatch });
    (repository as Record<string, unknown>).appendBlocks = appendBlocks;
    const result = await reserveAutoPlanBlocks(
      repository,
      scopedDb,
      {
        runId: "run-1",
        definitionId: "def-1",
        localDay: "2026-09-14",
        timeZone: "America/Los_Angeles",
        signals: [{ ...SIGNAL }]
      },
      {
        calendar: {
          listFollowThroughEvents: async () =>
            [
              {
                id: "cache-1",
                external_id: "google-evt-1",
                starts_at: "2026-09-14T15:00:00.000Z",
                ends_at: "2026-09-14T16:00:00.000Z",
                external_metadata: {
                  jarvisCreated: true,
                  followThroughTargetRef: "calendar:prep_needed:abc"
                }
              }
            ] as never
        }
      }
    );
    expect(result?.operationId).toBeNull();
    expect(result?.autoBlockIds).toHaveLength(0);
    expect(reserveApplyBatch).not.toHaveBeenCalled();
    expect(appendBlocks).toHaveBeenCalledOnce();
    const blocks = (appendBlocks.mock.calls[0]?.[1].blocks ?? []) as {
      pendingChange?: unknown;
      actualPlacement?: unknown;
    }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.pendingChange).toBeUndefined();
    expect(blocks[0]?.actualPlacement).toMatchObject({
      startsAt: "2026-09-14T15:00:00.000Z",
      durationMinutes: 60,
      calendarEventRef: "google-evt-1"
    });
  });

  it("ambiguous legacy events drop that target and log the count", async () => {
    const logged: unknown[] = [];
    const reserveApplyBatch = vi.fn(
      async (_scopedDb: unknown, _input: Record<string, unknown>) => ({ id: "operation-1" })
    );
    const repository = stubRepository({ reserveApplyBatch });
    const result = await reserveAutoPlanBlocks(
      repository,
      scopedDb,
      {
        runId: "run-1",
        definitionId: "def-1",
        localDay: "2026-09-14",
        timeZone: "America/Los_Angeles",
        signals: [{ ...SIGNAL }]
      },
      {
        calendar: {
          listFollowThroughEvents: async () =>
            [
              { id: "cache-1", external_id: "google-evt-1" },
              { id: "cache-2", external_id: "google-evt-2" }
            ] as never
        },
        logger: { warn: (event: unknown) => void logged.push(event) }
      }
    );
    expect(result?.operationId).toBeNull();
    expect(result?.autoBlockIds).toHaveLength(0);
    expect(reserveApplyBatch).not.toHaveBeenCalled();
    expect(logged).toEqual([{ event: "day_plan_auto_legacy_ambiguous", count: 2 }]);
  });

  it("links a referenced suggest block as placed with no reservation", async () => {
    const reserveApplyBatch = vi.fn();
    const appendBlocks = vi.fn(async (_db: unknown, input: { blocks: unknown[] }) => ({
      id: "plan-1",
      localDay: "2026-09-14",
      timeZone: "America/Los_Angeles",
      revision: 2,
      sourceRunId: null,
      blocks: []
    }));
    const repository = stubRepository({ reserveApplyBatch });
    (repository as Record<string, unknown>).appendBlocks = appendBlocks;
    const result = await reserveAutoPlanBlocks(
      repository,
      scopedDb,
      {
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
            endsAt: "2026-09-14T17:00:00.000Z",
            followThrough: { targetRef: "calendar:travel:abc" }
          }
        ]
      },
      {
        calendar: {
          listFollowThroughEvents: async () =>
            [
              {
                id: "cache-1",
                external_id: "google-evt-9",
                starts_at: "2026-09-14T16:00:00.000Z",
                ends_at: "2026-09-14T16:30:00.000Z",
                external_metadata: {
                  jarvisCreated: true,
                  followThroughTargetRef: "calendar:travel:abc"
                }
              }
            ] as never
        }
      }
    );
    expect(result?.operationId).toBeNull();
    expect(result?.suggestBlockIds).toHaveLength(0);
    expect(reserveApplyBatch).not.toHaveBeenCalled();
    const blocks = appendBlocks.mock.calls[0]?.[1].blocks as { actualPlacement?: unknown }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.actualPlacement).toMatchObject({ calendarEventRef: "google-evt-9" });
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
