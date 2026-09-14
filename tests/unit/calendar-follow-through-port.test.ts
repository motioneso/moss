import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { buildCalendarFollowThroughPort } from "@moss/module-registry";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;

const ACTOR = "00000000-0000-0000-0000-000000000001";

describe("Calendar follow-through port", () => {
  it("emits a block_time intent with no provider call", async () => {
    const port = buildCalendarFollowThroughPort({
      tasksRepository: {
        create: async () => {
          throw new Error("must not create a task for a pure time block");
        }
      }
    });

    const refs = await port.executeAutoActions({
      scopedDb,
      actorUserId: ACTOR,
      requestId: "req",
      targetRef: "calendar:prep:1",
      signal: {
        summary: "Prep",
        suggestedActions: ["block_time"],
        startsAt: "2026-07-04T16:00:00.000Z",
        endsAt: "2026-07-04T17:00:00.000Z"
      }
    });

    expect(refs.targetRef).toBe("calendar:prep:1");
    expect(refs.taskId).toBeUndefined();
    expect(refs.intents).toHaveLength(1);
    expect(refs.intents[0]).toMatchObject({ kind: "block_time", targetRef: "calendar:prep:1" });
  });

  it("creates the task through the Tasks port and emits both intents", async () => {
    const port = buildCalendarFollowThroughPort({
      tasksRepository: {
        create: async () => ({ id: "task-1" }) as never
      }
    });

    const refs = await port.executeAutoActions({
      scopedDb,
      actorUserId: ACTOR,
      requestId: "req",
      targetRef: "calendar:prep:2",
      signal: {
        summary: "Prep",
        suggestedActions: ["create_task", "block_time"],
        startsAt: "2026-07-04T16:00:00.000Z",
        endsAt: "2026-07-04T17:00:00.000Z"
      }
    });

    expect(refs.taskId).toBe("task-1");
    expect(refs.intents.map((intent) => intent.kind).sort()).toEqual(["block_time", "create_task"]);
  });

  it("emits no intent when the window is missing", async () => {
    const port = buildCalendarFollowThroughPort({
      tasksRepository: {
        create: async () => {
          throw new Error("must not create a task here");
        }
      }
    });

    const refs = await port.executeAutoActions({
      scopedDb,
      actorUserId: ACTOR,
      requestId: "req",
      targetRef: "calendar:prep:3",
      signal: { summary: "Prep", suggestedActions: ["block_time"] }
    });

    expect(refs.intents).toEqual([]);
  });
});
